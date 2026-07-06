"""
Structured text pipeline — turns raw PaddleOCR output into a word/line/page
tree with normalized text, reading order, and accurate bounding boxes.

Pipeline:
    PDF page
      ├─ native text layer available  →  PyMuPDF get_text("words")
      │                                  (pdfplumber extract_words fallback)
      └─ scanned page                 →  PaddleOCR → split blocks → words

    words  →  group by y-proximity  →  Lines (sorted left-to-right)
    lines  →  sort top-to-bottom    →  Page (reading order preserved)

All bounding boxes are (x0, y0, x1, y1) in PDF points, top-left origin.
"""

from __future__ import annotations

import gc
import io
import logging
import os
import re
import unicodedata
from dataclasses import dataclass, field

import fitz
import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)

try:
    import pdfplumber
    HAS_PDFPLUMBER = True
except ImportError:
    HAS_PDFPLUMBER = False

# Minimum native words required to skip pixmap OCR on an is_ocr=True page,
# and to skip the vector OCR pass. Tune via env var if needed.
# How many native words a page must yield before we skip pixmap OCR (for
# is_ocr=True pages) and before we skip the vector OCR pass. Set high enough
# that a page whose only native text is a header (20-50 words) still triggers
# OCR for its scanned body. Dense table/report pages (300+ words) safely skip.
_WORD_SKIP_THRESHOLD = int(os.environ.get("PEXL_WORD_SKIP_THRESHOLD", "150"))


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------

def normalize_basic(text: str) -> str:
    """Collapse whitespace + unicode-normalize, preserve case."""
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def normalize_for_search(text: str) -> str:
    """Lowercase + strip combining marks + collapse whitespace + strip edge
    punctuation. This is what goes into the search index.
    Internal punctuation (hyphens in '1234-5678', dots in '226.77') is
    preserved; only leading/trailing punctuation is trimmed so that
    'Date:' indexes as 'date' and 'hello!' matches 'hello'."""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"\s+", " ", text.lower()).strip()
    text = text.strip(".,;:!?()[]{}\"'`$€£¥#*")
    return text


# OCR confusion variants — generated only at query time, not indexed, to
# keep index small. Applied to tokens that contain digits or look numeric.
_OCR_SUBS = {
    "0": ["o", "O", "Q", "D"],
    "o": ["0"],
    "O": ["0"],
    "1": ["l", "I", "|"],
    "l": ["1", "I"],
    "I": ["1", "l"],
    "5": ["S", "s"],
    "S": ["5"],
    "2": ["Z", "z"],
    "8": ["B"],
    "B": ["8"],
    "6": ["G"],
    "G": ["6"],
}


def ocr_variants(token: str, max_variants: int = 8) -> set[str]:
    """Generate alternate spellings for likely OCR confusion chars.
    Used at query time for robust matching without bloating the index."""
    variants = {token}
    norm = normalize_for_search(token)
    variants.add(norm)
    # Only generate numeric-shape variants if the token has any digit
    if any(c.isdigit() for c in token):
        for src, alts in _OCR_SUBS.items():
            if src in token:
                for alt in alts:
                    variants.add(token.replace(src, alt))
                    if len(variants) >= max_variants:
                        return variants
    return variants


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class Word:
    text: str                                    # as-seen (preserves case)
    text_normalized: str                         # lowercase, stripped diacritics
    page: int                                    # 1-based
    bbox: tuple[float, float, float, float]      # (x0, y0, x1, y1) in PDF points
    line_id: int = -1                            # set during line grouping
    source: str = "native"                       # "native" | "ocr"

    @property
    def center_y(self) -> float:
        return (self.bbox[1] + self.bbox[3]) / 2

    @property
    def height(self) -> float:
        return max(1.0, self.bbox[3] - self.bbox[1])

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "page": self.page,
            "bbox": list(self.bbox),
            "line_id": self.line_id,
            "source": self.source,
        }


@dataclass
class Line:
    id: int
    page: int
    words: list[Word] = field(default_factory=list)

    @property
    def text(self) -> str:
        return " ".join(w.text for w in self.words)

    @property
    def text_normalized(self) -> str:
        return " ".join(w.text_normalized for w in self.words)

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        if not self.words:
            return (0.0, 0.0, 0.0, 0.0)
        x0 = min(w.bbox[0] for w in self.words)
        y0 = min(w.bbox[1] for w in self.words)
        x1 = max(w.bbox[2] for w in self.words)
        y1 = max(w.bbox[3] for w in self.words)
        return (x0, y0, x1, y1)


