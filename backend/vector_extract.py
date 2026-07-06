"""
Vector diagram detection and rendering.

Detects PDF pages that are dominated by vector graphics (paths, lines, curves,
filled shapes) and renders them via matplotlib so PaddleOCR can extract text
from labels, annotations, chart axes, and legends that live inside the drawing
layer — not as PDF text operators.

A page is "vector-rich" when it has many drawing primitives covering a
significant fraction of the page area.  Examples: floor plans, site maps,
bar/line/pie charts, technical diagrams, org charts.

Detection thresholds are tuned to avoid flagging pages that merely have
table borders or decorative rules (a few rectangles → not a diagram).
"""

from __future__ import annotations

import gc
import logging

import fitz
import numpy as np

logger = logging.getLogger(__name__)

# --- Tuning knobs -----------------------------------------------------------
# Minimum total number of drawing *items* (line segs, rects, bezier curves)
# before a page is a candidate for vector treatment.
_MIN_ITEMS = 40
# Minimum fraction of page area covered by drawing bounding boxes.
_MIN_AREA_RATIO = 0.15
# Bezier curve items suggest artistic/diagram content vs simple table borders.
_MIN_CURVE_ITEMS = 5
# DPI used when rendering via matplotlib for OCR.
_RENDER_DPI = 150
# ---------------------------------------------------------------------------

try:
    import matplotlib
    matplotlib.use("Agg")           # non-interactive, thread-safe
    import matplotlib.pyplot as plt
    import matplotlib.patches as mpatches
    _HAS_MATPLOTLIB = True
except ImportError:
    _HAS_MATPLOTLIB = False


def _to_mpl_color(c):
    """Convert PyMuPDF color (float gray, RGB tuple, or CMYK tuple) to RGB tuple."""
    if c is None:
        return None
    if isinstance(c, (int, float)):
        v = float(c)
        return (v, v, v)
    if len(c) == 3:
        return tuple(float(v) for v in c)
    if len(c) == 4:                 # CMYK → RGB approximation
        cc, cm, cy, ck = c
        return (
            (1 - cc) * (1 - ck),
            (1 - cm) * (1 - ck),
            (1 - cy) * (1 - ck),
        )
    return None


def classify_vector(page: fitz.Page) -> dict:
    """Analyse the drawing content of *page* and return a classification dict.

    Keys:
      is_vector  — bool: True when drawing content is significant
      n_items    — total drawing primitive count
      n_curves   — number of Bezier curve primitives
      area_ratio — fraction of page area covered by drawing bboxes
    """
    try:
        drawings = page.get_drawings()
    except Exception:
        return {"is_vector": False, "n_items": 0, "n_curves": 0, "area_ratio": 0.0}

    page_area = max(page.rect.width * page.rect.height, 1.0)
    n_items = 0
    n_curves = 0
    covered_area = 0.0

    for d in drawings:
        items = d.get("items", [])
        n_items += len(items)
        n_curves += sum(1 for it in items if it[0] == "c")
        r = d.get("rect")
        if r:
            covered_area += r.width * r.height

    area_ratio = covered_area / page_area

    is_vector = (
        (n_items >= _MIN_ITEMS and area_ratio >= _MIN_AREA_RATIO)
        or n_curves >= _MIN_CURVE_ITEMS
    )

    return {
        "is_vector": is_vector,
        "n_items":   n_items,
        "n_curves":  n_curves,
        "area_ratio": round(area_ratio, 3),
    }


