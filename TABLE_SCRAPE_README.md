# Table Scrape (calibrated grid lines) — Feature README

A self-contained guide to the **/table-scrape** feature: upload a PDF (or photo), auto-detect the table's column/row separator lines, let the user drag-calibrate them once, then apply that one grid to **every page** and export the whole document to Excel.

This document contains the complete code and explains how each part works so the feature can be ported to another project.

Verified working end-to-end on 2026-07-17 (upload → detect → scrape all pages → Excel download, 2-page test PDF).

---

## 1. How it works — the big picture

```
┌──────────┐  POST /api/utility/process   ┌───────────────────────────────┐
│ Frontend │ ───────────────────────────► │ Store PDF in a session store  │
│  (React) │  ◄── { session_id, pages }   │ (images are wrapped into PDF) │
└──────────┘                              └───────────────────────────────┘
     │
     │  GET /api/table/detect/{sid}/{page}
     │  ◄── { width, height, columns:[x…], rows:[y…], word_count }
     │      (auto-detected separator lines, in page-PNG pixel space)
     │
     │  GET /api/utility/page/{sid}/{page}   ← the page rendered as PNG @150 DPI
     │      (frontend overlays draggable lines on this image)
     │
     │  user drags / adds / double-click-deletes lines
     │
     │  POST /api/table/scrape-all/{sid}  { columns, rows, ref_width, ref_height }
     │  ◄── { rows: [[page, cell, cell…]…], page_count }
     │
     │  POST /api/table/excel-all/{sid}   (same body + first_row_header)
     │  ◄── .xlsx bytes  (+ X-Table-Rows / X-Table-Pages headers)
```

### The three core ideas

**1. One shared pixel coordinate space.**
Everything — the PNG the user sees, the detected lines, the dragged lines, the scrape — uses pixels of the page rendered at **150 DPI** (`_SCALE = 150/72` on top of PDF points). Because the overlay and the image come from the same rendering, the lines align 1:1 with the picture. The frontend only applies a single uniform display scale (`scale = displayWidth / naturalWidth`) and divides it back out on drag. **If you change the render DPI you must change it in both `get_page_image` and `table_calibrate.py` — they must match.**

**2. Word boxes, not raster analysis.**
Detection and scraping never look at pixels. They work on **word bounding boxes**:
- If the PDF has a native text layer → `page.get_text("words")` from PyMuPDF (fast, exact).
- If not (scanned page / photo) → OCR the page rendered at 2× and divide the coordinates by 2. OCR is optional; with no engine the user still gets an empty grid and can place lines manually.

**3. Lines are just sorted 1-D cut positions.**
A "grid" is nothing more than `columns: number[]` (x cuts) and `rows: number[]` (y cuts). Scraping buckets each word by its **center point** into the cell between two cuts, then joins words per cell left-to-right. Because the grid is so simple, applying it to every page is trivial — for pages of a different size the cuts are scaled proportionally (`x * page_w / ref_w`).

### Detection algorithms (both intentionally simple — the user calibrates anyway)

- **Columns — whitespace-gap analysis.** Build a boolean coverage array of width `width_px`; mark every x range covered by any word. Any uncovered gap wider than `max(1.2 × median_word_height, 14px)` (excluding the leading/trailing page margins) gets a separator at its midpoint. Rationale: a real column gutter is wider than an inter-word space, and word height is a good proxy for font size.
- **Rows — line clustering.** Sort word vertical centers, cluster them greedily (new cluster when the jump exceeds `0.6 × median_word_height`), and put a separator at the midpoint between consecutive cluster centers.

### Multi-page semantics