@dataclass
class Page:
    page_num: int                                # 1-based
    width: float                                 # page width in PDF points
    height: float                                # page height in PDF points
    words: list[Word] = field(default_factory=list)   # flat list, reading order
    lines: list[Line] = field(default_factory=list)
    is_ocr: bool = False


# ---------------------------------------------------------------------------
# Native text extraction (PyMuPDF)
# ---------------------------------------------------------------------------

# DocuSign form-field annotation tokens embedded in the native text layer.
# get_text("words") splits them across multiple tokens, so we match the start
# of a tag (e.g. "[text|req|signer1") and any bare "]" that closes one.
_DS_WORD_RE = re.compile(
    r"^\[(?:text|sig|initial|date|checkbox|radio|approve|decline|formula|"
    r"attachment|note|dropdown|hyperlink|payment)[|]",
    re.IGNORECASE,
)


def _is_docusign_token(word: str) -> bool:
    return bool(_DS_WORD_RE.match(word)) or word == "]"


def _extract_native_words(page: fitz.Page) -> list[Word]:
    """Use PyMuPDF's built-in word extraction. Fast, accurate for text PDFs."""
    words: list[Word] = []
    try:
        raw = page.get_text("words") or []
    except Exception:
        return []
    skip_until_close = False
    for tup in raw:
        try:
            x0, y0, x1, y1, text = tup[0], tup[1], tup[2], tup[3], tup[4]
            if not text or not text.strip():
                continue
            t = text.strip()
            # Track multi-token annotations: [text|req|signer1 ... ] spans words
            if _DS_WORD_RE.match(t):
                skip_until_close = not t.endswith("]")
                continue
            if skip_until_close:
                if t.endswith("]"):
                    skip_until_close = False
                continue
            if t == "]":
                continue
            # Skip Doc ID footer line
            if t.startswith("Doc") and "ID" in t:
                continue
            words.append(Word(
                text=text,
                text_normalized=normalize_for_search(text),
                page=page.number + 1,
                bbox=(float(x0), float(y0), float(x1), float(y1)),
                source="native",
            ))
        except Exception:
            continue
    return words


def _extract_pdfplumber_words(plumber_page, page_num: int) -> list[Word]:
    """pdfplumber fallback for native word extraction.

    pdfplumber uses top-left origin (same as PyMuPDF), so x0/top/x1/bottom
    map directly to x0/y0/x1/y1 in PDF points."""
    if plumber_page is None:
        return []
    words: list[Word] = []
    try:
        word_dicts = plumber_page.extract_words(
            x_tolerance=3,
            y_tolerance=3,
            keep_blank_chars=False,
        ) or []
    except Exception:
        return []
    for wd in word_dicts:
        try:
            text = (wd.get("text") or "").strip()
            if not text:
                continue
            if _is_docusign_token(text) or (text.startswith("Doc") and "ID" in text):
                continue
            x0 = float(wd["x0"])
            y0 = float(wd["top"])
            x1 = float(wd["x1"])
            y1 = float(wd["bottom"])
            words.append(Word(
                text=text,
                text_normalized=normalize_for_search(text),
                page=page_num,
                bbox=(x0, y0, x1, y1),
                source="native",
            ))
        except Exception:
            continue
    return words


# ---------------------------------------------------------------------------
# OCR-based extraction (PaddleOCR)
# ---------------------------------------------------------------------------

def _split_ocr_block_into_words(
    text: str,
    bx0: float, by0: float, bx1: float, by1: float,
    page_num: int,
) -> list[Word]:
    """PaddleOCR returns phrase-level boxes. Split into word-level boxes by
    distributing the block width proportionally across character counts."""
    text = text.strip()
    if not text:
        return []

    tokens = text.split()
    if not tokens:
        return []

    if len(tokens) == 1:
        return [Word(
            text=tokens[0],
            text_normalized=normalize_for_search(tokens[0]),
            page=page_num,
            bbox=(bx0, by0, bx1, by1),
            source="ocr",
        )]

    # Allocate width proportional to (chars + 1 for trailing space).
    # Gives roughly visually correct word boxes when chars are monospace-ish.
    units_per_token = [len(t) + 1 for t in tokens]
    total_units = sum(units_per_token) - 1  # last token has no trailing space
    block_w = max(0.1, bx1 - bx0)
    unit_w = block_w / total_units

    words: list[Word] = []
    cursor_x = bx0
    for i, tok in enumerate(tokens):
        tok_w = len(tok) * unit_w
        wx0 = cursor_x
        wx1 = cursor_x + tok_w
        words.append(Word(
            text=tok,
            text_normalized=normalize_for_search(tok),
            page=page_num,
            bbox=(wx0, by0, wx1, by1),
            source="ocr",
        ))
        # advance past token + one unit for space
        cursor_x = wx1 + unit_w
    return words


