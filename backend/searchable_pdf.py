"""
Build a 'searchable' PDF by overlaying an invisible OCR text layer on
scanned pages. Native pages pass through unchanged. Result: users can
select, copy, and search text in the downloaded PDF.

Also strips copy restrictions / encryption from the output.
"""

from __future__ import annotations

import gc
import logging
import traceback

import fitz
import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)

# Tuneable limits — keep memory use predictable per page
MAX_PIXELS = 25_000_000         # skip OCR on pages that would exceed ~25Mpix
RENDER_DPI = 150                # lower than before; OCR still works well at 150
MIN_FONTSIZE = 1.0

_FULL_PERMISSIONS = int(
    fitz.PDF_PERM_COPY
    | fitz.PDF_PERM_PRINT
    | fitz.PDF_PERM_MODIFY
    | fitz.PDF_PERM_ANNOTATE
    | fitz.PDF_PERM_FORM
    | fitz.PDF_PERM_ACCESSIBILITY
    | fitz.PDF_PERM_ASSEMBLE
    | fitz.PDF_PERM_PRINT_HQ
)


def _sanitize_for_helv(text: str) -> str:
    """The built-in helv font can only render Latin-1. Non-representable
    chars are replaced with a space so insert_text doesn't silently
    substitute a dot or fail."""
    try:
        text.encode("latin-1")
        return text
    except (UnicodeEncodeError, UnicodeDecodeError):
        return "".join(c if ord(c) < 0x100 else " " for c in text)


def _save_with_full_permissions(doc: fitz.Document) -> bytes:
    """Save PDF bytes with encryption stripped and all permissions granted."""
    try:
        return doc.tobytes(
            garbage=4,
            deflate=True,
            encryption=fitz.PDF_ENCRYPT_NONE,
            permissions=_FULL_PERMISSIONS,
        )
    except Exception as exc:
        logger.warning("Save with permissions failed (%s); retrying without opts", exc)
        # Last-ditch: save without special options
        return doc.tobytes()


