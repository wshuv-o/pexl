import os

# RapidOCR uses ONNX Runtime and does not need any of the paddlepaddle /
# oneDNN environment workarounds that the original PaddleOCR-based build
# required. Threading and memory behaviour are clean out of the box.

import io
import logging
import re
import threading

import fitz  # PyMuPDF
import numpy as np
from PIL import Image
from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

# RapidOCR replaces PaddleOCR + paddlepaddle. The adapter exposes the same
# .ocr() API the rest of the codebase expects, so no other source file
# needs to change.

from pydantic import BaseModel
from typing import Optional

from pdf_store import store
from table_extract import router as table_extract_router
from table_calibrate import router as table_calibrate_router
from utility_import import router as utility_import_router
from crime_scrape_api import router as crime_scrape_router
from images_to_pdf import router as images_to_pdf_router
import batch_service as bs
from date_extract import extract_date
from services.doc_converter import is_doc_file, convert_to_pdf
from automap import match_headers
from searchable_pdf import make_searchable_pdf
from text_pipeline import build_structured_pages
from ocr_lazy import get_ocr_engine
import cell_quality
import region_align

app = FastAPI(title="PDF OCR API")

# Additive, idempotent: adds record versioning + the history table when absent.
# Logs and continues on failure — without it the app just falls back to
# last-write-wins, exactly as before.
try:
    bs.ensure_schema()
except Exception as _exc:  # pragma: no cover - defensive
    logging.getLogger(__name__).error("batch schema migration skipped: %s", _exc)

app.include_router(table_extract_router)
app.include_router(table_calibrate_router)
app.include_router(utility_import_router)
app.include_router(crime_scrape_router)
app.include_router(images_to_pdf_router)

# CORS — enumerate origins explicitly. allow_origins=["*"] combined with
# allow_credentials=True is an invalid pairing per the CORS spec: browsers
# reject it and the middleware ends up omitting the Access-Control-Allow-
# Origin header entirely on error responses (JSONResponse(status_code=404)
# constructed directly by handlers bypass the exception-handler path where
# CORS headers get patched in). Explicit origins fix both by making the
# credentials flag legal AND letting the middleware echo the matched origin
# on every response, error or not.
#
# Override via PEXL_CORS_ORIGINS="https://a.example,https://b.example" if
# a new frontend host comes online without needing a code redeploy.
_default_origins = [
    "https://pexl.bulkscraper.cloud",
    "http://localhost:5173",
    "http://localhost:8080",
    "http://localhost:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:8080",
    "http://127.0.0.1:3000",
]
_env_origins = os.environ.get("PEXL_CORS_ORIGINS", "").strip()
CORS_ORIGINS = (
    [o.strip() for o in _env_origins.split(",") if o.strip()]
    if _env_origins
    else _default_origins
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# OCR engine is now constructed lazily on first actual OCR call — see
# ocr_lazy.get_ocr_engine(). Server startup no longer pays the RapidOCR
# init cost (~1-2 s + ~200 MB) for users who only extract from digital
# PDFs. Matches boss-pdf's pattern.

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Memory-safety knobs (patched build)
# ---------------------------------------------------------------------------
# PEXL_OCR_MAX_CONCURRENCY caps simultaneous OCR-heavy requests so a flood of
# uploads can never balloon RSS past the PM2 / cgroup memory limit. The OCR
# engine itself is single-threaded behind a lock, but rendering + index build
# allocate per-request, and unbounded concurrency was the proximate cause of
# the cascading OOM kills.
def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        v = int(raw)
        return v if v > 0 else default
    except ValueError:
        return default

OCR_MAX_CONCURRENCY = _env_int("PEXL_OCR_MAX_CONCURRENCY", 2)
_ocr_concurrency_sem = threading.Semaphore(OCR_MAX_CONCURRENCY)

# Lower default render DPI from 300 -> 220 cuts pixmap memory by ~46% with
# negligible OCR-accuracy loss on typed PDFs. Override via env if you need
# the old behaviour for low-quality scans.
RENDER_DPI = _env_int("PEXL_RENDER_DPI", 220)

# ---------------------------------------------------------------------------
# Pydantic models  (matching frontend contract)
# ---------------------------------------------------------------------------

class HighlightItem(BaseModel):
    page: int            # 1-based page number
    field: str           # field label chosen by user
    x: float             # top-left X  (fraction 0–1 of page width)
    y: float             # top-left Y  (fraction 0–1 of page height)
    width: float         # selection width  (fraction 0–1)
    height: float        # selection height (fraction 0–1)


class ExtractRegionsRequest(BaseModel):
    session_id: str
    highlights: list[HighlightItem]
    # Opt-in region repair. Off by default: the normal extraction path is
    # unchanged, and the frontend only sets this when re-reading cells it has
    # already flagged as suspect.
    snap_to_line: bool = False


class AutomapMatchRequest(BaseModel):
    session_id: str
    headers: list[str]


# ---------------------------------------------------------------------------
# DocuSign annotation stripper
# ---------------------------------------------------------------------------

# DocuSign e-sign PDFs embed form-field placeholders directly in the text layer:
#   [text|req|signer1 FieldName123]  [sig|req|signer2]  [initial|req|signer1]
# and footer hashes:  Doc ID: 29421d948a80d2c6a3356df21a16546bab78928b
# These contaminate both region extractions and the search index.
_DS_TAG_RE = re.compile(
    r"\[(?:text|sig|initial|date|checkbox|radio|approve|decline|formula|"
    r"attachment|note|dropdown|hyperlink|payment)[|][^\]]*\]",
    re.IGNORECASE,
)
_DS_DOCID_RE = re.compile(r"Doc\s*ID\s*:\s*[0-9a-f]{20,}", re.IGNORECASE)


def _strip_docusign(text: str) -> str:
    """Remove DocuSign annotation tags and Doc ID footers, collapse whitespace."""
    text = _DS_TAG_RE.sub("", text)
    text = _DS_DOCID_RE.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


# ---------------------------------------------------------------------------
# Image → PDF conversion (for non-PDF uploads)
# ---------------------------------------------------------------------------

_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".tiff", ".tif", ".bmp", ".webp", ".gif"}