def _ocr_array_to_words(
    img_arr: np.ndarray,
    page_num: int,
    scale: float,
    ocr_engine,
) -> list[Word]:
    """Run PaddleOCR on a pre-rendered numpy array and return Word objects.

    *scale* is pixels-per-PDF-point so bbox coords can be converted back.
    img_arr is consumed (set to None) before returning.
    """
    if img_arr is None or img_arr.size == 0:
        return []
    try:
        results = ocr_engine.ocr(img_arr, cls=True)
    except Exception as exc:
        logger.warning("Page %d: PaddleOCR failed: %s", page_num, exc)
        return []
    finally:
        img_arr = None  # noqa: F841
        gc.collect()

    if not results or not results[0]:
        return []

    words: list[Word] = []
    for line_item in results[0]:
        try:
            poly, (text, _conf) = line_item[0], line_item[1]
            xs = [p[0] for p in poly]
            ys = [p[1] for p in poly]
            bx0 = min(xs) / scale
            by0 = min(ys) / scale
            bx1 = max(xs) / scale
            by1 = max(ys) / scale
            words.extend(_split_ocr_block_into_words(text, bx0, by0, bx1, by1, page_num))
        except Exception:
            continue
    return words


def _extract_ocr_words(page: fitz.Page, ocr_engine) -> list[Word]:
    """Render the page via PyMuPDF and run PaddleOCR; return word-level entries.

    Pixmap and PIL image are released before the OCR call so that a
    50-page scanned PDF does not accumulate hundreds of MB of raster
    data in memory, which would cause silent OOM failures on page 2+."""
    render_dpi = 150
    scale = render_dpi / 72.0
    page_num = page.number + 1

    # Cap so oversized pages (11×17, 11×22 appraisal sheets) don't produce
    # tensors that exhaust oneDNN primitive buffers ("could not execute a primitive").
    _MAX_OCR_PIXEL_SIDE = 3000

    try:
        pix = page.get_pixmap(dpi=render_dpi)
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        if max(img.width, img.height) > _MAX_OCR_PIXEL_SIDE:
            ratio = _MAX_OCR_PIXEL_SIDE / max(img.width, img.height)
            img = img.resize(
                (int(img.width * ratio), int(img.height * ratio)),
                Image.LANCZOS,
            )
            scale = scale * ratio
        img_arr = np.array(img)
    except Exception as exc:
        logger.warning("Page %d: pixmap render failed: %s", page_num, exc)
        return []
    finally:
        pix = None  # noqa: F841
        img = None  # noqa: F841

    words = _ocr_array_to_words(img_arr, page_num, scale, ocr_engine)
    logger.debug("Page %d pixmap OCR: %d words", page_num, len(words))
    return words


def _extract_vector_ocr_words(page: fitz.Page, ocr_engine) -> list[Word]:
    """Render only the vector drawing layer via matplotlib, then OCR.

    Captures text that is outlined (converted to paths) rather than embedded as
    text operators — these are invisible to get_text() but visible in the
    rendered image.  The scale for bbox conversion uses vector_extract's DPI.
    """
    from vector_extract import render_vector_matplotlib, _RENDER_DPI
    page_num = page.number + 1
    try:
        img_arr = render_vector_matplotlib(page)
    except Exception as exc:
        logger.warning("Page %d: vector matplotlib render failed: %s", page_num, exc)
        return []
    if img_arr is None:
        return []
    scale = _RENDER_DPI / 72.0
    words = _ocr_array_to_words(img_arr, page_num, scale, ocr_engine)
    logger.debug("Page %d vector OCR: %d words", page_num, len(words))
    return words


def _word_bbox_iou(a: Word, b: Word) -> float:
    """Intersection-over-union of two word bounding boxes."""
    ax0, ay0, ax1, ay1 = a.bbox
    bx0, by0, bx1, by1 = b.bbox
    ix0, iy0 = max(ax0, bx0), max(ay0, by0)
    ix1, iy1 = min(ax1, bx1), min(ay1, by1)
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    inter = (ix1 - ix0) * (iy1 - iy0)
    union = (ax1 - ax0) * (ay1 - ay0) + (bx1 - bx0) * (by1 - by0) - inter
    return inter / max(union, 1e-6)


