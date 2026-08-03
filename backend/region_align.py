"""Recover extraction regions whose page drifted a few millimetres.

The problem
-----------
Highlights drawn on one document and applied to another (the normal batch
workflow) can miss by a few millimetres: a header block one line taller pushes
everything below it down, and a box that used to sit on "Ending Balance" now
sits between two lines, clips it, or — worst — lands squarely on the next row
and reads a different amount that looks perfectly valid.

Two techniques, used only on regions already flagged as suspect
---------------------------------------------------------------
**Gutter-bounded expansion** (primary). Rather than estimating how far the page
moved, give the region slack and wall it in::

    ────────────────────  line above   ← never entered
         (gutter)                      ← region may grow into this
    ██████ target line ██████          ← the only thing extracted
         (gutter)                      ← region may grow into this
    ────────────────────  line below   ← never entered

A few-mm drift can no longer push the target outside the region, while a
neighbouring line is structurally incapable of entering it. There is never a
"which of these lines did they mean?" decision to get wrong.

The target line is chosen by how much of its *ink* the region covers — a line's
boundaries are the min/max of its words' boxes, so those are real glyph edges,
not estimates. This matters when a box laps a line halfway: "any overlap at
all" would also adopt the neighbour it clips by a sliver and stretch the band
across two rows. Coverage-based selection snaps to the line the box is mostly
on and leaves the grazed one as a wall.

**Page consensus offset** (fallback). When expansion cannot find a confident
target, estimate one shift for the whole page: try candidate offsets and keep
the one that lands the most regions cleanly on text. The page's other regions
vote, so an individually ambiguous box is resolved by its neighbours.

Limitation, by construction: expansion corrects drift up to about one gutter —
a few mm on a typical statement. A shift beyond half the line pitch moves the
target past a wall, which is what the consensus offset is there to catch, and
why every corrected value is reported as changed rather than trusted silently.
"""

from __future__ import annotations

# Keep a hair of clearance from the neighbouring lines. Descenders (g, y, p)
# and OCR bounding-box slop mean a neighbour's ink can sit slightly outside its
# reported box; touching the wall exactly risks catching a stray descender and
# turning a clean number into noise.
_WALL_MARGIN = 1.0  # PDF points (~0.35 mm)

# Two words belong to the same line when their vertical centres are closer than
# this multiple of the median glyph height. Mirrors the row clustering in
# table_calibrate._detect_rows so the two agree about what a "line" is.
_LINE_TOL_FRAC = 0.6

# A line counts as *targeted* only when the region covers at least this share
# of its ink. Below it the line is merely grazed and stays a wall.
_MIN_LINE_COVERAGE = 0.5

# A region whose centre sits more than this multiple of a line height away from
# the line it actually read was probably aimed at a different row.
_DRIFT_FLAG_FRAC = 0.55

# Smallest page shift worth reporting, in PDF points (~0.7 mm). Below this the
# "drift" is just how imprecisely the box was drawn, not the page moving.
_MIN_MEANINGFUL_SHIFT = 2.0


class Line:
    __slots__ = ("y0", "y1", "words")

    def __init__(self, y0: float, y1: float, words: list):
        self.y0 = y0
        self.y1 = y1
        self.words = words

    @property
    def center(self) -> float:
        return (self.y0 + self.y1) / 2.0

    @property
    def height(self) -> float:
        return max(self.y1 - self.y0, 1e-6)