def _is_image_file(filename: str) -> bool:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return f".{ext}" in _IMAGE_EXTENSIONS


def _image_bytes_to_pdf(image_bytes: bytes) -> bytes:
    """Wrap a raster image in a single-page PDF so the rest of the pipeline
    can treat it identically to an uploaded PDF."""
    img = Image.open(io.BytesIO(image_bytes))
    # Flatten transparency / convert to RGB
    if img.mode == "P":
        img = img.convert("RGBA")
    if img.mode in ("RGBA", "LA"):
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[-1])
        img = bg
    elif img.mode != "RGB":
        img = img.convert("RGB")
    out = io.BytesIO()
    img.save(out, format="PDF", resolution=200.0)
    return out.getvalue()


# ---------------------------------------------------------------------------
# OCR helpers
# ---------------------------------------------------------------------------

# RENDER_DPI is defined above in the memory-safety section (env-tunable).


def extract_native_text_in_rect(page: fitz.Page, rect: fitz.Rect) -> str:
    """Extract native text clipped to a rectangle."""
    return (page.get_text("text", clip=rect) or "").strip()


def ocr_image_array_scored(img_array: np.ndarray) -> tuple[str, list[float]]:
    """Run OCR and return ``(text, per-word confidence scores)``.

    The text is exactly what ``ocr_image_array`` has always returned; the
    scores are extra information the engine already computes and that we
    used to discard. Kept as the single implementation so the plain-text
    wrapper below can never drift from it.
    """
    engine = get_ocr_engine()
    if engine is None:
        return "", []
    try:
        results = engine.ocr(img_array, cls=True)
    except (RuntimeError, Exception):
        return "", []
    if not results or not results[0]:
        return "", []
    text = "\n".join(line[1][0] for line in results[0])
    return text, cell_quality.ocr_scores(results)


def ocr_image_array(img_array: np.ndarray) -> str:
    """Run OCR on a numpy image array and return plain text."""
    return ocr_image_array_scored(img_array)[0]


def ocr_region_image_scored(page: fitz.Page, rect: fitz.Rect) -> tuple[str, list[float]]:
    """Render a specific region of the page at high DPI and OCR it.

    Returns ``(text, per-word scores)``. The text is identical to what
    ``ocr_region_image`` returns — that function delegates here so the
    pixmap-lifetime handling below exists in exactly one place.

    Carefully releases the C-allocated pixmap and PIL image buffers as soon
    as the numpy array is built — otherwise each call leaves ~25 MB of
    pixmap memory queued for GC, which at high concurrency fragments the
    allocator and is the dominant cause of process RSS climbing without
    bound.
    """
    mat = fitz.Matrix(RENDER_DPI / 72, RENDER_DPI / 72)
    pix = page.get_pixmap(matrix=mat, clip=rect)
    try:
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        try:
            arr = np.array(img)
        finally:
            img.close()
    finally:
        # Explicit C-side free; CPython refcount alone is sometimes not
        # enough on long-lived workers because of fitz's own caching.
        pix = None
    return ocr_image_array_scored(arr)


def ocr_region_image(page: fitz.Page, rect: fitz.Rect) -> str:
    """Render a specific region of the page at high DPI and OCR it."""
    return ocr_region_image_scored(page, rect)[0]