def _merge_word_lists(primary: list[Word], extra: list[Word]) -> list[Word]:
    """Append *extra* words that don't significantly overlap any word in *primary*.

    A word from *extra* is dropped if IoU with any primary word > 0.4 AND their
    normalised texts are similar enough.  This avoids duplicating text that both
    the pixmap OCR and the matplotlib OCR found.
    """
    if not extra:
        return primary
    combined = list(primary)
    for ew in extra:
        ew_text = ew.text.strip().lower()
        dominated = any(
            _word_bbox_iou(ew, pw) > 0.4
            and pw.text.strip().lower() == ew_text
            for pw in primary
        )
        if not dominated:
            combined.append(ew)
    return combined


# ---------------------------------------------------------------------------
# Line grouping + reading order
# ---------------------------------------------------------------------------

def _group_into_lines(words: list[Word]) -> list[Line]:
    """Cluster words into lines by y-center proximity, then sort L→R within
    each line and T→B across lines."""
    if not words:
        return []

    sorted_words = sorted(words, key=lambda w: (w.center_y, w.bbox[0]))

    lines: list[Line] = []
    current_words: list[Word] = []
    current_y: float | None = None
    next_line_id = 0

    for w in sorted_words:
        threshold = max(3.0, w.height * 0.5)
        if current_y is None or abs(w.center_y - current_y) <= threshold:
            current_words.append(w)
            current_y = sum(wd.center_y for wd in current_words) / len(current_words)
        else:
            lines.append(_finalize_line(next_line_id, current_words))
            next_line_id += 1
            current_words = [w]
            current_y = w.center_y

    if current_words:
        lines.append(_finalize_line(next_line_id, current_words))

    # Sort lines top-to-bottom as a final pass (defends against out-of-order input)
    lines.sort(key=lambda ln: ln.bbox[1])
    # Re-number line ids so they're sequential in reading order
    for new_id, ln in enumerate(lines):
        ln.id = new_id
        for w in ln.words:
            w.line_id = new_id
    return lines


def _finalize_line(line_id: int, words: list[Word]) -> Line:
    words.sort(key=lambda w: w.bbox[0])
    for w in words:
        w.line_id = line_id
    return Line(id=line_id, page=words[0].page, words=words)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def build_page(
    page: fitz.Page,
    ocr_engine,
    is_ocr: bool,
    is_vector: bool = False,
    plumber_page=None,
) -> Page:
    """Build a Page for one fitz.Page.

    For native pages (is_ocr=False):
      1. Try PyMuPDF get_text("words")
      2. Fall back to pdfplumber extract_words() if PyMuPDF returns nothing
      3. Fall back to OCR if both native extractors return nothing

    For scanned pages (is_ocr=True):
      - Run PaddleOCR on the pixmap-rendered page

    For vector-rich pages (is_vector=True, may overlap with either above):
      - Additionally render only the vector drawing layer via matplotlib and
        OCR it.  Results are merged with the primary words (deduped by bbox
        IoU) to capture text that is outlined (embedded in paths) rather than
        stored as PDF text operators.
    """
    rect = page.rect
    p = Page(
        page_num=page.number + 1,
        width=rect.width,
        height=rect.height,
        is_ocr=is_ocr,
    )

    if is_ocr:
        # Optimization: for pages classified as needing OCR that also have a
        # native text layer (mixed/vector PDFs like rent rolls, spreadsheet
        # exports), try native extraction first. If it yields enough words the
        # page's text is already intact and the expensive pixmap OCR pass can
        # be skipped entirely. p.is_ocr stays True (set during Page init above)
        # so the overlay cache in make_searchable_pdf still applies.
        native_words = _extract_native_words(page)
        if not native_words and HAS_PDFPLUMBER and plumber_page is not None:
            native_words = _extract_pdfplumber_words(plumber_page, page.number + 1)

        if len(native_words) >= _WORD_SKIP_THRESHOLD:
            words = native_words
            logger.debug("Page %d: %d native words — skipped pixmap OCR",
                         page.number + 1, len(native_words))
        else:
            words = _extract_ocr_words(page, ocr_engine)
    else:
        words = _extract_native_words(page)

        # pdfplumber fallback — handles tagged PDFs, XFA forms, CIDFont encodings
        # that PyMuPDF's get_text("words") silently returns nothing for
        if not words and HAS_PDFPLUMBER and plumber_page is not None:
            words = _extract_pdfplumber_words(plumber_page, page.number + 1)

        # Last resort: OCR the page image
        if not words and ocr_engine is not None:
            words = _extract_ocr_words(page, ocr_engine)
            p.is_ocr = True
        elif ocr_engine is not None:
            # For native pages that embed raster images (e.g. DocuSign form
            # background), labels are baked into the image and never appear in
            # the text layer. Run OCR and append those words so the search index
            # contains both native values AND image-embedded labels.
            try:
                has_images = bool(page.get_images())
            except Exception:
                has_images = False
            if has_images:
                extra = _extract_ocr_words(page, ocr_engine)
                if extra:
                    words = _merge_word_lists(words, extra)

    # Vector pass: render only the drawing layer via matplotlib and OCR it.
    # This surfaces text that is outlined (paths) and invisible to get_text().
    # Skip when the page already has substantial words — vector items on report
    # PDFs (table borders, grid lines) don't contain additional text worth the
    # extra render+OCR cost.
    if is_vector and ocr_engine is not None and len(words) < _WORD_SKIP_THRESHOLD:
        vec_words = _extract_vector_ocr_words(page, ocr_engine)
        if vec_words:
            words = _merge_word_lists(words, vec_words)

    p.lines = _group_into_lines(words)
    # Flat list in reading order: top-to-bottom lines, left-to-right words
    p.words = [w for ln in p.lines for w in ln.words]
    return p