def cluster_lines(word_boxes) -> list[Line]:
    """Group ``(box, text)`` pairs into text lines, ordered top to bottom.

    ``box`` is ``(x0, y0, x1, y1)``. Grouping is by vertical-centre proximity,
    which tolerates the small baseline jitter OCR produces.
    """
    items = []
    for box, text in word_boxes:
        if not (text or "").strip():
            continue
        x0, y0, x1, y1 = box
        if y1 <= y0:
            continue
        items.append((((y0 + y1) / 2.0), y0, y1, box, text))
    if not items:
        return []

    heights = sorted(y1 - y0 for _, y0, y1, _, _ in items)
    med_h = heights[len(heights) // 2] or 10.0
    tol = med_h * _LINE_TOL_FRAC

    items.sort(key=lambda it: it[0])
    lines: list[Line] = []
    cur: list = [items[0]]
    for it in items[1:]:
        if it[0] - cur[-1][0] <= tol:
            cur.append(it)
        else:
            lines.append(_make_line(cur))
            cur = [it]
    lines.append(_make_line(cur))
    return lines


def _make_line(group: list) -> Line:
    y0 = min(g[1] for g in group)
    y1 = max(g[2] for g in group)
    return Line(y0, y1, [(g[3], g[4]) for g in group])


def _overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def _target_lines(rect_box, lines: list[Line]):
    """Pick the line(s) a region is aiming at, plus a note on how we decided.

    Returns ``(indices, note)``; ``indices`` is empty when nothing is close
    enough to act on.
    """
    _x0, y0, _x1, y1 = rect_box

    coverage = [
        (i, _overlap(y0, y1, ln.y0, ln.y1) / ln.height)
        for i, ln in enumerate(lines)
    ]

    solid = [i for i, c in coverage if c >= _MIN_LINE_COVERAGE]
    if solid:
        return solid, None

    best_i, best_c = max(coverage, key=lambda t: t[1])
    if best_c > 0:
        # The region straddles a boundary — part on a line, part in the gutter —
        # without properly covering any line. The line it overlaps most is what
        # was aimed at; snap to that line in full.
        return [best_i], "partial"

    # No overlap at all: the region drifted into a gutter. Adopt the nearest
    # line, but only within ~1.5 line heights, so a badly misplaced box is left
    # alone rather than teleported somewhere unrelated.
    centre = (y0 + y1) / 2.0
    nearest = min(range(len(lines)), key=lambda i: abs(lines[i].center - centre))
    if abs(lines[nearest].center - centre) > lines[nearest].height * 1.5:
        return [], None
    return [nearest], "empty"


def align_rect_to_lines(rect_box, lines: list[Line], *, expand_horizontally: bool = True):
    """Return ``(new_rect, info)`` for a region snapped to its target line(s).

    ``new_rect`` is ``(x0, y0, x1, y1)``. When there is nothing to act on the
    original rect comes back unchanged with ``info["realigned"] is False``.
    """
    x0, y0, x1, y1 = rect_box
    info: dict = {"realigned": False}
    if not lines:
        return rect_box, info

    touched, note = _target_lines(rect_box, lines)
    if not touched:
        return rect_box, info
    if note:
        info[f"recovered_{note}"] = True

    first, last = touched[0], touched[-1]

    # Walls: the neighbouring lines, which the region must never enter.
    top_wall = lines[first - 1].y1 + _WALL_MARGIN if first > 0 else None
    bottom_wall = lines[last + 1].y0 - _WALL_MARGIN if last + 1 < len(lines) else None

    new_y0 = top_wall if top_wall is not None else min(y0, lines[first].y0)
    new_y1 = bottom_wall if bottom_wall is not None else max(y1, lines[last].y1)

    # A wall must never clip the text it is protecting.
    new_y0 = min(new_y0, lines[first].y0)
    new_y1 = max(new_y1, lines[last].y1)

    new_x0, new_x1 = x0, x1
    if expand_horizontally:
        # Complete the words the ORIGINAL region already touches. A word from a
        # neighbouring column does not intersect it, so it cannot be pulled in.
        for ln in lines[first:last + 1]:
            for (wx0, wy0, wx1, wy1), _text in ln.words:
                if _overlap(x0, x1, wx0, wx1) > 0 and _overlap(y0, y1, wy0, wy1) > 0:
                    new_x0 = min(new_x0, wx0)
                    new_x1 = max(new_x1, wx1)

    if (abs(new_y0 - y0) > 0.01 or abs(new_y1 - y1) > 0.01
            or abs(new_x0 - x0) > 0.01 or abs(new_x1 - x1) > 0.01):
        info["realigned"] = True
        info["dy_top"] = round(new_y0 - y0, 2)
        info["dy_bottom"] = round(new_y1 - y1, 2)
        info["dx_left"] = round(new_x0 - x0, 2)
        info["dx_right"] = round(new_x1 - x1, 2)
        info["lines_covered"] = len(touched)

    return (new_x0, new_y0, new_x1, new_y1), info


def rect_drift(rect_box, lines: list[Line]) -> float | None:
    """Signed distance from the region's centre to the centre of the line it
    actually reads, in units of that line's height.

    This is the cheap geometric tell for the dangerous failure: a region that
    landed squarely on the *wrong* row returns a perfectly valid-looking value
    and would otherwise never be questioned. Returns None when no line is
    close enough to judge.
    """
    if not lines:
        return None
    touched, _note = _target_lines(rect_box, lines)
    if not touched:
        return None
    _x0, y0, _x1, y1 = rect_box
    centre = (y0 + y1) / 2.0
    ln = lines[touched[0]]
    return (ln.center - centre) / ln.height


def is_drifted(rect_box, lines: list[Line]) -> bool:
    d = rect_drift(rect_box, lines)
    return d is not None and abs(d) >= _DRIFT_FLAG_FRAC


def page_consensus_offset(
    rect_boxes,
    lines: list[Line],
    *,
    max_shift: float = 28.0,   # PDF points ≈ 10 mm
    step: float = 1.0,
) -> tuple[float, float]:
    """Estimate one vertical shift for a whole page by majority vote.

    For each candidate ``dy`` we ask how many regions would land cleanly on a
    text line, and keep the best. The page's regions vote together, so a box
    that is ambiguous on its own is resolved by its neighbours.

    Returns ``(dy, confidence)`` where confidence is the share of regions
    satisfied. ``(0.0, 0.0)`` when there is nothing to work with.
    """
    if not lines or not rect_boxes:
        return 0.0, 0.0

    def score(dy: float) -> float:
        """Total 'how well are the regions centred on lines' at this offset.

        Scored on distance between centres rather than overlap area. Overlap
        looks like the obvious measure but plateaus badly: a word box spans the
        font's full ascent and descent, so it is routinely *taller* than the
        region drawn on it. Once the region sits entirely inside the line,
        overlap stops changing, and every offset across that range scores
        identically — the scan then settles on the first (smallest) one rather
        than the true shift. Centre distance has a single sharp peak.
        """
        total = 0.0
        for (_x0, y0, _x1, y1) in rect_boxes:
            centre = (y0 + y1) / 2.0 + dy
            best = 0.0
            for ln in lines:
                fit = 1.0 - abs(ln.center - centre) / ln.height
                if fit > best:
                    best = fit
            total += max(0.0, best)
        return total

    best_dy, best_score = 0.0, score(0.0)
    steps = int(max_shift / step)
    for k in range(1, steps + 1):
        for dy in (k * step, -k * step):
            s = score(dy)
            # Strictly better only, scanning outwards from zero: ties keep the
            # smaller shift, and dy=0 wins outright, so a page that was already
            # fine is never moved.
            if s > best_score:
                best_dy, best_score = dy, s

    # Dead zone. A hand-drawn box is rarely centred on its line to the point,
    # so the best-fitting offset is almost never exactly zero — without this we
    # would report a cosmetic sub-millimetre nudge on a page that is perfectly
    # fine. Only drift large enough to actually change what gets read counts.
    if abs(best_dy) < _MIN_MEANINGFUL_SHIFT:
        return 0.0, score(0.0) / len(rect_boxes)

    return best_dy, best_score / len(rect_boxes)
