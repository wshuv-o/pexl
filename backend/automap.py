"""
Backend auto-matcher: given a session's PDF + a list of Excel headers, find
the most likely label location for each header and extract the adjacent value.

Mirrors the TypeScript autoMatch() function in the frontend:
  1. Extract text items (x, y, width, height, str) from each page.
     - Native PDFs: use PyMuPDF's text blocks.
     - Scanned pages: fall back to PaddleOCR and use the detected polygons.
  2. For each header, find label candidates via Jaccard token similarity
     (single items AND 2–4-word n-gram slices on the same line).
  3. For each candidate label, pick a value using this preference:
       (a) inline "Label: value" within the same text run,
       (b) first item on the same line to the right of the label,
       (c) first item below the label that horizontally overlaps.
  4. Return top-N candidates per header (best match + alternatives).
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

import fitz  # PyMuPDF
import numpy as np
from PIL import Image


# ---------------------------------------------------------------------------
# Data structures (shape matches frontend HeaderMatch / MatchBox)
# ---------------------------------------------------------------------------

@dataclass
class TextItem:
    str_: str
    norm: str
    x: float
    y: float
    width: float
    height: float


# ---------------------------------------------------------------------------
# Normalisation + similarity (mirrors frontend auto-match.ts)
# ---------------------------------------------------------------------------

_NORM_STRIP = re.compile(r"[^a-z0-9\s%$./\-]")
_WS = re.compile(r"\s+")


def _normalize(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = s.lower()
    s = _NORM_STRIP.sub(" ", s)
    s = _WS.sub(" ", s).strip()
    return s


def _tokens(s: str) -> list[str]:
    return [t for t in _normalize(s).split(" ") if len(t) >= 2]


def _similarity(a: str, b: str) -> float:
    A = set(_tokens(a))
    B = set(_tokens(b))
    if not A or not B:
        return 0.0
    inter = len(A & B)
    return inter / max(len(A), len(B))


# ---------------------------------------------------------------------------
# Line / adjacency helpers
# ---------------------------------------------------------------------------

def _same_line(a: TextItem, b: TextItem) -> bool:
    ay = a.y + a.height / 2
    by = b.y + b.height / 2
    return abs(ay - by) <= max(a.height, b.height) * 0.6


def _below_line(a: TextItem, b: TextItem) -> bool:
    gap = b.y - (a.y + a.height)
    if gap < -2 or gap > a.height * 2.2:
        return False
    # horizontal overlap required
    return (b.x < a.x + a.width * 1.2) and (b.x + b.width > a.x - 20)


# ---------------------------------------------------------------------------
# Page item extraction
# ---------------------------------------------------------------------------

def _extract_native_items(page: fitz.Page) -> tuple[list[TextItem], float, float]:
    """PyMuPDF native text extraction — uses dict mode to get per-span bboxes."""
    rect = page.rect
    pw, ph = rect.width, rect.height

    items: list[TextItem] = []
    d = page.get_text("dict")
    for block in d.get("blocks", []):
        if block.get("type") != 0:  # type 0 = text
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                text = span.get("text", "")
                if not text.strip():
                    continue
                bbox = span.get("bbox", [0, 0, 0, 0])
                x0, y0, x1, y1 = bbox
                items.append(TextItem(
                    str_=text,
                    norm=_normalize(text),
                    x=x0,
                    y=y0,
                    width=max(x1 - x0, 1),
                    height=max(y1 - y0, 1),
                ))
    return items, pw, ph


def _extract_ocr_items(page: fitz.Page, ocr_engine) -> tuple[list[TextItem], float, float]:
    """Render page and run PaddleOCR; return items in PDF-point coordinates."""
    render_dpi = 200
    scale = render_dpi / 72.0
    pix = page.get_pixmap(dpi=render_dpi)
    img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
    img_arr = np.array(img)

    pw = page.rect.width
    ph = page.rect.height

    results = ocr_engine.ocr(img_arr, cls=True)
    if not results or not results[0]:
        return [], pw, ph

    items: list[TextItem] = []
    for line in results[0]:
        poly, (text, _conf) = line[0], line[1]
        if not text or not text.strip():
            continue
        xs = [p[0] for p in poly]
        ys = [p[1] for p in poly]
        # Convert pixel coords → PDF points
        x0 = min(xs) / scale
        y0 = min(ys) / scale
        x1 = max(xs) / scale
        y1 = max(ys) / scale
        items.append(TextItem(
            str_=text,
            norm=_normalize(text),
            x=x0,
            y=y0,
            width=max(x1 - x0, 1),
            height=max(y1 - y0, 1),
        ))
    return items, pw, ph


# ---------------------------------------------------------------------------
# Label → value resolution
# ---------------------------------------------------------------------------

_SEP_RE = re.compile(r"[:\-\u2013\u2014]")
_SEP_ONLY_RE = re.compile(r"^[:\-\u2013\u2014]$")


def _find_value_after_label(label: TextItem, all_items: list[TextItem]) -> TextItem | None:
    # (1) Inline "Label: value" within a single run
    m = _SEP_RE.search(label.str_)
    if m and m.start() < len(label.str_) - 1:
        tail = label.str_[m.start() + 1:].strip()
        if tail:
            leading_share = (m.start() + 1) / len(label.str_)
            return TextItem(
                str_=tail,
                norm=_normalize(tail),
                x=label.x + label.width * leading_share,
                y=label.y,
                width=label.width * (1 - leading_share),
                height=label.height,
            )

    # (2) Same-line candidates to the right
    right = sorted(
        (it for it in all_items
         if it is not label
         and _same_line(label, it)
         and it.x > label.x + label.width * 0.4),
        key=lambda it: it.x,
    )
    if right:
        first = right[0]
        if _SEP_ONLY_RE.match(first.str_.strip()) and len(right) > 1:
            return right[1]
        return first

    # (3) Below candidates
    below = sorted(
        (it for it in all_items if it is not label and _below_line(label, it)),
        key=lambda it: (it.y, it.x),
    )
    return below[0] if below else None


def _find_label_candidates(items: list[TextItem], header: str, top_n: int = 4):
    """Return [{item, score}] sorted by descending score."""
    candidates = []

    # Single-item matches
    for it in items:
        if not it.norm:
            continue
        s = _similarity(header, it.str_)
        if s >= 0.5:
            candidates.append((it, s))

    # 2–4 word n-gram slices on same line (pdfs often split "Account Number")
    n = len(items)
    for i in range(n):
        for span in range(2, 5):
            j = i + span
            if j > n:
                break
            window = items[i:j]
            ok = True
            for k in range(1, len(window)):
                if not _same_line(window[k - 1], window[k]):
                    ok = False
                    break
            if not ok:
                break
            combined = " ".join(w.str_ for w in window)
            s = _similarity(header, combined)
            if s < 0.7:
                continue
            xs = [w.x for w in window]
            ys = [w.y for w in window]
            xe = [w.x + w.width for w in window]
            ye = [w.y + w.height for w in window]
            virtual = TextItem(
                str_=combined,
                norm=_normalize(combined),
                x=min(xs),
                y=min(ys),
                width=max(xe) - min(xs),
                height=max(ye) - min(ys),
            )
            candidates.append((virtual, s + 0.05))

    candidates.sort(key=lambda c: c[1], reverse=True)
    return candidates[:top_n]


# ---------------------------------------------------------------------------
# Public entry
# ---------------------------------------------------------------------------

def match_headers(
    pdf_doc,
    headers: list[str],
    ocr_engine=None,
) -> list[dict]:
    """Run the full matcher and return HeaderMatch[] compatible with the frontend.

    `pdf_doc` must expose:
      - `doc`: a fitz.Document
      - `page_info`: list[dict] with {is_ocr: bool} per page
    """
    doc = pdf_doc.doc
    page_info = getattr(pdf_doc, "page_info", [])

    per_header: dict[str, list[dict]] = {h: [] for h in headers}

    for page_idx in range(len(doc)):
        page = doc[page_idx]
        is_ocr_page = False
        if page_idx < len(page_info):
            is_ocr_page = page_info[page_idx].get("is_ocr", False)

        if is_ocr_page and ocr_engine is not None:
            items, pw, ph = _extract_ocr_items(page, ocr_engine)
        else:
            items, pw, ph = _extract_native_items(page)
            # Fall back to OCR if page has no native items but we have engine
            if not items and ocr_engine is not None:
                items, pw, ph = _extract_ocr_items(page, ocr_engine)

        if not items:
            continue

        for header in headers:
            for label, score in _find_label_candidates(items, header):
                value = _find_value_after_label(label, items)
                if value is None:
                    continue
                box = {
                    "page": page_idx + 1,
                    "x": value.x / pw,
                    "y": value.y / ph,
                    "width": value.width / pw,
                    "height": value.height / ph,
                    "value": value.str_.strip(),
                    "label": label.str_.strip(),
                    "score": float(score),
                }
                per_header[header].append(box)

    results = []
    for header in headers:
        matches = sorted(per_header[header], key=lambda b: b["score"], reverse=True)
        results.append({
            "header": header,
            "box": matches[0] if matches else None,
            "alternatives": matches[1:6],
        })
    return results