The user calibrates on one page; the same cuts apply to all pages. The preview (`scrape-all`) prefixes each row with its page number. The Excel export writes the header row once (taken from the first page's first row) and **skips the first row of every subsequent page** when "first row = header" is on — because a repeating table usually repeats its header on each page.

---

## 2. Backend

### 2.1 Dependencies

```
pip install fastapi uvicorn pymupdf numpy openpyxl pillow
# optional, only for scanned PDFs / photos:
pip install rapidocr-onnxruntime   # or any OCR with a .ocr(img, cls=True) API
```

### 2.2 `table_calibrate.py` — the feature router (complete, verbatim)

```python
"""Interactive table calibration.

Flow used by the frontend /table-scrape page:

  1. Upload a PDF or image via the normal /api/utility/process endpoint.
  2. GET  /api/table/detect/{session_id}/{page}
        → returns the page's pixel size plus the auto-detected column and
          row separator lines (in the SAME pixel space as the /page PNG).
  3. The user drags / adds / deletes those lines.
  4. POST /api/table/scrape/{session_id}/{page}   { columns:[x], rows:[y] }
        → returns the table (list of rows) bucketed by the user's lines.
  5. POST /api/table/excel/{session_id}/{page}    { columns:[x], rows:[y] }
        → returns the same table as an .xlsx download.

Coordinates everywhere are pixels of the page rendered at RENDER_DPI (150),
which is exactly what GET /api/utility/page/{session_id}/{page} serves, so
the frontend overlay lines up 1:1 with the displayed image.
"""

import io

import fitz
import numpy as np
from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse, Response

from pdf_store import store
from ocr_lazy import get_ocr_engine

router = APIRouter()

RENDER_DPI = 150
_SCALE = RENDER_DPI / 72.0


# ---------------------------------------------------------------------------
# Word extraction (native text layer if present, else OCR) in pixel space
# ---------------------------------------------------------------------------

def _page_words_px(pdf_doc, page_idx: int):
    """Return (words, width_px, height_px).

    words: list of {text, x0, y0, x1, y1} in pixels of the RENDER_DPI image.
    Prefers the native text layer; falls back to OCR of the rendered page.
    """
    page = pdf_doc.doc[page_idx]
    rect = page.rect
    width_px = int(round(rect.width * _SCALE))
    height_px = int(round(rect.height * _SCALE))

    words = []
    try:
        native = page.get_text("words") or []
    except Exception:
        native = []
    # get_text("words") → (x0, y0, x1, y1, "word", block, line, word_no)
    for w in native:
        text = (w[4] or "").strip()
        if not text:
            continue
        words.append({
            "text": text,
            "x0": w[0] * _SCALE, "y0": w[1] * _SCALE,
            "x1": w[2] * _SCALE, "y1": w[3] * _SCALE,
        })

    if words:
        return words, width_px, height_px

    # No native text → OCR the rendered page (2x upscale helps small text).
    engine = get_ocr_engine()
    if engine is None:
        return [], width_px, height_px
    mat = fitz.Matrix(_SCALE * 2, _SCALE * 2)  # render at 2x for OCR accuracy
    pix = page.get_pixmap(matrix=mat)
    try:
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
        if pix.n == 4:
            img = img[:, :, :3]
        img = np.ascontiguousarray(img)
        res = engine.ocr(img, cls=True)
    finally:
        pix = None
    if res and res[0]:
        for box, (text, _score) in res[0]:
            t = (text or "").strip()
            if not t:
                continue
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            # divide by 2 to map the 2x-OCR coords back to RENDER_DPI space
            words.append({
                "text": t,
                "x0": min(xs) / 2, "y0": min(ys) / 2,
                "x1": max(xs) / 2, "y1": max(ys) / 2,
            })
    return words, width_px, height_px


# ---------------------------------------------------------------------------
# Auto-detection of column / row separator lines
# ---------------------------------------------------------------------------

def _detect_columns(words, width_px):
    """Find vertical separator x-positions via whitespace-gap analysis.

    Marks every x column covered by any word, then places a separator in the
    middle of each sufficiently wide uncovered gap.
    """
    if not words or width_px <= 0:
        return []
    cover = np.zeros(width_px + 1, dtype=bool)
    heights = []
    for w in words:
        x0 = max(0, int(w["x0"]))
        x1 = min(width_px, int(w["x1"]))
        if x1 > x0:
            cover[x0:x1] = True
        heights.append(w["y1"] - w["y0"])
    med_h = float(np.median(heights)) if heights else 12.0
    # A real column gap is wider than an inter-word space. Use ~1.2x the text
    # height as the whitespace threshold (tunable, and the user calibrates).
    gap_min = max(med_h * 1.2, 14)

    seps = []
    x = 0
    # skip the leading margin
    while x < width_px and not cover[x]:
        x += 1
    while x < width_px:
        if not cover[x]:
            start = x
            while x < width_px and not cover[x]:
                x += 1
            end = x
            # ignore the trailing margin (gap that runs to the edge)
            if end < width_px and (end - start) >= gap_min:
                seps.append(int((start + end) / 2))
        else:
            x += 1
    return seps


def _detect_rows(words, height_px):
    """Cluster words into text lines; separator = midpoint between lines."""
    if not words:
        return []
    heights = [w["y1"] - w["y0"] for w in words]
    med_h = float(np.median(heights)) if heights else 12.0
    tol = med_h * 0.6
    centers = sorted(((w["y0"] + w["y1"]) / 2) for w in words)
    lines = []
    cur = [centers[0]]
    for c in centers[1:]:
        if c - cur[-1] <= tol:
            cur.append(c)
        else:
            lines.append(sum(cur) / len(cur))
            cur = [c]
    lines.append(sum(cur) / len(cur))
    seps = [int((lines[i] + lines[i + 1]) / 2) for i in range(len(lines) - 1)]
    return seps


# ---------------------------------------------------------------------------
# Scrape given calibrated lines
# ---------------------------------------------------------------------------

def _scrape_with_lines(words, width_px, height_px, columns, rows):
    """Bucket words into a 2-D table using the given separator lines."""
    col_edges = [0] + sorted(int(c) for c in columns) + [width_px]
    row_edges = [0] + sorted(int(r) for r in rows) + [height_px]
    n_cols = len(col_edges) - 1
    n_rows = len(row_edges) - 1
    grid = [[[] for _ in range(n_cols)] for _ in range(n_rows)]

    def _bucket(edges, v):
        for i in range(len(edges) - 1):
            if edges[i] <= v < edges[i + 1]:
                return i
        return len(edges) - 2  # clamp into last cell

    for w in words:
        cx = (w["x0"] + w["x1"]) / 2
        cy = (w["y0"] + w["y1"]) / 2
        ci = _bucket(col_edges, cx)
        ri = _bucket(row_edges, cy)
        grid[ri][ci].append((w["x0"], w["text"]))

    table = []
    for r in range(n_rows):
        row_out = []
        for c in range(n_cols):
            parts = [t for _, t in sorted(grid[r][c], key=lambda p: p[0])]
            row_out.append(" ".join(parts).strip())
        if any(cell for cell in row_out):
            table.append(row_out)
    return table


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/api/table/detect/{session_id}/{page}")
def detect_lines(session_id: str, page: int):
    pdf_doc = store.get(session_id)
    if not pdf_doc:
        return JSONResponse(status_code=404, content={"error": "Session not found. Re-upload."})
    if page < 1 or page > pdf_doc.page_count:
        return JSONResponse(status_code=400, content={"error": f"Invalid page. PDF has {pdf_doc.page_count} pages."})

    words, w_px, h_px = _page_words_px(pdf_doc, page - 1)
    columns = _detect_columns(words, w_px)
    rows = _detect_rows(words, h_px)
    return {
        "width": w_px,
        "height": h_px,
        "columns": columns,
        "rows": rows,
        "word_count": len(words),
    }


@router.post("/api/table/scrape/{session_id}/{page}")
def scrape_lines(session_id: str, page: int, body: dict = Body(...)):
    pdf_doc = store.get(session_id)
    if not pdf_doc:
        return JSONResponse(status_code=404, content={"error": "Session not found. Re-upload."})
    if page < 1 or page > pdf_doc.page_count:
        return JSONResponse(status_code=400, content={"error": f"Invalid page. PDF has {pdf_doc.page_count} pages."})

    words, w_px, h_px = _page_words_px(pdf_doc, page - 1)
    columns = body.get("columns", []) or []
    rows = body.get("rows", []) or []
    table = _scrape_with_lines(words, w_px, h_px, columns, rows)
    return {"rows": table, "n_cols": (len(columns) + 1), "n_rows": len(table)}


@router.post("/api/table/excel/{session_id}/{page}")
def scrape_excel(session_id: str, page: int, body: dict = Body(...)):
    pdf_doc = store.get(session_id)
    if not pdf_doc:
        return JSONResponse(status_code=404, content={"error": "Session not found. Re-upload."})
    if page < 1 or page > pdf_doc.page_count:
        return JSONResponse(status_code=400, content={"error": f"Invalid page. PDF has {pdf_doc.page_count} pages."})

    import openpyxl

    words, w_px, h_px = _page_words_px(pdf_doc, page - 1)
    columns = body.get("columns", []) or []
    rows = body.get("rows", []) or []
    first_row_header = bool(body.get("first_row_header", False))
    table = _scrape_with_lines(words, w_px, h_px, columns, rows)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Table"
    if first_row_header and table:
        from openpyxl.styles import Font
        ws.append(table[0])
        for cell in ws[1]:
            cell.font = Font(bold=True)
        for r in table[1:]:
            ws.append(r)
    else:
        for r in table:
            ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)

    base = (pdf_doc.filename or session_id).rsplit(".", 1)[0]
    fname = f"{base}_table.xlsx"
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# ---------------------------------------------------------------------------
# All-pages: apply ONE set of calibrated lines to every page of the PDF
# ---------------------------------------------------------------------------

def _scaled_lines(columns, rows, ref_w, ref_h, page_w, page_h):
    """Scale the calibrated lines (defined in the reference page's pixel space)
    into a target page's pixel space. For a uniform-size PDF this is a no-op;
    for pages of differing size it keeps the grid proportional."""
    sx = (page_w / ref_w) if ref_w else 1.0
    sy = (page_h / ref_h) if ref_h else 1.0
    return [c * sx for c in columns], [r * sy for r in rows]


def _scrape_all_pages(pdf_doc, columns, rows, ref_w, ref_h):
    """Scrape every page with the same (scaled) calibrated lines.
    Returns list of (page_number, table_rows)."""
    out = []
    for i in range(pdf_doc.page_count):
        words, w_px, h_px = _page_words_px(pdf_doc, i)
        cols_i, rows_i = _scaled_lines(columns, rows, ref_w or w_px, ref_h or h_px, w_px, h_px)
        table = _scrape_with_lines(words, w_px, h_px, cols_i, rows_i)
        out.append((i + 1, table))
    return out


@router.post("/api/table/scrape-all/{session_id}")
def scrape_all(session_id: str, body: dict = Body(...)):
    """Preview: scrape every page with the calibrated lines. Returns rows with
    a leading page number so the frontend can show the whole-PDF result."""
    pdf_doc = store.get(session_id)
    if not pdf_doc:
        return JSONResponse(status_code=404, content={"error": "Session not found. Re-upload."})
    columns = body.get("columns", []) or []
    rows = body.get("rows", []) or []
    ref_w = float(body.get("ref_width") or 0)
    ref_h = float(body.get("ref_height") or 0)

    pages = _scrape_all_pages(pdf_doc, columns, rows, ref_w, ref_h)
    combined = []
    for page_no, table in pages:
        for r in table:
            combined.append([str(page_no)] + r)
    return {
        "rows": combined,
        "n_cols": len(columns) + 2,     # page col + data cols
        "n_rows": len(combined),
        "page_count": pdf_doc.page_count,
    }


@router.post("/api/table/excel-all/{session_id}")
def scrape_excel_all(session_id: str, body: dict = Body(...)):
    """Download the WHOLE PDF as one Excel: the calibrated lines are applied to
    every page and all rows are stacked with a leading Page column."""
    pdf_doc = store.get(session_id)
    if not pdf_doc:
        return JSONResponse(status_code=404, content={"error": "Session not found. Re-upload."})

    import openpyxl
    from openpyxl.styles import Font

    columns = body.get("columns", []) or []
    rows = body.get("rows", []) or []
    ref_w = float(body.get("ref_width") or 0)
    ref_h = float(body.get("ref_height") or 0)
    first_row_header = bool(body.get("first_row_header", False))

    pages = _scrape_all_pages(pdf_doc, columns, rows, ref_w, ref_h)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Table"

    header_written = False
    total = 0
    for page_no, table in pages:
        if not table:
            continue
        start = 0
        if first_row_header:
            if not header_written:
                ws.append(["Page"] + table[0])
                for cell in ws[ws.max_row]:
                    cell.font = Font(bold=True)
                header_written = True
            # On every page the first row is the repeated column header — skip it.
            start = 1
        for r in table[start:]:
            ws.append([str(page_no)] + r)
            total += 1

    if total == 0 and not header_written:
        ws.append(["Page", "(no rows found on any page)"])

    buf = io.BytesIO()
    wb.save(buf)

    # Name the Excel after the uploaded file (report.pdf -> report.xlsx).
    base = (pdf_doc.filename or session_id).rsplit(".", 1)[0]
    fname = f"{base}.xlsx"
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"',
            "X-Table-Rows": str(total),
            "X-Table-Pages": str(pdf_doc.page_count),
            "Access-Control-Expose-Headers": "X-Table-Rows,X-Table-Pages",
        },
    )
```

> Note the `Access-Control-Expose-Headers` on the Excel response — without it, browsers hide the custom `X-Table-Rows` / `X-Table-Pages` headers from cross-origin `fetch()` and the frontend toast shows `null` counts.

### 2.3 Supporting pieces the router depends on

The router imports two things from the host app: `store` (session storage) and `get_ocr_engine` (optional OCR). In this repo those are the full-featured [pdf_store.py](backend/pdf_store.py) (disk spill-over, LRU, TTL sweeper) and [ocr_lazy.py](backend/ocr_lazy.py) (lazy RapidOCR singleton). **For another project you only need these minimal versions:**

**`pdf_store.py` (minimal portable version):**

```python
"""Minimal in-memory session store for uploaded PDFs."""
import threading
import time
import uuid

import fitz  # PyMuPDF


class PDFDocument:
    def __init__(self, pdf_bytes: bytes, filename: str):
        self.filename = filename
        self.created_at = time.time()
        self.doc = fitz.open(stream=pdf_bytes, filetype="pdf")

    @property
    def page_count(self) -> int:
        return len(self.doc)

    def close(self):
        try:
            self.doc.close()
        except Exception:
            pass


class PDFStore:
    def __init__(self, ttl_sec: int = 4 * 60 * 60):
        self._docs: dict[str, PDFDocument] = {}
        self._lock = threading.Lock()
        self._ttl = ttl_sec

    def add(self, pdf_bytes: bytes, filename: str) -> str:
        sid = uuid.uuid4().hex
        with self._lock:
            # drop expired sessions
            now = time.time()
            for k in [k for k, d in self._docs.items() if now - d.created_at > self._ttl]:
                self._docs.pop(k).close()
            self._docs[sid] = PDFDocument(pdf_bytes, filename)
        return sid

    def get(self, session_id: str) -> PDFDocument | None:
        with self._lock:
            return self._docs.get(session_id)


store = PDFStore()
```

**`ocr_lazy.py` (minimal — return `None` if you don't need scanned-document support):**

```python
def get_ocr_engine():
    """Return an object with .ocr(np_image, cls=True) -> PaddleOCR-style results,
    or None. With None, scanned pages simply return zero words and the user
    places grid lines manually (the UI handles this)."""
    return None
```

If you do want OCR, return any engine whose `.ocr(img, cls=True)` yields `[[ (box_points, (text, score)), ... ]]` (the PaddleOCR result shape) — this repo uses a RapidOCR adapter with that interface.

**Upload + page-image endpoints (`main.py`):**

```python
import io

import fitz
from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from PIL import Image

from pdf_store import store
from table_calibrate import router as table_calibrate_router

app = FastAPI()
app.include_router(table_calibrate_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080"],   # your frontend origin(s)
    allow_methods=["*"],
    allow_headers=["*"],
)

IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp", ".gif")


def _image_bytes_to_pdf(data: bytes) -> bytes:
    """Wrap a raster image into a one-page PDF (Pillow does the heavy lifting)."""
    img = Image.open(io.BytesIO(data))
    if img.mode in ("RGBA", "P", "LA"):
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="PDF")
    return buf.getvalue()


@app.post("/api/utility/process")
async def process_pdf(file: UploadFile = File(...)):
    filename = file.filename or "document"
    data = await file.read()
    if not data:
        return JSONResponse(status_code=400, content={"error": "Uploaded file is empty."})

    low = filename.lower()
    if low.endswith(".pdf"):
        pdf_bytes = data
    elif low.endswith(IMAGE_EXTS):
        pdf_bytes = _image_bytes_to_pdf(data)
        filename = filename.rsplit(".", 1)[0] + ".pdf"
    else:
        return JSONResponse(status_code=400, content={"error": "Upload a PDF or image."})

    session_id = store.add(pdf_bytes, filename)
    return {"session_id": session_id, "total_pages": store.get(session_id).page_count}


@app.get("/api/utility/page/{session_id}/{page_num}")
def get_page_image(session_id: str, page_num: int):
    """Return a page as PNG. page_num is 1-based. MUST render at the same
    DPI (150) as table_calibrate.RENDER_DPI or the overlay misaligns."""
    pdf_doc = store.get(session_id)
    if not pdf_doc:
        return JSONResponse(status_code=404, content={"error": "Session not found. Re-upload."})
    if page_num < 1 or page_num > pdf_doc.page_count:
        return JSONResponse(status_code=400, content={"error": "Invalid page."})
    pix = pdf_doc.doc[page_num - 1].get_pixmap(dpi=150)
    return StreamingResponse(io.BytesIO(pix.tobytes("png")), media_type="image/png")
```

(The production version in this repo also converts DOC/DOCX via LibreOffice and spills large files to disk — see [backend/main.py](backend/main.py) and [backend/pdf_store.py](backend/pdf_store.py) — but none of that is required by the table-scrape feature.)

Run with: `uvicorn main:app --port 8000`

---

## 3. Frontend

### 3.1 Dependencies

React 18+, `lucide-react` (icons), `sonner` (toasts), Tailwind CSS. None are essential to the mechanism — swap toasts/icons/classes freely. The page expects `VITE_BACKEND_URL` (falls back to `http://localhost:8000`).

Route registration (react-router):

```tsx
import TableScrape from "./pages/TableScrape";
// inside <Routes>:
<Route path="/table-scrape" element={<TableScrape />} />
```

### 3.2 How the overlay works

- The page PNG is displayed at `scale = min(1100, naturalWidth) / naturalWidth`; all stored line positions stay in **natural (backend) pixels** and are multiplied by `scale` only for rendering.
- Each line is an absolutely-positioned 11px-wide invisible hit strip with a 1.5px visible line in the middle — the fat strip makes grabbing easy. `mousedown` on a strip sets the drag state; `mousemove` on the container converts the cursor position back to natural pixels (`(clientX - rect.left) / scale`, clamped to the page); `mouseup`/`mouseleave` end the drag. Double-click deletes a line.
- Column strips get `zIndex: 2`, row strips `zIndex: 1`, so columns win at intersections.
- Page navigation deliberately does **not** re-detect — the whole point is one grid for all pages. The "Auto-detect" button explicitly replaces the grid with the current page's detection.

### 3.3 `src/pages/TableScrape.tsx` (complete, verbatim)

```tsx
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Upload, Plus, Trash2, ScanLine, Download, Loader2, ChevronLeft, ChevronRight, Info } from 'lucide-react';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000';

type Detect = { width: number; height: number; columns: number[]; rows: number[]; word_count: number };
type DragState = { axis: 'col' | 'row'; index: number } | null;

const DISPLAY_MAX_W = 1100; // px the page image is scaled to on screen

export default function TableScrape() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [natural, setNatural] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [columns, setColumns] = useState<number[]>([]);
  const [rows, setRows] = useState<number[]>([]);
  const [uploading, setUploading] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [scraping, setScraping] = useState(false);
  const [table, setTable] = useState<string[][] | null>(null);
  const [srcName, setSrcName] = useState('table');   // uploaded file's base name
  const [firstRowHeader, setFirstRowHeader] = useState(true);
  const [drag, setDrag] = useState<DragState>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const scale = useMemo(() => (natural.w ? Math.min(DISPLAY_MAX_W, natural.w) / natural.w : 1), [natural.w]);
  const dispW = natural.w * scale;
  const dispH = natural.h * scale;
  const pageImgUrl = sessionId ? `${BACKEND_URL}/api/utility/page/${sessionId}/${page}` : '';

  const loadDetect = useCallback(async (sid: string, pg: number) => {
    setDetecting(true);
    setTable(null);
    try {
      const res = await fetch(`${BACKEND_URL}/api/table/detect/${sid}/${pg}`);
      if (!res.ok) { toast.error('Detection failed: ' + (await res.text()).slice(0, 120)); return; }
      const d: Detect = await res.json();
      setNatural({ w: d.width, h: d.height });
      setColumns(d.columns);
      setRows(d.rows);
      if (d.word_count === 0) toast('No text detected on this page — you can still add lines manually.', { icon: 'ℹ️' });
      else toast.success(`Detected ${d.columns.length + 1} columns × ${d.rows.length + 1} rows — drag to calibrate`);
    } catch (e: any) {
      toast.error('Detection error: ' + String(e).slice(0, 120));
    } finally {
      setDetecting(false);
    }
  }, []);

  const onFile = useCallback(async (file: File) => {
    setUploading(true);
    setTable(null); setColumns([]); setRows([]); setSessionId(null);
    setSrcName((file.name || 'table').replace(/\.[^.]+$/, '') || 'table');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${BACKEND_URL}/api/utility/process`, { method: 'POST', body: fd });
      if (!res.ok) { toast.error('Upload failed: ' + (await res.text()).slice(0, 160)); return; }
      const j = await res.json();
      setSessionId(j.session_id);
      setTotalPages(j.total_pages || 1);
      setPage(1);
      await loadDetect(j.session_id, 1);
    } catch (e: any) {
      toast.error('Upload error: ' + String(e).slice(0, 160));
    } finally {
      setUploading(false);
    }
  }, [loadDetect]);

  // Navigating pages keeps the SAME calibrated lines (they apply to every
  // page). We only change which page image is shown — no re-detect, no reset.
  const gotoPage = useCallback((pg: number) => {
    if (!sessionId || pg < 1 || pg > totalPages) return;
    setPage(pg);
  }, [sessionId, totalPages]);

  // Explicit re-detect for the current page (replaces the shared lines with
  // this page's auto-detected grid).
  const reDetect = useCallback(() => {
    if (sessionId) loadDetect(sessionId, page);
  }, [sessionId, page, loadDetect]);

  // ---- line dragging ----
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!drag || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    if (drag.axis === 'col') {
      const x = Math.max(0, Math.min(natural.w, (e.clientX - rect.left) / scale));
      setColumns(prev => prev.map((v, i) => (i === drag.index ? Math.round(x) : v)));
    } else {
      const y = Math.max(0, Math.min(natural.h, (e.clientY - rect.top) / scale));
      setRows(prev => prev.map((v, i) => (i === drag.index ? Math.round(y) : v)));
    }
  }, [drag, natural.w, natural.h, scale]);

  const endDrag = useCallback(() => setDrag(null), []);

  const addColumn = () => setColumns(prev => [...prev, Math.round(natural.w / 2)].sort((a, b) => a - b));
  const addRow = () => setRows(prev => [...prev, Math.round(natural.h / 2)].sort((a, b) => a - b));
  const delColumn = (i: number) => setColumns(prev => prev.filter((_, idx) => idx !== i));
  const delRow = (i: number) => setRows(prev => prev.filter((_, idx) => idx !== i));

  // Preview the WHOLE PDF: the calibrated lines are applied to every page and
  // all rows are stacked (first column = page number).
  const doScrape = useCallback(async () => {
    if (!sessionId) return;
    setScraping(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/table/scrape-all/${sessionId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columns, rows, ref_width: natural.w, ref_height: natural.h }),
      });
      if (!res.ok) { toast.error('Scrape failed: ' + (await res.text()).slice(0, 120)); return; }
      const j = await res.json();
      setTable(j.rows);
      toast.success(`Scraped ${j.rows.length} rows across ${j.page_count} page${j.page_count !== 1 ? 's' : ''}`);
    } catch (e: any) {
      toast.error('Scrape error: ' + String(e).slice(0, 120));
    } finally {
      setScraping(false);
    }
  }, [sessionId, columns, rows, natural.w, natural.h]);

  // Download the whole PDF (all pages) as one Excel with the same lines.
  const downloadExcel = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(`${BACKEND_URL}/api/table/excel-all/${sessionId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          columns, rows, ref_width: natural.w, ref_height: natural.h,
          first_row_header: firstRowHeader,
        }),
      });
      if (!res.ok) { toast.error('Excel failed'); return; }
      const nRows = res.headers.get('X-Table-Rows');
      const nPages = res.headers.get('X-Table-Pages');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${srcName}.xlsx`; a.click();   // same name as the uploaded PDF
      URL.revokeObjectURL(url);
      toast.success(`Excel downloaded — ${nRows} rows from ${nPages} page${nPages !== '1' ? 's' : ''}`);
    } catch (e: any) {
      toast.error('Excel error: ' + String(e).slice(0, 120));
    }
  }, [sessionId, columns, rows, natural.w, natural.h, firstRowHeader, srcName]);

  return (
    <div className="min-h-screen bg-background text-foreground p-5">
      <div className="max-w-[1400px] mx-auto space-y-4">
        <header className="flex items-center gap-3">
          <ScanLine className="w-6 h-6 text-primary" />
          <div>
            <h1 className="text-lg font-bold">Table Scrape (calibrate lines)</h1>
            <p className="text-xs text-muted-foreground">Upload a PDF or photo → adjust the grid lines once → they apply to every page → scrape the whole PDF.</p>
          </div>
          <a href="/" className="ml-auto text-xs text-primary underline">← Back to main</a>
        </header>

        {/* Upload */}
        <div className="flex items-center gap-3 flex-wrap">
          <label className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-primary/40 cursor-pointer hover:bg-primary/5 text-sm">
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            Upload PDF / image
            <input type="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.webp,.gif,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*"
                   className="hidden"
                   onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.currentTarget.value = ''; }} />
          </label>

          {sessionId && (
            <>
              <div className="inline-flex items-center gap-1 text-sm">
                <button type="button" aria-label="Previous page" title="Previous page" className="p-1.5 rounded hover:bg-muted disabled:opacity-40" disabled={page <= 1} onClick={() => gotoPage(page - 1)}><ChevronLeft className="w-4 h-4" /></button>
                <span className="tabular-nums">Page {page} / {totalPages}</span>
                <button type="button" aria-label="Next page" title="Next page" className="p-1.5 rounded hover:bg-muted disabled:opacity-40" disabled={page >= totalPages} onClick={() => gotoPage(page + 1)}><ChevronRight className="w-4 h-4" /></button>
              </div>
              <button type="button" onClick={addColumn} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs hover:bg-muted"><Plus className="w-3.5 h-3.5" /> Column line</button>
              <button type="button" onClick={addRow} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs hover:bg-muted"><Plus className="w-3.5 h-3.5" /> Row line</button>
              <button type="button" onClick={reDetect} disabled={detecting} title="Replace the lines with this page's auto-detected grid"
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs hover:bg-muted disabled:opacity-50"><ScanLine className="w-3.5 h-3.5" /> Auto-detect</button>
              <button type="button" onClick={doScrape} disabled={scraping || detecting}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
                {scraping ? <Loader2 className="w-4 h-4 animate-spin" /> : <ScanLine className="w-4 h-4" />} Scrape all pages
              </button>
              <label className="inline-flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={firstRowHeader} onChange={e => setFirstRowHeader(e.target.checked)} /> first row = header
              </label>
              <button type="button" onClick={downloadExcel} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm hover:bg-muted"><Download className="w-4 h-4" /> Excel (all pages)</button>
            </>
          )}
        </div>

        {sessionId && (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1">
            <Info className="w-3 h-3" /> Drag a line to move · double-click to delete · these lines apply to <b>every page</b>. Blue = columns, green = rows. Use ◀ ▶ to preview other pages; "Auto-detect" re-detects the current page.
          </p>
        )}

        {/* Image + line overlay */}
        {sessionId && natural.w > 0 && (
          <div className="overflow-auto border rounded-lg bg-muted/30">
            <div
              ref={wrapRef}
              className="relative select-none"
              style={{ width: dispW, height: dispH }}
              onMouseMove={onMouseMove}
              onMouseUp={endDrag}
              onMouseLeave={endDrag}
            >
              <img src={pageImgUrl} alt="page" draggable={false}
                   style={{ width: dispW, height: dispH, display: 'block' }} />
              {detecting && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/50 text-sm">
                  <Loader2 className="w-5 h-5 animate-spin mr-2" /> detecting…
                </div>
              )}
              {/* row lines (under columns, so columns win at intersections) */}
              {rows.map((y, i) => (
                <div key={'r' + i}
                     onMouseDown={e => { e.preventDefault(); setDrag({ axis: 'row', index: i }); }}
                     onDoubleClick={() => delRow(i)}
                     title="drag to move · double-click to delete"
                     style={{ position: 'absolute', top: y * scale - 5, left: 0, height: 11, width: dispW, cursor: 'ns-resize', zIndex: 1 }}>
                  <div style={{ position: 'absolute', top: 5, left: 0, height: 1.5, width: '100%', background: 'rgba(22,163,74,0.85)', pointerEvents: 'none' }} />
                </div>
              ))}
              {/* column lines (on top) */}
              {columns.map((x, i) => (
                <div key={'c' + i}
                     onMouseDown={e => { e.preventDefault(); setDrag({ axis: 'col', index: i }); }}
                     onDoubleClick={() => delColumn(i)}
                     title="drag to move · double-click to delete"
                     style={{ position: 'absolute', left: x * scale - 5, top: 0, width: 11, height: dispH, cursor: 'ew-resize', zIndex: 2 }}>
                  <div style={{ position: 'absolute', left: 5, top: 0, width: 1.5, height: '100%', background: 'rgba(37,99,235,0.9)', pointerEvents: 'none' }} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Result table */}
        {table && (
          <div className="space-y-2">
            <h2 className="text-sm font-semibold">Result — {table.length} rows across all pages (first column = page)</h2>
            <div className="overflow-auto border rounded-lg max-h-[420px]">
              <table className="text-xs border-collapse w-full">
                <tbody>
                  {table.map((r, ri) => (
                    <tr key={ri} className={firstRowHeader && ri === 0 ? 'bg-muted font-semibold' : ri % 2 ? 'bg-muted/30' : ''}>
                      {r.map((c, ci) => <td key={ci} className="border px-2 py-1 align-top whitespace-pre-wrap">{c}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!sessionId && !uploading && (
          <div className="text-sm text-muted-foreground border border-dashed rounded-lg p-8 text-center">
            Upload a PDF or photo to begin. The system will detect the table's grid and draw lines you can adjust.
          </div>
        )}
      </div>
    </div>
  );
}
```

---

## 4. API reference

| Endpoint | Method | Body | Returns |
|---|---|---|---|
| `/api/utility/process` | POST | multipart `file` | `{ session_id, total_pages }` |
| `/api/utility/page/{sid}/{page}` | GET | — | PNG of the page @150 DPI (1-based page) |
| `/api/table/detect/{sid}/{page}` | GET | — | `{ width, height, columns, rows, word_count }` |
| `/api/table/scrape/{sid}/{page}` | POST | `{ columns, rows }` | single-page `{ rows, n_cols, n_rows }` |
| `/api/table/excel/{sid}/{page}` | POST | `{ columns, rows, first_row_header }` | single-page .xlsx |
| `/api/table/scrape-all/{sid}` | POST | `{ columns, rows, ref_width, ref_height }` | `{ rows (page-prefixed), n_cols, n_rows, page_count }` |
| `/api/table/excel-all/{sid}` | POST | same + `first_row_header` | whole-PDF .xlsx, headers `X-Table-Rows`, `X-Table-Pages` |

`columns`/`rows` are pixel positions in the detect response's `width × height` space; `ref_width`/`ref_height` tell the backend which page size those pixels refer to, so other page sizes can be scaled proportionally.

---

## 5. Porting checklist & gotchas

1. **DPI must match everywhere.** `RENDER_DPI` in `table_calibrate.py` and the `dpi=150` in `get_page_image` must be identical, or lines will be offset from the image.
2. **CORS:** enumerate your frontend origin explicitly, and keep `Access-Control-Expose-Headers: X-Table-Rows,X-Table-Pages` on the Excel response (or drop those headers and the frontend toast that reads them).
3. **OCR is optional.** Without an engine, native-text PDFs work fully; scanned pages return `word_count: 0` and the UI tells the user to add lines manually (they'd still get empty cells on scrape though — OCR is required to actually *read* scanned pages).
4. **Word-center bucketing** means a word straddling a line goes entirely to the cell containing its center — there is no cell-border clipping. This is what makes calibration forgiving: the line only needs to be *between* columns, not perfectly placed.
5. **Empty rows are dropped** (`if any(cell ...)`) — the areas above the header and below the table produce empty cells and vanish automatically, so you don't need lines hugging the table edges.
6. **Sessions expire** (TTL). Every endpoint 404s with "Session not found. Re-upload." after expiry; the frontend surfaces this as a toast.
7. **Multi-page Excel header dedup:** with `first_row_header=true`, the first data row of *every* page is skipped after the header is written once. If your document only has a header on page 1, uncheck "first row = header" or you'll lose the first data row of pages 2+.
8. The single-page endpoints (`/scrape/`, `/excel/`) are kept for compatibility but the UI only uses the `-all` variants.

## 6. File map (this repo)

| File | Role |
|---|---|
| [src/pages/TableScrape.tsx](src/pages/TableScrape.tsx) | The whole frontend page (upload, overlay, drag, preview, download) |
| [src/App.tsx](src/App.tsx) | Route registration for `/table-scrape` |
| [backend/table_calibrate.py](backend/table_calibrate.py) | Detection + scraping + Excel router (the core of the feature) |
| [backend/main.py](backend/main.py) | Hosts `/api/utility/process` and `/api/utility/page` |
| [backend/pdf_store.py](backend/pdf_store.py) | Production session store (LRU + TTL + disk spill-over) |
| [backend/ocr_lazy.py](backend/ocr_lazy.py) | Lazy RapidOCR singleton (optional) |