def build_structured_pages(pdf_doc, ocr_engine, force_ocr: bool = False) -> list[Page]:
    """Build structured pages for every page in a PDFDocument.
    Reuses pdf_doc.page_info to pick native vs OCR per page.

    When force_ocr=True every page is treated as scanned regardless of its
    native text layer — use this when the existing text layer is corrupt.

    Opens pdfplumber from the disk path when available (large files) so we
    avoid a second full read of the file into heap memory."""
    doc = pdf_doc.doc
    page_info = getattr(pdf_doc, "page_info", [])

    # Open pdfplumber once for the whole document (native pages only).
    # Prefer the disk path — avoids loading the whole file into memory again.
    pdf_path = getattr(pdf_doc, "pdf_path", None)
    plumber_doc = None
    if HAS_PDFPLUMBER:
        try:
            if pdf_path:
                plumber_doc = pdfplumber.open(pdf_path)
            else:
                pdf_bytes = getattr(pdf_doc, "pdf_bytes", None)
                if pdf_bytes:
                    plumber_doc = pdfplumber.open(io.BytesIO(pdf_bytes))
        except Exception:
            plumber_doc = None

    import time as _time
    _progress = getattr(pdf_doc, "ocr_progress", None)
    try:
        pages: list[Page] = []
        ocr_pages_done = 0
        total_pages = len(doc)
        _build_start = _time.monotonic()

        if _progress is not None:
            _progress["total_pages"] = total_pages
            _progress["current_page"] = 0
            _progress["done"] = False

        for i in range(total_pages):
            info = page_info[i] if i < len(page_info) else {}
            is_ocr   = True if force_ocr else bool(info.get("is_ocr",   False))
            is_vector = bool(info.get("is_vector", False))

            plumber_page = None
            if not is_ocr and plumber_doc is not None:
                try:
                    plumber_page = plumber_doc.pages[i]
                except Exception:
                    plumber_page = None

            _t0 = _time.monotonic()
            try:
                pages.append(build_page(
                    doc[i], ocr_engine, is_ocr,
                    is_vector=is_vector, plumber_page=plumber_page,
                ))
            except Exception as exc:
                logger.warning("Page %d: build_page failed: %s", i + 1, exc)
                rect = doc[i].rect
                pages.append(Page(page_num=i + 1, width=rect.width, height=rect.height, is_ocr=is_ocr))

            _elapsed = _time.monotonic() - _t0
            _total_elapsed = _time.monotonic() - _build_start
            if is_ocr or is_vector or _elapsed > 1.0:
                logger.info("OCR page %d/%d — %.1fs this page, %.1fs total",
                            i + 1, total_pages, _elapsed, _total_elapsed)

            if _progress is not None:
                _progress["current_page"] = i + 1
                _progress["elapsed_sec"] = _total_elapsed

            if is_ocr or is_vector:
                ocr_pages_done += 1
                if ocr_pages_done % 3 == 0:
                    gc.collect()
    finally:
        if plumber_doc is not None:
            try:
                plumber_doc.close()
            except Exception:
                pass

    if _progress is not None:
        _progress["done"] = True
        _progress["elapsed_sec"] = _time.monotonic() - _build_start

    return pages