def _overlay_ocr_on_page(page: fitz.Page, ocr_engine) -> bool:
    """Render, OCR, embed invisible text on one page.
    Returns True on success, False on any failure. Never raises."""
    try:
        rect = page.rect
        # Skip insanely large pages that would OOM rendering
        est_pixels = (rect.width * RENDER_DPI / 72.0) * (rect.height * RENDER_DPI / 72.0)
        dpi = RENDER_DPI
        if est_pixels > MAX_PIXELS:
            dpi = max(72, int(RENDER_DPI * (MAX_PIXELS / est_pixels) ** 0.5))

        # OCR with one automatic retry at half-DPI when Paddle reports a
        # primitive failure — the error is almost always memory pressure,
        # and rendering smaller usually clears it.
        results = None
        last_exc: Exception | None = None
        for attempt_dpi in (dpi, max(72, dpi // 2)):
            scale = attempt_dpi / 72.0
            pix = page.get_pixmap(dpi=attempt_dpi)
            try:
                # Pixmap may be RGBA, grayscale, or CMYK depending on the
                # page; convert to a known-RGB layout before handing to OCR.
                if pix.n != 3 or pix.alpha:
                    rgb_pix = fitz.Pixmap(fitz.csRGB, pix)
                    pix = None
                    img = Image.frombytes("RGB", [rgb_pix.width, rgb_pix.height], rgb_pix.samples)
                    rgb_pix = None
                else:
                    img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
                    pix = None
                img_arr = np.array(img)
                img = None
            except Exception as exc:
                logger.warning("Pixmap conversion failed at %d dpi: %s", attempt_dpi, exc)
                last_exc = exc
                continue
            try:
                results = ocr_engine.ocr(img_arr, cls=True)
                last_exc = None
                break
            except Exception as exc:
                msg = str(exc)
                last_exc = exc
                logger.warning("PaddleOCR failed at %d dpi: %s", attempt_dpi, msg)
                # Retry at lower DPI only if the failure looks memory-related
                if "could not execute a primitive" not in msg and "out of memory" not in msg.lower():
                    break
            finally:
                img_arr = None
                gc.collect()

        if last_exc is not None or results is None:
            return False

        # PaddleOCR 2.x returns [[detections]] (per-image list); a few
        # builds drop the outer list and return [detections] directly.
        detections = None
        if results:
            if isinstance(results[0], list):
                detections = results[0]
            else:
                detections = results
        if not detections:
            logger.info("Page overlay: PaddleOCR returned 0 detections")
            return True  # nothing to add, not a failure

        inserted = 0
        skipped = 0
        for line in detections:
            try:
                poly, (text, _conf) = line[0], line[1]
                if not text or not text.strip():
                    continue

                text = _sanitize_for_helv(text)
                if not text.strip():
                    continue

                xs = [p[0] for p in poly]
                ys = [p[1] for p in poly]
                x0 = min(xs) / scale
                y0 = min(ys) / scale
                x1 = max(xs) / scale
                y1 = max(ys) / scale

                rect_w = max(1.0, x1 - x0)
                rect_h = max(1.0, y1 - y0)
                fontsize = rect_h * 0.8
                approx_w = fontsize * 0.5 * len(text)
                if approx_w > rect_w:
                    fontsize *= rect_w / approx_w
                fontsize = max(MIN_FONTSIZE, fontsize)

                page.insert_text(
                    (x0, y1),
                    text,
                    fontsize=fontsize,
                    render_mode=3,  # invisible
                )
                inserted += 1
            except Exception:
                skipped += 1
                continue

        logger.info("Page overlay: %d detections → %d inserted, %d skipped",
                    len(detections), inserted, skipped)
        return True

    except Exception:
        logger.warning("Page overlay crashed:\n%s", traceback.format_exc())
        return False


def _build_image_only_searchable_pdf(pdf_doc, ocr_engine) -> bytes:
    """Build a *new* PDF where every page is a rendered image of the original
    overlaid with an invisible OCR text layer — and nothing else.

    Why this exists: some source PDFs contain unicode glyphs that the native
    text layer represents with broken/private-use codepoints, or text drawn
    as vector paths (no recoverable codepoints at all). Both make
    ``page.get_text()`` return garbage that breaks selection, search, and
    every downstream extractor.

    By rebuilding the document from rasterised images we throw away the
    original text content entirely. The OCR pass then operates on pure
    pixels, sidestepping the native text layer's encoding problems. Result:
    every page is a clean image + OCR-derived text positioned over each
    word. Selection, highlighting, and the table-region extractor all then
    see the OCR text directly.

    Trade-offs: output file size grows (the page is now an image), and the
    overlay accuracy is bounded by PaddleOCR. For PDFs whose native text
    layer is already correct, ``make_searchable_pdf(..., image_only=False)``
    preserves the original text and is preferred.
    """
    pdf_path = getattr(pdf_doc, "pdf_path", None)
    try:
        if pdf_path:
            src = fitz.open(pdf_path)
        else:
            src = fitz.open(stream=pdf_doc.pdf_bytes, filetype="pdf")
    except Exception:
        logger.error("image-only: failed to open source PDF:\n%s", traceback.format_exc())
        raw = pdf_doc.pdf_bytes
        return raw if raw else b""

    new_doc = fitz.open()
    try:
        if src.is_encrypted:
            try: src.authenticate("")
            except Exception: pass

        total = len(src)
        for page_idx in range(total):
            page = src[page_idx]

            # ── Always materialise the page in the output, even if OCR later
            # fails. The first thing we do is render it and add it to new_doc;
            # OCR text gets layered on top afterwards. If OCR throws we keep
            # going to the next page rather than aborting the whole pass.
            new_page = None
            pix = None
            scale = 1.0
            ocr_arr = None

            try:
                est_pixels = (page.rect.width * RENDER_DPI / 72.0) * (page.rect.height * RENDER_DPI / 72.0)
                dpi = RENDER_DPI if est_pixels <= MAX_PIXELS else max(72, int(RENDER_DPI * (MAX_PIXELS / est_pixels) ** 0.5))
                pix = page.get_pixmap(dpi=dpi)
                if pix.n != 3 or pix.alpha:
                    pix = fitz.Pixmap(fitz.csRGB, pix)
                new_page = new_doc.new_page(width=page.rect.width, height=page.rect.height)
                new_page.insert_image(new_page.rect, stream=pix.tobytes("jpeg", jpg_quality=85))
                scale = dpi / 72.0
            except Exception:
                logger.warning("image-only: page %d/%d render failed:\n%s",
                               page_idx + 1, total, traceback.format_exc())
                # Couldn't render → no OCR possible for this page either.
                # Add a blank page so page count matches the source.
                try:
                    new_doc.new_page(width=page.rect.width, height=page.rect.height)
                except Exception:
                    pass
                continue

            # Reuse OCR results from the background index build when available.
            # build_structured_pages already ran OCR on scanned pages and stored
            # Word objects (bbox in PDF points) in pdf_doc.structured_pages.
            # Using them here skips a full second OCR pass — the primary speedup.
            # Only reuse for is_ocr pages; native-text pages in image_only mode
            # need a fresh OCR pass since their cached words came from the native
            # text layer which may be garbled (the whole reason image_only exists).
            _sp = getattr(pdf_doc, 'structured_pages', None)
            _cp = _sp[page_idx] if _sp and page_idx < len(_sp) else None
            if _cp is not None and _cp.is_ocr and _cp.words:
                pix = None
                _ins = 0
                for _w in _cp.words:
                    _wt = (_w.text or "").strip()
                    if not _wt:
                        continue
                    _wt = _sanitize_for_helv(_wt)
                    if not _wt.strip():
                        continue
                    _x0, _y0, _x1, _y1 = _w.bbox
                    _rh = max(1.0, _y1 - _y0)
                    _rw = max(1.0, _x1 - _x0)
                    _fs = _rh * 0.8
                    _aw = _fs * 0.5 * len(_wt)
                    if _aw > _rw:
                        _fs *= _rw / _aw
                    _fs = max(MIN_FONTSIZE, _fs)
                    try:
                        new_page.insert_text((_x0, _y1), _wt, fontsize=_fs, render_mode=3)
                        _ins += 1
                    except Exception:
                        continue
                logger.info("image-only: page %d/%d → %d cached words (OCR skipped)",
                            page_idx + 1, total, _ins)
                if (page_idx + 1) % 5 == 0:
                    gc.collect()
                continue

            # Build numpy array for OCR. If this fails, skip OCR (the image
            # is already in new_doc) and move on.
            try:
                img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
                ocr_arr = np.array(img)
                img = None
            except Exception:
                logger.warning("image-only: page %d/%d image→array failed",
                               page_idx + 1, total)
                pix = None
                gc.collect()
                continue
            finally:
                pix = None  # release rendered pixmap memory before OCR

            # ── OCR with one half-DPI retry on transient failure. The user
            # explicitly wants OCR to be attempted on every page; we never
            # short-circuit a later page because an earlier one failed.
            results = None
            last_exc: Exception | None = None
            for attempt in range(2):
                try:
                    results = ocr_engine.ocr(ocr_arr, cls=True)
                    last_exc = None
                    break
                except Exception as exc:
                    last_exc = exc
                    msg = str(exc)
                    logger.warning("image-only: PaddleOCR failed page %d/%d attempt %d (dpi≈%d): %s",
                                   page_idx + 1, total, attempt + 1, int(scale * 72), msg)
                    if attempt == 0 and (
                        "could not execute a primitive" in msg
                        or "out of memory" in msg.lower()
                        or "memory" in msg.lower()
                    ):
                        # Re-render at half DPI and retry once
                        try:
                            half_dpi = max(72, int(scale * 72) // 2)
                            re_pix = page.get_pixmap(dpi=half_dpi)
                            if re_pix.n != 3 or re_pix.alpha:
                                re_pix = fitz.Pixmap(fitz.csRGB, re_pix)
                            re_img = Image.frombytes("RGB", [re_pix.width, re_pix.height], re_pix.samples)
                            ocr_arr = np.array(re_img)
                            scale = half_dpi / 72.0
                            re_pix = None
                            re_img = None
                            gc.collect()
                            continue
                        except Exception:
                            logger.warning("image-only: half-DPI retry render failed page %d", page_idx + 1)
                            break
                    break
            ocr_arr = None
            gc.collect()

            if results is None or last_exc is not None:
                # OCR failed for this page; image is already in new_doc.
                # Move on — DO NOT abort the pass for remaining pages.
                logger.info("image-only: page %d/%d → image only, OCR failed", page_idx + 1, total)
                continue

            # Detection-shape normalisation: PaddleOCR may return either
            # [[detections]] or [detections] depending on the build.
            detections = None
            if results:
                detections = results[0] if isinstance(results[0], list) else results

            inserted = 0
            if detections:
                for line in detections:
                    try:
                        poly, (text, _conf) = line[0], line[1]
                        if not text or not text.strip():
                            continue
                        text = _sanitize_for_helv(text)
                        if not text.strip():
                            continue
                        xs = [p[0] for p in poly]
                        ys = [p[1] for p in poly]
                        x0 = min(xs) / scale
                        y0 = min(ys) / scale
                        x1 = max(xs) / scale
                        y1 = max(ys) / scale

                        rect_w = max(1.0, x1 - x0)
                        rect_h = max(1.0, y1 - y0)
                        fontsize = rect_h * 0.8
                        approx_w = fontsize * 0.5 * len(text)
                        if approx_w > rect_w:
                            fontsize *= rect_w / approx_w
                        fontsize = max(MIN_FONTSIZE, fontsize)

                        new_page.insert_text(
                            (x0, y1),
                            text,
                            fontsize=fontsize,
                            render_mode=3,  # invisible
                        )
                        inserted += 1
                    except Exception:
                        continue

            logger.info("image-only: page %d/%d → %d OCR words inserted",
                        page_idx + 1, total, inserted)

            if (page_idx + 1) % 5 == 0:
                gc.collect()

        return _save_with_full_permissions(new_doc)
    except Exception:
        logger.error("image-only: fatal error:\n%s", traceback.format_exc())
        try:
            return _save_with_full_permissions(new_doc)
        except Exception:
            raw = pdf_doc.pdf_bytes
            return raw if raw else b""
    finally:
        try: new_doc.close()
        except Exception: pass
        try: src.close()
        except Exception: pass
        gc.collect()


def make_searchable_pdf_for_page(pdf_doc, ocr_engine, page_index: int) -> bytes:
    """Build a *single-page* searchable PDF for just ``page_index`` of the
    source document. The returned bytes contain exactly one page — the
    rendered image of the source page overlaid with invisible OCR text.

    Use this from the region-extraction path when only one page of a
    multi-page document needs to be OCR'd. A full-document OCR pass on a
    20-page bill can run for several minutes and trip the front-end's
    proxy timeout (Nginx default 60s → 504). Per-page OCR keeps the
    request well under a second-or-two when only one page is in play.

    The output page is page 1 of the returned PDF — callers that derive
    coordinates against the source need to remap. The function never
    raises: on any internal failure it falls back to the original PDF
    bytes so the caller can degrade gracefully.
    """
    pdf_path = getattr(pdf_doc, "pdf_path", None)
    try:
        if pdf_path:
            src = fitz.open(pdf_path)
        else:
            src = fitz.open(stream=pdf_doc.pdf_bytes, filetype="pdf")
    except Exception:
        logger.error("per-page: failed to open source PDF:\n%s", traceback.format_exc())
        raw = pdf_doc.pdf_bytes
        return raw if raw else b""

    new_doc = fitz.open()
    try:
        if src.is_encrypted:
            try: src.authenticate("")
            except Exception: pass

        if page_index < 0 or page_index >= len(src):
            raise IndexError(f"page_index {page_index} out of range (0..{len(src)})")

        page = src[page_index]
        est_pixels = (page.rect.width * RENDER_DPI / 72.0) * (page.rect.height * RENDER_DPI / 72.0)
        dpi = RENDER_DPI if est_pixels <= MAX_PIXELS else max(72, int(RENDER_DPI * (MAX_PIXELS / est_pixels) ** 0.5))

        # Render → insert image into the fresh single-page doc
        pix = page.get_pixmap(dpi=dpi)
        if pix.n != 3 or pix.alpha:
            pix = fitz.Pixmap(fitz.csRGB, pix)
        new_page = new_doc.new_page(width=page.rect.width, height=page.rect.height)
        new_page.insert_image(new_page.rect, stream=pix.tobytes("jpeg", jpg_quality=85))

        # Build numpy array for OCR
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        ocr_arr = np.array(img)
        img = None
        pix = None
        scale = dpi / 72.0

        # OCR with one half-DPI retry on transient failure
        results = None
        for attempt in range(2):
            try:
                results = ocr_engine.ocr(ocr_arr, cls=True)
                break
            except Exception as exc:
                msg = str(exc)
                logger.warning("per-page: PaddleOCR failed page %d attempt %d (dpi≈%d): %s",
                               page_index + 1, attempt + 1, int(scale * 72), msg)
                if attempt == 0 and (
                    "could not execute a primitive" in msg
                    or "out of memory" in msg.lower()
                    or "memory" in msg.lower()
                ):
                    try:
                        half_dpi = max(72, int(scale * 72) // 2)
                        re_pix = page.get_pixmap(dpi=half_dpi)
                        if re_pix.n != 3 or re_pix.alpha:
                            re_pix = fitz.Pixmap(fitz.csRGB, re_pix)
                        re_img = Image.frombytes("RGB", [re_pix.width, re_pix.height], re_pix.samples)
                        ocr_arr = np.array(re_img)
                        scale = half_dpi / 72.0
                        re_pix = None
                        re_img = None
                        gc.collect()
                        continue
                    except Exception:
                        logger.warning("per-page: half-DPI retry render failed page %d", page_index + 1)
                        break
                break
        ocr_arr = None
        gc.collect()

        if results is None:
            return _save_with_full_permissions(new_doc)

        # Detection-shape normalisation
        detections = None
        if results:
            detections = results[0] if isinstance(results[0], list) else results

        inserted = 0
        if detections:
            for line in detections:
                try:
                    poly, (text, _conf) = line[0], line[1]
                    if not text or not text.strip():
                        continue
                    text = _sanitize_for_helv(text)
                    if not text.strip():
                        continue
                    xs = [p[0] for p in poly]
                    ys = [p[1] for p in poly]
                    x0 = min(xs) / scale
                    y0 = min(ys) / scale
                    x1 = max(xs) / scale
                    y1 = max(ys) / scale
                    rect_w = max(1.0, x1 - x0)
                    rect_h = max(1.0, y1 - y0)
                    fontsize = rect_h * 0.8
                    approx_w = fontsize * 0.5 * len(text)
                    if approx_w > rect_w:
                        fontsize *= rect_w / approx_w
                    fontsize = max(MIN_FONTSIZE, fontsize)
                    new_page.insert_text(
                        (x0, y1),
                        text,
                        fontsize=fontsize,
                        render_mode=3,
                    )
                    inserted += 1
                except Exception:
                    continue

        logger.info("per-page: page %d → %d OCR words inserted", page_index + 1, inserted)
        return _save_with_full_permissions(new_doc)
    except Exception:
        logger.error("per-page: fatal error on page %d:\n%s", page_index + 1, traceback.format_exc())
        try:
            return _save_with_full_permissions(new_doc)
        except Exception:
            raw = pdf_doc.pdf_bytes
            return raw if raw else b""
    finally:
        try: new_doc.close()
        except Exception: pass
        try: src.close()
        except Exception: pass
        gc.collect()


def make_searchable_pdf(
    pdf_doc,
    ocr_engine,
    force_all_pages: bool = False,
    image_only: bool = False,
) -> bytes:
    """Return PDF bytes with invisible OCR text embedded.

    Three modes:
      • ``image_only=True``: completely rebuild the PDF — each page becomes
        a rendered image overlaid with OCR text. The original text layer is
        discarded entirely. Use when the source has broken UTF characters,
        vector-as-paths text, or any other situation where ``get_text()``
        produces garbage. OCR runs on every page unconditionally in this
        mode.
      • Default (``force_all_pages=False``): only pages flagged scanned /
        mixed / form / vector get an OCR overlay; native pages pass
        through unchanged so accurate native text is preserved.
      • ``force_all_pages=True``: overlay OCR on every page regardless of
        classification — but the original text layer is *kept* alongside.

    Always strips copy restrictions. Never raises — on any error, returns
    the best PDF it can produce (at minimum the source, unlocked).
    """
    if image_only:
        return _build_image_only_searchable_pdf(pdf_doc, ocr_engine)
    pdf_path = getattr(pdf_doc, "pdf_path", None)
    try:
        if pdf_path:
            doc = fitz.open(pdf_path)
        else:
            doc = fitz.open(stream=pdf_doc.pdf_bytes, filetype="pdf")
    except Exception:
        logger.error("Failed to open source PDF:\n%s", traceback.format_exc())
        raw = pdf_doc.pdf_bytes
        return raw if raw else b""

    # ── Rotation auto-route ────────────────────────────────────────────────
    # `_overlay_ocr_on_page` writes invisible text into the SOURCE page using
    # OCR coords derived from `get_pixmap()` (which produces the *display*
    # orientation). PyMuPDF's `insert_text`, however, places glyphs in the
    # page's PHYSICAL coordinate system — and when page.rotation != 0, those
    # two spaces diverge. Result: OCR text lands somewhere off-screen and
    # highlight / table-region extraction find nothing.
    #
    # The image-only rebuild builds fresh upright pages with rotation=0, so
    # display == physical and the same insert_text math works correctly.
    # Cheaper to route there than to transform every detection through
    # page.derotation_matrix.
    try:
        if any(doc[i].rotation % 360 for i in range(len(doc))):
            logger.info(
                "Source PDF has rotated page(s); rebuilding upright via image-only path "
                "to keep OCR text coordinates correct."
            )
            doc.close()
            return _build_image_only_searchable_pdf(pdf_doc, ocr_engine)
    except Exception:
        # Worst case: fall through to the in-place overlay path below.
        pass

    try:
        if doc.is_encrypted:
            try:
                doc.authenticate("")
            except Exception:
                pass

        page_info = getattr(pdf_doc, "page_info", [])
        ocr_pages_done = 0

        # Circuit breaker: if the OCR engine fails on N pages in a row, give
        # up and return the document with whatever overlays we managed so
        # far. Better than chewing through 200 pages of a wedged engine.
        consecutive_failures = 0
        FAILURE_LIMIT = 5
        ocr_aborted = False

        for page_idx in range(len(doc)):
            if ocr_aborted:
                break
            info = page_info[page_idx] if page_idx < len(page_info) else {}
            if not force_all_pages and not info.get("is_ocr", False) and not info.get("is_vector", False):
                continue

            try:
                page = doc[page_idx]
                ok = _overlay_ocr_on_page(page, ocr_engine)
                ocr_pages_done += 1
                logger.info(
                    "Searchable PDF: page %d/%d overlay %s",
                    page_idx + 1, len(doc), "OK" if ok else "FAILED",
                )
                if ok:
                    consecutive_failures = 0
                else:
                    consecutive_failures += 1
                    if consecutive_failures >= FAILURE_LIMIT:
                        logger.error(
                            "OCR engine appears wedged (%d consecutive failures). "
                            "Aborting overlay pass and returning document as-is.",
                            consecutive_failures,
                        )
                        ocr_aborted = True
            except Exception:
                logger.warning("Skipping page %d overlay:\n%s", page_idx, traceback.format_exc())
                consecutive_failures += 1
                continue

            if ocr_pages_done % 5 == 0:
                gc.collect()

        logger.info("Searchable PDF: overlaid %d/%d pages (force=%s)",
                    ocr_pages_done, len(doc), force_all_pages)

        return _save_with_full_permissions(doc)

    except Exception:
        logger.error("make_searchable_pdf fatal error:\n%s", traceback.format_exc())
        try:
            return _save_with_full_permissions(doc)
        except Exception:
            raw = pdf_doc.pdf_bytes
            return raw if raw else b""
    finally:
        try:
            doc.close()
        except Exception:
            pass
        gc.collect()
