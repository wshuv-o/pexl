"""
Backend fix: rasterize-then-OCR fallback for vector-only PDFs.

WHY
---
Some PDFs (Panorama / Oakbrook rent rolls etc.) contain ONLY vector path
drawings — no text layer, no embedded images. PaddleOCR + PyMuPDF text
extraction sees nothing and returns empty. The frontend then has no data
to extract.

FIX
---
Detect "vector-only" pages BEFORE running OCR; rasterize the page to a
PNG, then feed that image into PaddleOCR. Vector glyphs become regular
pixels that OCR can read.

DROP-IN USAGE
-------------
The cheapest change is to call `text_for_page(page, ocr)` instead of
`page.get_text()` everywhere you currently extract page text, and call
`text_in_rect(page, rect_norm, ocr)` everywhere you OCR a highlight box.
Both functions handle the rasterize fallback automatically.

Tested against PaddleOCR 2.7.x.
"""
from __future__ import annotations

import io
from typing import Iterable, List, Optional, Sequence, Tuple


# ── Page classification ────────────────────────────────────────────────────
def page_kind(page) -> str:
    """Classify a fitz.Page so we know which extraction strategy to use.

    Returns:
        'text'    has a usable text layer (just call page.get_text())
        'image'   has embedded images (existing OCR pipeline works)
        'vector'  only vector drawings (NEW: rasterize + OCR)
        'empty'   truly blank (skip)
    """
    text = (page.get_text() or '').strip()
    if len(text) >= 10:
        return 'text'
    if len(page.get_images()) > 0:
        return 'image'
    if len(page.get_drawings()) > 0:
        return 'vector'
    return 'empty'


# ── Rasterization ─────────────────────────────────────────────────────────
def rasterize_page(page, dpi: int = 200):
    """Return (PIL.Image, scale_x, scale_y) where scale_* converts PDF
    points to image pixels. 200 DPI gives ~1700×2200 px for a US-letter
    page — enough resolution for body-text OCR.
    """
    from PIL import Image

    pix = page.get_pixmap(dpi=dpi)
    img = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
    sx = pix.width  / page.rect.width
    sy = pix.height / page.rect.height
    return img, sx, sy


# ── Concrete PaddleOCR adapter ────────────────────────────────────────────
def _ocr_paddle(img, ocr) -> List[Tuple[List[Tuple[float, float]], str, float]]:
    """Run PaddleOCR on a PIL image. Returns:
        [ ((x,y) corners, text, confidence), … ]

    Works with both PaddleOCR 2.x (uses `.ocr(arr, cls=True)`) and 3.x
    (uses `.predict(input=arr)`). Detects which API is available at
    call time, so a single deployment can use whichever version is pinned.
    """
    import numpy as np
    arr = np.asarray(img.convert('RGB'))
    out: List[Tuple[List[Tuple[float, float]], str, float]] = []

    # PaddleOCR 3.x: .predict() returns rec_polys / rec_texts / rec_scores.
    if hasattr(ocr, 'predict'):
        try:
            raw = ocr.predict(input=arr)
        except TypeError:
            raw = ocr.predict(arr)
        for r in (raw or []):
            polys  = r.get('rec_polys',  []) if isinstance(r, dict) else getattr(r, 'rec_polys',  [])
            texts  = r.get('rec_texts',  []) if isinstance(r, dict) else getattr(r, 'rec_texts',  [])
            scores = r.get('rec_scores', []) if isinstance(r, dict) else getattr(r, 'rec_scores', [])
            for poly, text, score in zip(polys, texts, scores):
                # poly is np.ndarray shape (4, 2); coerce to list of (x, y)
                pts = [(float(p[0]), float(p[1])) for p in poly]
                out.append((pts, text or '', float(score or 0.0)))
        if out:
            return out

    # Fall back to legacy 2.x API.
    if hasattr(ocr, 'ocr'):
        try:
            raw = ocr.ocr(arr, cls=True)
        except TypeError:
            raw = ocr.ocr(arr)
        if not raw or not raw[0]:
            return out
        for item in raw[0]:
            poly, (text, conf) = item
            out.append(([(float(p[0]), float(p[1])) for p in poly],
                        text or '', float(conf or 0.0)))

    return out


# ── Public helpers — call these instead of page.get_text() / OCR-by-rect ──
def text_for_page(page, ocr, dpi: int = 200) -> str:
    """Best-available text for an entire page. Handles native-text,
    image-only and vector-only PDFs uniformly."""
    kind = page_kind(page)
    if kind == 'text':
        return page.get_text()
    if kind == 'empty':
        return ''
    img, _, _ = rasterize_page(page, dpi=dpi)
    items = _ocr_paddle(img, ocr)
    return '\n'.join(t for _, t, _ in items)