def _words_in_rect_text(cached_words, rect: fitz.Rect) -> str:
    """Look up words from a structured-page cache whose bboxes overlap
    ``rect`` and return them concatenated in reading order.

    Used to avoid re-OCRing on every region request — by the time the
    user clicks "extract", the background indexer has usually already
    OCR'd the whole document and stored Word objects with bboxes. This
    is the fast path for scanned PDFs with many highlights, which would
    otherwise time out the proxy.

    Two heuristics tuned to match what a fresh per-region OCR pass would
    have returned:

      • Inclusion threshold: a word counts as "inside" the rect if at
        least 15% of its area is in. Lower than the previous 40% so a
        tight highlight that clips the end of a word still captures it
        — fresh per-region OCR would have rendered the same pixels and
        read the partial.

      • Smart join: when two words are on the same baseline and visually
        adjacent (gap below ~0.3× a character width), concatenate them
        without a space. Without this, "$1,234.56" stored as two cached
        words ["$1,234", ".56"] became "$1,234 .56" — the amount
        normalizer can't always recover the missing decimal.
    """
    if not cached_words:
        return ""

    # Each hit: (y_top, x_left, x_right, text)
    hits: list[tuple[float, float, float, str]] = []
    for w in cached_words:
        try:
            bbox = w.bbox
        except AttributeError:
            continue
        w_rect = fitz.Rect(*bbox)
        if not w_rect.intersects(rect):
            continue
        inter = w_rect & rect
        if inter.is_empty or inter.get_area() < 0.15 * max(w_rect.get_area(), 1.0):
            continue
        text = (w.text or "").strip()
        if text:
            hits.append((float(bbox[1]), float(bbox[0]), float(bbox[2]), text))

    if not hits:
        return ""

    hits.sort()  # top-to-bottom, then left-to-right

    # Smart concatenation using bbox geometry.
    out: list[str] = []
    prev: tuple[float, float, float, str] | None = None
    for h in hits:
        if prev is None:
            out.append(h[3])
        else:
            same_line = abs(h[0] - prev[0]) < 4.0  # y-top within 4 pt
            gap = h[1] - prev[2]                    # horizontal gap from prev right
            prev_text = prev[3]
            char_w = max((prev[2] - prev[1]) / max(len(prev_text), 1), 1.0)
            if same_line and gap < 0.3 * char_w:
                # Visually adjacent — glue ("$1,234" + ".56" → "$1,234.56")
                out[-1] = out[-1] + h[3]
            elif same_line:
                out[-1] = out[-1] + " " + h[3]
            else:
                # Different baseline — start a new line phrase
                out.append(h[3])
        prev = h

    return " ".join(out)


def page_text_lines(page: fitz.Page, cached_words=None):
    """Cluster a page's words into text lines. Callers cache this per page —
    clustering once per page instead of once per region keeps the cost off the
    extraction hot path."""
    boxes = cell_quality.word_boxes_from_cache(cached_words)
    if not boxes:
        boxes = cell_quality.word_boxes_from_page(page)
    return region_align.cluster_lines(boxes) if boxes else []


