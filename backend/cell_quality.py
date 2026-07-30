"""Per-cell extraction diagnostics.

This module is *purely additive*: nothing here changes what a region
extraction returns. It only produces extra metadata describing how much we
should trust a value, so the frontend can point the user at the cells worth
a second look.

Why this exists
---------------
``extract_region`` reports ``confidence="high"`` for any non-empty result and
``"low"`` only when the region came back empty. That makes the flag useless
for the dangerous case: a value that is present, plausible, and *wrong* —
a highlight that clipped ``$1,234.56`` into ``$1,234.``, or an OCR misread.

Two signals are available at extraction time and were previously discarded:

  * **OCR word scores.** The engine already returns a per-word confidence;
    ``ocr_image_array`` dropped it on the floor.
  * **Clip geometry.** If the highlight rectangle cuts *through* a word's
    bounding box, part of that word's text was never read. This is a
    structural fact about the rectangle, independent of what the text says,
    which makes it a high-precision signal for truncated values.

Both are cheap: the scores come free with an OCR pass we already ran, and
the clip check is a handful of rectangle intersections against word boxes
the caller usually has cached already.
"""

from __future__ import annotations

# A word must have at least this fraction of its area inside the rectangle to
# count as "the user meant to capture this word". Mirrors the 15% inclusion
# threshold used by ``_words_in_rect_text`` in main.py so the two agree about
# which words belong to a region.
_MIN_INSIDE_FRAC = 0.15

# ...and at least this fraction outside before we call it a genuine cut.
# Without a floor here, a highlight that merely grazes the whitespace of an
# adjacent word would be reported as clipping it.
_MIN_OUTSIDE_FRAC = 0.15


def ocr_scores(results) -> list[float]:
    """Pull the per-word confidence scores out of a raw OCR result set.

    Accepts the PaddleOCR/RapidOCR result shape — ``[[ (box, (text, score)),
    ... ]]`` — and returns the scores for non-empty words. Malformed or
    score-less entries are skipped rather than raising, because this runs on
    the extraction hot path and must never be the reason a request fails.
    """
    if not results or not results[0]:
        return []
    out: list[float] = []
    for line in results[0]:
        try:
            text, score = line[1][0], line[1][1]
        except (IndexError, TypeError, KeyError):
            continue
        if not str(text).strip():
            continue
        try:
            out.append(float(score))
        except (TypeError, ValueError):
            continue
    return out


def _area(box) -> float:
    """Area of an (x0, y0, x1, y1) box; 0 for degenerate boxes."""
    x0, y0, x1, y1 = box
    return max(0.0, x1 - x0) * max(0.0, y1 - y0)


def _intersection_area(a, b) -> float:
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    ix0, iy0 = max(ax0, bx0), max(ay0, by0)
    ix1, iy1 = min(ax1, bx1), min(ay1, by1)
    return max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)


def clipped_words(rect_box, word_boxes) -> list[str]:
    """Return the text of words the rectangle cuts through.

    ``rect_box`` and each entry of ``word_boxes`` are ``(x0, y0, x1, y1,
    text)``-style tuples — ``word_boxes`` items must be ``(box, text)`` where
    box is a 4-tuple. All coordinates must share one space (PDF points).

    A word counts as *clipped* when a meaningful share of it lies inside the
    rectangle AND a meaningful share lies outside: the user clearly intended
    to capture it, but we only read part of it.
    """
    hits: list[str] = []
    for box, text in word_boxes:
        t = (text or "").strip()
        if not t:
            continue
        total = _area(box)
        if total <= 0:
            continue
        inside = _intersection_area(box, rect_box)
        if inside <= 0:
            continue
        inside_frac = inside / total
        outside_frac = 1.0 - inside_frac
        if inside_frac >= _MIN_INSIDE_FRAC and outside_frac >= _MIN_OUTSIDE_FRAC:
            hits.append(t)
    return hits


def word_boxes_from_cache(cached_words):
    """Adapt cached structured-page ``Word`` objects to ``(box, text)`` pairs."""
    out = []
    if not cached_words:
        return out
    for w in cached_words:
        try:
            box = tuple(float(v) for v in w.bbox)
        except (AttributeError, TypeError, ValueError):
            continue
        if len(box) != 4:
            continue
        out.append((box, getattr(w, "text", "") or ""))
    return out


def word_boxes_from_page(page):
    """Adapt a PyMuPDF page's native text layer to ``(box, text)`` pairs.

    Returns an empty list when the page has no text layer (scanned pages),
    which correctly means "no clip evidence available from native text".
    """
    try:
        words = page.get_text("words") or []
    except Exception:
        return []
    out = []
    for w in words:
        try:
            box = (float(w[0]), float(w[1]), float(w[2]), float(w[3]))
        except (IndexError, TypeError, ValueError):
            continue
        out.append((box, w[4] if len(w) > 4 else ""))
    return out


def assess_region(
    *,
    rect_box,
    page=None,
    cached_words=None,
    scores: list[float] | None = None,
) -> dict:
    """Build the diagnostic payload for one extracted region.

    Every key is optional from the frontend's point of view — this is extra
    information layered onto an unchanged result, never a replacement for it.

    Returns a dict with:
      ``ocr_score``      lowest word score for the region (the weakest link
                         is what matters — one bad digit ruins an amount),
                         or None when the value did not come from OCR.
      ``ocr_score_avg``  mean word score, for context.
      ``clipped``        True when the rectangle cuts through a word.
      ``clipped_text``   the words that were cut, for the review UI.
    """
    payload: dict = {}

    if scores:
        payload["ocr_score"] = round(min(scores), 4)
        payload["ocr_score_avg"] = round(sum(scores) / len(scores), 4)

    # Prefer cached OCR words (present for scanned docs the indexer has
    # already processed); fall back to the native text layer.
    boxes = word_boxes_from_cache(cached_words)
    if not boxes and page is not None:
        boxes = word_boxes_from_page(page)

    if boxes:
        cut = clipped_words(rect_box, boxes)
        if cut:
            payload["clipped"] = True
            # Cap the echo — a pathological rectangle could straddle dozens.
            payload["clipped_text"] = cut[:5]

    return payload