def render_vector_matplotlib(page: fitz.Page) -> "np.ndarray | None":
    """Render all vector drawings on *page* using matplotlib.

    Each path item (line, rectangle, Bezier curve, quadrilateral) is drawn
    in its original color and fill.  The result is an RGB numpy array
    (H × W × 3) suitable for PaddleOCR.

    Falls back to PyMuPDF pixmap if matplotlib is unavailable or crashes.
    PDF coordinates: y=0 is at the TOP.  matplotlib y=0 is at the BOTTOM.
    We flip y = (page_height − pdf_y) to convert.
    """
    if not _HAS_MATPLOTLIB:
        return _fallback_pixmap(page)

    try:
        drawings = page.get_drawings()
    except Exception:
        return _fallback_pixmap(page)

    rect = page.rect
    w_pts, h_pts = rect.width, rect.height
    dpi = _RENDER_DPI

    try:
        fig, ax = plt.subplots(
            figsize=(w_pts / 72.0, h_pts / 72.0),
            dpi=dpi,
        )
        fig.patch.set_facecolor("white")
        ax.set_facecolor("white")
        ax.set_xlim(0, w_pts)
        ax.set_ylim(0, h_pts)
        ax.set_aspect("equal")
        ax.axis("off")

        for d in drawings:
            stroke = _to_mpl_color(d.get("color")) or "black"
            fill   = _to_mpl_color(d.get("fill"))
            lw     = max(float(d.get("width") or 1.0), 0.3)

            for item in d.get("items", []):
                kind = item[0]
                try:
                    if kind == "l":                     # line segment
                        p1, p2 = item[1], item[2]
                        ax.plot(
                            [p1.x, p2.x],
                            [h_pts - p1.y, h_pts - p2.y],
                            color=stroke, linewidth=lw, solid_capstyle="round",
                        )

                    elif kind == "re":                  # rectangle
                        r = item[1]
                        patch = mpatches.Rectangle(
                            (r.x0, h_pts - r.y1), r.width, r.height,
                            linewidth=lw,
                            edgecolor=stroke,
                            facecolor=fill if fill else "none",
                        )
                        ax.add_patch(patch)

                    elif kind == "c":                   # cubic Bezier curve
                        p0, p1, p2, p3 = item[1], item[2], item[3], item[4]
                        ts = np.linspace(0, 1, 24)
                        xs = (
                            (1 - ts) ** 3 * p0.x
                            + 3 * (1 - ts) ** 2 * ts * p1.x
                            + 3 * (1 - ts) * ts ** 2 * p2.x
                            + ts ** 3 * p3.x
                        )
                        ys = h_pts - (
                            (1 - ts) ** 3 * p0.y
                            + 3 * (1 - ts) ** 2 * ts * p1.y
                            + 3 * (1 - ts) * ts ** 2 * p2.y
                            + ts ** 3 * p3.y
                        )
                        ax.plot(xs, ys, color=stroke, linewidth=lw)

                    elif kind == "qu":                  # quadrilateral (4-point polygon)
                        pts = item[1]
                        xs_q = [p.x for p in pts] + [pts[0].x]
                        ys_q = [h_pts - p.y for p in pts] + [h_pts - pts[0].y]
                        ax.plot(xs_q, ys_q, color=stroke, linewidth=lw)
                        if fill:
                            ax.fill(xs_q[:-1], ys_q[:-1], color=fill, alpha=1.0)

                except Exception:
                    continue         # skip malformed item, keep going

        fig.tight_layout(pad=0)
        fig.canvas.draw()
        # buffer_rgba() is the correct API in matplotlib ≥ 3.8 (tostring_rgb removed)
        buf = fig.canvas.buffer_rgba()
        mw, mh = fig.canvas.get_width_height()
        # buffer is RGBA — drop the alpha channel to get RGB
        img = np.frombuffer(buf, dtype=np.uint8).reshape(mh, mw, 4)[:, :, :3].copy()
        return img

    except Exception as exc:
        logger.warning("matplotlib vector render failed: %s", exc)
        return _fallback_pixmap(page)
    finally:
        try:
            plt.close("all")
        except Exception:
            pass
        gc.collect()


def _fallback_pixmap(page: fitz.Page) -> "np.ndarray | None":
    """Render page via PyMuPDF and return RGB numpy array."""
    try:
        from PIL import Image
        pix = page.get_pixmap(dpi=_RENDER_DPI)
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        arr = np.array(img)
        pix = None
        img = None
        return arr
    except Exception as exc:
        logger.warning("Pixmap fallback also failed: %s", exc)
        return None