def extract_region_detailed(
    page: fitz.Page,
    rect: fitz.Rect,
    cached_words=None,
    snap_to_line: bool = False,
    lines=None,
) -> dict:
    """Smart region extraction, plus per-cell quality diagnostics.

    Strategy (adapts to document type without hard-coding OCR everywhere):
      1. Try the native text layer first (fast, precise, covers digital PDFs).
      2. If native text is non-empty after stripping noise → return it.
         No OCR needed; avoids unnecessary GPU work on text-heavy documents.
      3. If ``cached_words`` is provided (background OCR already ran), look
         up overlapping words there — avoids re-OCRing on every region call,
         which is the main cause of /extract-regions timing out.
      4. Otherwise fall back to running PaddleOCR on the rendered region.
      5. If both native and OCR return something, combine them (handles mixed
         pages where values are in the text layer but labels are image-baked).

    Returns ``{"text", "confidence", "was_ocr", "diagnostics"}``. The first
    three are byte-for-byte what ``extract_region`` has always produced —
    this is now the single implementation, and ``extract_region`` is a thin
    wrapper over it.

    ``diagnostics`` is purely additive (see cell_quality.assess_region): OCR
    word scores and clip geometry. It never influences the extracted text or
    the confidence label.
    """
    scores: list[float] = []
    # True only when OCR output is actually part of the returned value — a
    # supplementary OCR pass on a mixed page whose text we then discard must
    # not tag the value with that pass's scores.
    value_from_ocr = False

    # Opt-in: give the region slack within its line's gutters before reading,
    # so a page whose text drifted a few mm still lands inside the box. Walled
    # off from the neighbouring lines, so it can never read the wrong row.
    # Off by default — the original rect is used unless a caller asks for this.
    align_info: dict = {}
    original_box = (rect.x0, rect.y0, rect.x1, rect.y1)
    if snap_to_line:
        try:
            if lines is None:
                lines = page_text_lines(page, cached_words)
            if lines:
                new_box, align_info = region_align.align_rect_to_lines(original_box, lines)
                if align_info.get("realigned"):
                    rect = fitz.Rect(*new_box)
        except Exception:
            # Alignment is an enhancement; never let it break an extraction.
            align_info = {}

    native_text = _strip_docusign(extract_native_text_in_rect(page, rect))

    if native_text:
        # Native text found — sufficient on its own for digital documents.
        # Still attempt OCR for mixed/form pages where the image background
        # may contain additional context not in the text layer.
        try:
            has_images = bool(page.get_images())
        except Exception:
            has_images = False

        if not has_images:
            # Pure text page — native is authoritative, skip OCR.
            text, confidence, was_ocr = native_text, "high", False
        else:
            # Mixed page (DocuSign, form background, etc.) — also run OCR so
            # image-embedded content (e.g. label text) is captured too.
            try:
                ocr_text, ocr_word_scores = ocr_region_image_scored(page, rect)
            except Exception:
                ocr_text, ocr_word_scores = "", []
            if ocr_text and ocr_text.strip().lower() != native_text.strip().lower():
                text, confidence, was_ocr = f"{native_text}\n{ocr_text}", "high", True
                scores = ocr_word_scores
                value_from_ocr = True
            else:
                text, confidence, was_ocr = native_text, "high", False
    else:
        # No native text — try the cached OCR words before paying for a fresh
        # OCR pass. The background indexer has usually already produced these.
        cached_text = _words_in_rect_text(cached_words, rect)
        if cached_text:
            text, confidence, was_ocr = cached_text, "high", True
        else:
            # Cache miss → pure OCR path (scanned page or image-only region).
            try:
                ocr_text, ocr_word_scores = ocr_region_image_scored(page, rect)
            except Exception:
                ocr_text, ocr_word_scores = "", []
            if not ocr_text:
                text, confidence, was_ocr = "", "low", True
            else:
                text, confidence, was_ocr = ocr_text, "high", True
                scores = ocr_word_scores
                value_from_ocr = True

    # Diagnostics must never break an extraction that otherwise succeeded.
    try:
        diagnostics = cell_quality.assess_region(
            rect_box=(rect.x0, rect.y0, rect.x1, rect.y1),
            page=page,
            cached_words=cached_words,
            scores=scores if value_from_ocr else None,
        )
    except Exception:
        diagnostics = {}

    # Geometric drift: did the region read a line it was not aimed at? This is
    # the tell for the one failure nothing else catches — a box that landed
    # squarely on the wrong row returns a perfectly valid-looking value and
    # would otherwise never be questioned. Only computed when the caller has
    # already paid for line clustering, so the plain path stays as fast as ever.
    try:
        if lines:
            if region_align.is_drifted(original_box, lines):
                diagnostics["drifted"] = True
                d = region_align.rect_drift(original_box, lines)
                if d is not None:
                    diagnostics["drift_lines"] = round(d, 2)
    except Exception:
        pass

    if align_info.get("realigned"):
        diagnostics["realigned"] = True
        diagnostics["align"] = align_info

    return {
        "text": text,
        "confidence": confidence,
        "was_ocr": was_ocr,
        "diagnostics": diagnostics,
    }


def extract_region(
    page: fitz.Page,
    rect: fitz.Rect,
    cached_words=None,
) -> tuple[str, str, bool]:
    """Smart region extraction. Returns (text, confidence, was_ocr).

    Thin wrapper over ``extract_region_detailed`` — see that function for the
    strategy. Kept so existing callers are unaffected by the diagnostics work.
    """
    d = extract_region_detailed(page, rect, cached_words=cached_words)
    return d["text"], d["confidence"], d["was_ocr"]


# ---------------------------------------------------------------------------
# Routes — all under /api/utility to match the frontend
# ---------------------------------------------------------------------------

@app.get("/api/utility/health")
def health():
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Memory-safety admin endpoints  (patched build)
# ---------------------------------------------------------------------------

@app.delete("/api/utility/session/{session_id}")
def api_delete_session(session_id: str):
    """Explicitly drop a session and free its memory.

    Frontends should call this when the user closes a document — it's far
    cheaper than waiting for the TTL sweep.
    """
    removed = store.remove(session_id)
    if not removed:
        return JSONResponse(status_code=404, content={"error": "Session not found"})
    return {"status": "ok", "removed": session_id}


@app.get("/api/utility/admin/stats")
def api_admin_stats():
    """Return live store statistics (session count, approx memory per session,
    overall RSS).  Read-only — safe to expose to a monitoring scraper."""
    payload = store.stats()
    # Also include the process RSS so an external monitor can correlate.
    try:
        with open("/proc/self/status", "r") as fh:
            for line in fh:
                if line.startswith("VmRSS:"):
                    payload["rss_kb"] = int(line.split()[1])
                    break
    except Exception:
        pass
    payload["ocr_max_concurrency"] = OCR_MAX_CONCURRENCY
    payload["render_dpi"] = RENDER_DPI
    return payload