def text_in_rect(page, rect_norm: Tuple[float, float, float, float],
                 ocr, dpi: int = 200) -> str:
    """Text inside a 0-1 normalized rect on a page. Used for the
    /extract-regions handler. `rect_norm = (x0, y0, x1, y1)`.
    """
    pw, ph = page.rect.width, page.rect.height
    x0, y0, x1, y1 = rect_norm
    bbox_pdf = (x0 * pw, y0 * ph, x1 * pw, y1 * ph)

    kind = page_kind(page)

    # Native text: trust the text layer, no OCR needed.
    if kind == 'text':
        words = page.get_text('words', clip=bbox_pdf)
        return ' '.join(w[4] for w in words).strip()

    if kind == 'empty':
        return ''

    # Image / vector — rasterize and OCR only the cropped region. Cropping
    # before OCR is much faster than OCRing the whole page just to throw
    # most of it away.
    img, sx, sy = rasterize_page(page, dpi=dpi)
    crop = img.crop((
        max(0, int(x0 * pw * sx)),
        max(0, int(y0 * ph * sy)),
        min(img.width,  int(x1 * pw * sx)),
        min(img.height, int(y1 * ph * sy)),
    ))
    items = _ocr_paddle(crop, ocr)
    return ' '.join(t for _, t, _ in items).strip()


def search_page_for(page, query: str, ocr, dpi: int = 200
                    ) -> List[Tuple[float, float, float, float]]:
    """Find bounding boxes of `query` on a page. Returns list of bboxes
    in normalized 0-1 coords: (x0, y0, x1, y1)."""
    kind = page_kind(page)
    if kind == 'text':
        rects = page.search_for(query)
        pw, ph = page.rect.width, page.rect.height
        return [(r.x0/pw, r.y0/ph, r.x1/pw, r.y1/ph) for r in rects]

    if kind == 'empty':
        return []

    img, sx, sy = rasterize_page(page, dpi=dpi)
    items = _ocr_paddle(img, ocr)
    q = query.lower().strip()
    out = []
    for poly, text, _conf in items:
        if not text or q not in text.lower():
            continue
        xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
        # Convert pixel poly back to normalized 0-1 PDF coords.
        out.append((
            min(xs) / img.width,
            min(ys) / img.height,
            max(xs) / img.width,
            max(ys) / img.height,
        ))
    return out


# ── CLI sanity-check ──────────────────────────────────────────────────────
def _make_ocr():
    """Construct a PaddleOCR instance that works on both 2.x and 3.x.
    Tries the modern keyword first (`use_textline_orientation`), falls
    back to the legacy one (`use_angle_cls`).
    """
    from paddleocr import PaddleOCR
    for kwargs in (
        dict(lang='en', use_textline_orientation=True),
        dict(lang='en', use_angle_cls=True, show_log=False),
        dict(lang='en'),
    ):
        try:
            return PaddleOCR(**kwargs)
        except (TypeError, ValueError):
            continue
    # Last resort — construct with no args.
    return PaddleOCR()


def _cli():
    import sys
    if len(sys.argv) < 2:
        print('Usage: python backend_vector_pdf_fix.py path/to/file.pdf')
        sys.exit(1)
    import fitz

    pdf = sys.argv[1]
    doc = fitz.open(pdf)
    print(f'{pdf}: {len(doc)} pages')
    ocr = _make_ocr()

    for i, p in enumerate(doc):
        k = page_kind(p)
        line = (f'  page {i+1}: kind={k:<6}  text_len={len(p.get_text())}  '
                f'images={len(p.get_images())}  drawings={len(p.get_drawings())}')
        if k in ('vector', 'image'):
            t = text_for_page(p, ocr)
            line += f'  ocr_text_len={len(t)}'
            if t:
                line += f'  preview={t[:80]!r}'
        print(line)


if __name__ == '__main__':
    _cli()


# ─────────────────────────────────────────────────────────────────────────
# WIRING NOTES — read this before pasting into the backend
# ─────────────────────────────────────────────────────────────────────────
# 1. Wherever you currently do `page.get_text()` for a /process result,
#    swap to:
#        text = text_for_page(page, ocr)
#    where `ocr` is your existing PaddleOCR instance.
#
# 2. Wherever you OCR a single highlight rect for /extract-regions, swap
#    the OCR call to:
#        value = text_in_rect(page, (x0, y0, x1, y1), ocr)
#    The rect is the highlight in normalized 0-1 coords (the frontend
#    sends them that way already).
#
# 3. For the /search endpoint (Whoosh index), use `text_for_page` to feed
#    OCR'd text into the index for vector / scanned pages BEFORE indexing.
#    No code change is needed at search time once the index has the text.
#
# 4. The function `_ocr_paddle` assumes paddleocr 2.7.x. If you're on
#    a different version, the result shape may differ slightly:
#       - 2.6.x:  result = [ [poly, (text, conf)], ... ]   (no outer list)
#       - 2.7.x+: result = [ [ [poly, (text, conf)], ... ] ] (per-image)
#    Check `raw[0]` vs `raw` and adjust the `if not raw or not raw[0]`
#    branch accordingly.
#
# 5. If you're on PaddleOCR 3.x with the new `predict()` API, replace
#    _ocr_paddle's body with:
#        result = ocr.predict(input=arr)
#        items = []
#        for r in result:
#            for poly, text, conf in zip(r['rec_polys'], r['rec_texts'],
#                                         r['rec_scores']):
#                items.append((poly.tolist(), text, float(conf)))
#        return items
#
# 6. Performance: rasterizing at 200 DPI is the right default. Bumping to
#    300 DPI catches small fonts but doubles OCR time. If you hit timeout
#    issues on big PDFs, drop to 150 DPI for the /search index pre-build
#    and keep 200 DPI for /extract-regions where accuracy matters more.
#
# 7. Cache! `rasterize_page` and `_ocr_paddle` are pure — memoize per
#    (session_id, page_number) so /extract-regions doesn't re-OCR the
#    same page for every highlight.