@app.get("/api/utility/session/{session_id}/ocr-progress")
def get_ocr_progress(session_id: str):
    """Live OCR index-build progress for a session.

    Returns { current_page, total_pages, done, elapsed_sec }.
    Polled by the frontend every ~2 s after upload to drive a progress bar.
    """
    pdf_doc = store.get(session_id)
    if not pdf_doc:
        return JSONResponse(status_code=404, content={"error": "Session not found"})
    total = pdf_doc.page_count
    # If structured pages are already built, OCR is complete regardless of the
    # progress dict (e.g. the doc had no OCR pages, so build_structured_pages
    # finished instantly before the first poll).
    if pdf_doc.structured_pages is not None:
        return {"current_page": total, "total_pages": total, "done": True, "elapsed_sec": 0.0}
    prog = getattr(pdf_doc, "ocr_progress", {}) or {}
    return {
        "current_page": prog.get("current_page", 0),
        "total_pages":  prog.get("total_pages") or total,
        "done":         prog.get("done", False),
        "elapsed_sec":  round(prog.get("elapsed_sec", 0.0), 1),
    }


class RotateRequest(BaseModel):
    delta: int = 90  # must be a multiple of 90 (0, 90, 180, 270 — or negative)


@app.post("/api/utility/session/{session_id}/rotate")
def rotate_session(session_id: str, req: RotateRequest):
    """Rotate every page of the session's PDF by ``delta`` degrees and
    bake the result in. Always re-renders pages as upright bitmaps, so
    after a call every page has ``rotation == 0`` and content in physical
    coordinates — which is what OCR/highlighting need to work correctly.

    Use ``delta=0`` to just bake the current orientation (useful for
    scanned PDFs whose rotation metadata trips up OCR coordinate math).
    """
    pdf_doc = store.get(session_id)
    if not pdf_doc:
        return JSONResponse(status_code=404, content={"error": "Session not found"})

    if req.delta % 90 != 0:
        return JSONResponse(status_code=400, content={"error": "delta must be a multiple of 90"})

    try:
        pdf_doc.rotate_all(req.delta)
    except Exception as exc:
        logger.exception("Rotate failed for session %s", session_id[-6:])
        return JSONResponse(status_code=500, content={"error": f"Rotation failed: {exc}"})

    logger.info(
        "Rotated session %s by %d° (now %d pages, all upright)",
        session_id[-6:], req.delta, pdf_doc.page_count,
    )
    return {
        "status": "ok",
        "session_id": session_id,
        "delta": req.delta,
        "page_count": pdf_doc.page_count,
        "page_info": pdf_doc.page_info,
    }


@app.post("/api/utility/session/{session_id}/force-ocr")
def trigger_force_ocr(session_id: str):
    """Flip the session into force-OCR mode and invalidate cached OCR output.

    With text-search removed, this endpoint no longer kicks a background
    index build — it simply nukes the OCR caches so the next /ocr-pdf
    click rebuilds the searchable PDF from scratch with every page treated
    as scanned.
    """
    pdf_doc = store.get(session_id)
    if not pdf_doc:
        return JSONResponse(status_code=404, content={"error": "Session not found"})

    pdf_doc.force_ocr = True
    pdf_doc.structured_pages = None
    pdf_doc.searchable_pdf_bytes = None
    pdf_doc._searchable_cache_key = None
    pdf_doc.ocr_progress = {
        "current_page": 0,
        "total_pages": pdf_doc.page_count,
        "done": False,
        "elapsed_sec": 0.0,
    }

    logger.info("Force-OCR triggered for session %s (%d pages)", session_id[-6:], pdf_doc.page_count)
    return {"status": "ok", "session_id": session_id, "total_pages": pdf_doc.page_count}


@app.get("/api/utility/providers")
def providers():
    return {"providers": [
        "National Grid Gas",
        "Con Edison",
        "PSEG",
        "National Fuel",
        "KeySpan",
    ]}


# ---- Upload & analyse PDF ----
@app.post("/api/utility/process")
async def process_pdf(file: UploadFile = File(...)):
    """Upload a PDF, DOC/DOCX, or raster image (PNG/JPG/TIFF/BMP/WEBP).
    Non-PDF inputs are converted to PDF before processing so the rest of the
    pipeline is document-type agnostic."""
    filename = file.filename or "document"
    file_bytes = await file.read()
    if not file_bytes:
        return JSONResponse(status_code=400, content={"error": "Uploaded file is empty."})

    if is_doc_file(filename):
        try:
            pdf_bytes = convert_to_pdf(file_bytes, filename)
            filename = filename.rsplit(".", 1)[0] + ".pdf"
        except RuntimeError as exc:
            return JSONResponse(status_code=500, content={"error": str(exc)})
    elif filename.lower().endswith(".pdf"):
        pdf_bytes = file_bytes
    elif _is_image_file(filename):
        try:
            pdf_bytes = _image_bytes_to_pdf(file_bytes)
            filename = filename.rsplit(".", 1)[0] + ".pdf"
        except Exception as exc:
            return JSONResponse(status_code=400, content={"error": f"Could not read image: {exc}"})
    else:
        return JSONResponse(
            status_code=400,
            content={"error": "Supported formats: PDF, DOC, DOCX, PNG, JPG, TIFF, BMP, WEBP."},
        )

    session_id = store.add(pdf_bytes, filename)
    pdf_doc = store.get(session_id)

    # Uploads no longer eagerly OCR-index the document. Highlight extraction
    # (`/extract-regions`) works without any prebuilt index — it falls back
    # to per-region OCR (`ocr_region_image`), which reads ~1 page's worth of
    # pixels instead of the whole document. The searchable-PDF download
    # (`/ocr-pdf`) builds `structured_pages` on demand and caches the result.

    return {
        "session_id": session_id,
        "total_pages": pdf_doc.page_count,
        "pages": pdf_doc.page_info,
        "ocr_pages_count": pdf_doc.ocr_pages_count,
    }


# ---- Get the full (converted) PDF bytes for this session ----
@app.get("/api/utility/session/{session_id}/pdf")
def get_session_pdf(session_id: str):
    """Return the stored PDF bytes. For DOC/DOCX uploads this is the
    LibreOffice-converted PDF, so the frontend viewer can render it."""
    pdf_doc = store.get(session_id)
    if not pdf_doc:
        return JSONResponse(status_code=404, content={"error": "Session not found"})

    # Large files are stored on disk — stream directly so we don't load the
    # whole file into heap memory just to forward it to the client.
    if pdf_doc.pdf_path:
        return FileResponse(
            pdf_doc.pdf_path,
            media_type="application/pdf",
            headers={"Content-Disposition": f'inline; filename="{session_id}.pdf"'},
        )

    raw = pdf_doc.pdf_bytes
    if not raw:
        return JSONResponse(status_code=410, content={"error": "Session files no longer available"})
    return Response(
        content=raw,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{session_id}.pdf"'},
    )


# ---- Download the OCR'd (searchable) PDF ----
@app.get("/api/utility/session/{session_id}/ocr-pdf")
def get_session_ocr_pdf(session_id: str, force: bool = False, image_only: bool = True):
    """Return a searchable PDF with an OCR text layer.

    Modes (mutually exclusive — image_only takes precedence):

      • ``image_only=true`` (default) — Rebuild the PDF: every page becomes
        a rendered image overlaid with invisible OCR text. The original
        text layer is *discarded entirely*. This is the right mode when
        the source PDF has broken UTF characters, vector-drawn text, or
        any other content where the native text layer is unreliable. OCR
        is forced on every page regardless of classification.

      • ``force=true, image_only=false`` — Keep the original PDF, add an
        OCR overlay on every page. The native text layer is preserved
        alongside the OCR text. Useful when the original text is mostly
        good and you just want OCR coverage on a few scanned pages.

      • ``image_only=false`` (default ``force=false``) — Only pages
        classified as scanned / mixed / form / vector get an overlay;
        native pages pass through unchanged. Fastest, but skips PDFs we
        misclassify.

    Cache keys on both flags so toggling either re-runs OCR."""
    pdf_doc = store.get(session_id)
    if not pdf_doc:
        return JSONResponse(status_code=404, content={"error": "Session not found"})
    # Availability check: disk-backed docs have a path; in-memory docs have bytes.
    if not pdf_doc.pdf_path and pdf_doc.pdf_bytes is None:
        return JSONResponse(status_code=410, content={"error": "Session files no longer available"})

    # Cache keys on both `force` and `image_only` so toggling either flag
    # invalidates the prior result. Sessions uploaded before these flags
    # existed have ``prev=None`` and are also treated as misses so the
    # first request with the new defaults rebuilds the OCR layer.
    cache_key = (bool(force), bool(image_only))
    prev_key = getattr(pdf_doc, "_searchable_cache_key", None)
    if prev_key != cache_key:
        pdf_doc.searchable_pdf_bytes = None

    if pdf_doc.searchable_pdf_bytes is None:
        try:
            with _ocr_concurrency_sem:
                pdf_doc.searchable_pdf_bytes = make_searchable_pdf(
                    pdf_doc, get_ocr_engine(),
                    force_all_pages=force,
                    image_only=image_only,
                )
            pdf_doc._searchable_cache_key = cache_key
        except Exception:
            import traceback
            traceback.print_exc()
            pdf_doc.searchable_pdf_bytes = pdf_doc.pdf_bytes or b""
    out_bytes = pdf_doc.searchable_pdf_bytes

    base_name = pdf_doc.filename.rsplit(".", 1)[0] if pdf_doc.filename else session_id
    download_name = f"{base_name}_ocr.pdf"

    response = Response(
        content=out_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{download_name}"'},
    )

    # Keep the cache around until session TTL expires. Previously we
    # nuked it right after the download, which meant any retry — including
    # a "the network blipped, click again" retry — paid the full
    # multi-minute OCR rebuild cost. The session sweeper still reclaims
    # the bytes when the session itself expires.
    return response


# ---- Get a page as PNG (for the frontend PDF viewer) ----
@app.get("/api/utility/page/{session_id}/{page_num}")
def get_page_image(session_id: str, page_num: int):
    """Return a page as a PNG image. page_num is 1-based."""
    pdf_doc = store.get(session_id)
    if not pdf_doc:
        return JSONResponse(status_code=404, content={"error": "Session not found. Re-upload."})
    if page_num < 1 or page_num > pdf_doc.page_count:
        return JSONResponse(status_code=400, content={"error": f"Invalid page. PDF has {pdf_doc.page_count} pages."})

    page = pdf_doc.doc[page_num - 1]
    pix = page.get_pixmap(dpi=150)
    img_bytes = pix.tobytes("png")

    return StreamingResponse(io.BytesIO(img_bytes), media_type="image/png")


# ---- Extract text from highlighted regions ----
@app.post("/api/utility/extract-regions")
def extract_regions(req: ExtractRegionsRequest):
    """Extract text from user-drawn highlight rectangles.

    Coordinates are fractions (0–1) of page dimensions — the frontend computes
    them as (selectionX / imageWidth) etc.

    Returns { results: ExtractedRow[] } matching the frontend ExtractedRow type.
    """
    pdf_doc = store.get(req.session_id)
    if not pdf_doc:
        return JSONResponse(status_code=404, content={"error": "Session expired. Re-upload the file."})

    results = []
    line_cache: dict[int, list] = {}

    for hl in req.highlights:
        if hl.page < 1 or hl.page > pdf_doc.page_count:
            results.append({
                "page": hl.page,
                "field": hl.field,
                "value": None,
                "confidence": "low",
                "wasOcr": False,
            })
            continue

        page = pdf_doc.doc[hl.page - 1]
        page_rect = page.rect

        # Convert 0–1 fractions to PDF points
        x0 = page_rect.width * hl.x
        y0 = page_rect.height * hl.y
        x1 = x0 + page_rect.width * hl.width
        y1 = y0 + page_rect.height * hl.height
        clip_rect = fitz.Rect(x0, y0, x1, y1)

        # Reach into the background OCR cache for this page (may still be
        # building — None is fine, extract_region just falls back to fresh OCR).
        cached_words = None
        sp = getattr(pdf_doc, "structured_pages", None)
        if sp and hl.page - 1 < len(sp):
            cp = sp[hl.page - 1]
            cached_words = getattr(cp, "words", None)

        # Cluster this page's text lines once and reuse across every highlight
        # on it — clustering per region would be wasted work.
        if hl.page not in line_cache:
            line_cache[hl.page] = page_text_lines(page, cached_words)

        detail = extract_region_detailed(
            page, clip_rect,
            cached_words=cached_words,
            snap_to_line=req.snap_to_line,
            lines=line_cache[hl.page],
        )
        text, confidence, was_ocr = detail["text"], detail["confidence"], detail["was_ocr"]
        diagnostics = detail.get("diagnostics") or {}

        value = text if text else None

        # Auto-normalize date fields into MM/DD/YYYY. Utility billing_date
        # is special: the source often prints a date range like
        # "Dec 11 2024 - Jan 13 2025"; we want the *close* of the billing
        # period as the date of record, so use take_end=True. Other date
        # fields keep the default (start of range).
        DATE_FIELDS = {
            "billing_date", "statement_date", "appraised_date",
            "lease_date", "lease_begin_date", "lease_end_date",
        }
        if value and hl.field in DATE_FIELDS:
            normalized = extract_date(value, take_end=(hl.field == "billing_date"))
            if normalized != "NONE":
                value = normalized

        # Existing keys are unchanged. The quality keys below are additive —
        # older frontends simply ignore them.
        row = {
            "page": hl.page,
            "field": hl.field,
            "value": value,
            "confidence": confidence,
            "wasOcr": was_ocr,
        }
        if "ocr_score" in diagnostics:
            row["ocrScore"] = diagnostics["ocr_score"]
            row["ocrScoreAvg"] = diagnostics.get("ocr_score_avg")
        if diagnostics.get("clipped"):
            row["clipped"] = True
            row["clippedText"] = diagnostics.get("clipped_text")
        if diagnostics.get("drifted"):
            row["drifted"] = True
            row["driftLines"] = diagnostics.get("drift_lines")
        if diagnostics.get("realigned"):
            row["realigned"] = True
            row["alignInfo"] = diagnostics.get("align")
        results.append(row)

    return {"results": results}


# ---- Auto-map: find each Excel header's value in the PDF ----
@app.post("/api/automap/match")
def automap_match(req: AutomapMatchRequest):
    """For each Excel header, locate its label in the PDF and extract the
    adjacent value. Returns HeaderMatch[] with the shape the frontend expects.

    Works for native PDFs (text layer) and scanned PDFs (PaddleOCR fallback)."""
    pdf_doc = store.get(req.session_id)
    if not pdf_doc:
        return JSONResponse(status_code=404, content={"error": "Session not found. Re-upload."})

    results = match_headers(pdf_doc, req.headers, ocr_engine=get_ocr_engine())
    return results


# ---------------------------------------------------------------------------
# Batch / approval endpoints
# ---------------------------------------------------------------------------

class CreateBatchBody(BaseModel):
    name: str
    created_by: str
    # Doc type baked in at creation time — every download of this batch
    # will always use this template (utility_bill / bank_statement /
    # appraisal / lease_contract / tax / others). Optional: pre-migration
    # rows have NULL and the client-side exporter auto-detects the
    # template from the actual field names in that case.
    doc_type: Optional[str] = None

class UpdateBatchBody(BaseModel):
    name: str
    updated_by: str
    # Optional. When present, updates the batch's export template. Send
    # empty string or the sentinel "auto" to clear it back to NULL.
    doc_type: Optional[str] = None

class UpsertRecordBody(BaseModel):
    session_id: str
    filename: str
    page: int
    fields: dict
    # Version the client last saw. Omit for last-write-wins (legacy callers);
    # send it to get a 409 + the server's current row instead of a silent
    # overwrite when someone else edited the same record.
    base_version: Optional[int] = None
    updated_by: Optional[str] = None

@app.get("/api/batches")
def api_list_batches():
    try:
        return {"status": "ok", "batches": bs.list_batches()}
    except Exception as e:
        return JSONResponse(status_code=500, content={"detail": str(e)})

@app.post("/api/batches")
def api_create_batch(body: CreateBatchBody):
    try:
        bid = bs.create_batch(body.name, body.created_by, body.doc_type)
        return {"status": "ok", "batch": bs.get_batch(bid)}
    except Exception as e:
        return JSONResponse(status_code=500, content={"detail": str(e)})

@app.patch("/api/batches/{batch_id}")
def api_update_batch(batch_id: int, body: UpdateBatchBody):
    try:
        batch = bs.get_batch(batch_id)
        if not batch:
            return JSONResponse(status_code=404, content={"detail": "Batch not found"})
        bs.update_batch(batch_id, body.name, body.updated_by, body.doc_type)
        return {"status": "ok", "batch": bs.get_batch(batch_id)}
    except Exception as e:
        return JSONResponse(status_code=500, content={"detail": str(e)})

@app.delete("/api/batches/{batch_id}")
def api_delete_batch(batch_id: int):
    try:
        ok = bs.delete_batch(batch_id)
        if not ok:
            return JSONResponse(status_code=404, content={"detail": "Batch not found"})
        return {"status": "ok"}
    except Exception as e:
        return JSONResponse(status_code=500, content={"detail": str(e)})

@app.get("/api/batches/{batch_id}/records")
def api_get_records(batch_id: int):
    try:
        return {"status": "ok", "records": bs.get_batch_records(batch_id)}
    except Exception as e:
        return JSONResponse(status_code=500, content={"detail": str(e)})

@app.post("/api/batches/{batch_id}/records")
def api_upsert_record(batch_id: int, body: UpsertRecordBody):
    try:
        result = bs.upsert_record(
            batch_id, body.session_id, body.filename, body.page, body.fields,
            base_version=body.base_version, updated_by=body.updated_by,
        )
        if result.get("status") == "conflict":
            # 409 so the client can open a merge dialog instead of clobbering.
            return JSONResponse(status_code=409, content=result)
        return {"status": "ok", "id": result.get("id"), "version": result.get("version")}
    except Exception as e:
        return JSONResponse(status_code=500, content={"detail": str(e)})

@app.delete("/api/batches/{batch_id}/records/{session_id}/{page}")
def api_delete_record(batch_id: int, session_id: str, page: int, deleted_by: str | None = None):
    try:
        ok = bs.delete_record(batch_id, session_id, page, deleted_by=deleted_by)
        return {"status": "ok", "deleted": ok}
    except Exception as e:
        return JSONResponse(status_code=500, content={"detail": str(e)})

@app.get("/api/batches/{batch_id}/history")
def api_batch_history(batch_id: int, session_id: str | None = None,
                      page: int | None = None, limit: int = 200):
    """Change log for a batch — every saved version, newest first."""
    try:
        return {"status": "ok", "history": bs.get_record_history(batch_id, session_id, page, limit)}
    except Exception as e:
        return JSONResponse(status_code=500, content={"detail": str(e)})


@app.on_event("shutdown")
def _on_shutdown():
    """Cleanly stop the PDFStore sweeper and close all sessions when uvicorn
    receives SIGTERM (e.g. from PM2 restart). Prevents leaked temp files."""
    try:
        store.shutdown()
    except Exception:
        pass


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
