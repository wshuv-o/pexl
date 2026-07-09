"""Images -> PDF, at native resolution (no downscaling, no re-compression).

Design goals
------------
* **Never resample.** Every image is embedded at its exact pixel dimensions.
  The page size is derived from those pixels and the chosen DPI, so the pixel
  data itself is untouched.
* **Never re-encode a JPEG.** A plain RGB JPEG is passed through byte-for-byte
  (PDF stores it as DCTDecode), so there is zero generation loss. Anything
  else (PNG, alpha, palette, CMYK, 16-bit) is converted once, losslessly, to
  PNG/Flate.

Contrast with main.py's `_image_bytes_to_pdf`, which re-saves through PIL at a
fixed 200 dpi — fine for OCR, lossy for archival.
"""

import io
import logging

import fitz  # PyMuPDF
from PIL import Image
from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import JSONResponse, Response

logger = logging.getLogger(__name__)
router = APIRouter()

# These screenshots/scans can be very large. PIL's bomb guard is a DoS
# heuristic, not a correctness limit; raise it but keep a hard ceiling so a
# malicious upload can't exhaust RAM.
Image.MAX_IMAGE_PIXELS = 500_000_000  # ~500 MP
_MAX_PIXELS_PER_IMAGE = 400_000_000

_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp", ".gif")


def _prepare(data: bytes, filename: str):
    """Return (stream_bytes, width_px, height_px, passthrough: bool).

    Passthrough means the original bytes are embedded untouched.
    """
    img = Image.open(io.BytesIO(data))
    w, h = img.size
    if w * h > _MAX_PIXELS_PER_IMAGE:
        raise ValueError(f"{filename}: image too large ({w}x{h})")

    fmt = (img.format or "").upper()
    mode = img.mode

    # Lossless passthrough: a plain RGB/grayscale JPEG can be embedded as-is.
    # No decode->re-encode, so no generation loss.
    if fmt == "JPEG" and mode in ("RGB", "L") and not img.info.get("transparency"):
        img.close()
        return data, w, h, True

    # Everything else: convert once, losslessly, preserving every pixel.
    if mode == "P":
        img = img.convert("RGBA")
    if mode in ("RGBA", "LA") or (img.mode in ("RGBA", "LA")):
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[-1])
        img = bg
    elif img.mode == "CMYK":
        img = img.convert("RGB")
    elif img.mode in ("I;16", "I", "F"):
        # PDF has no 16-bit channel; map down to 8-bit without resizing.
        img = img.convert("L")
    elif img.mode not in ("RGB", "L"):
        img = img.convert("RGB")

    buf = io.BytesIO()
    img.save(buf, format="PNG", compress_level=6)  # PNG = lossless
    img.close()
    return buf.getvalue(), w, h, False


@router.post("/api/images-to-pdf")
async def images_to_pdf(
    files: list[UploadFile] = File(...),
    dpi: int = Form(96),
    order: list[str] = Form(None),
):
    """Combine uploaded images into one PDF at native resolution.

    ``dpi`` only affects the *page dimensions* (physical size), never the
    pixel data: page_size_pt = pixels * 72 / dpi.
    """
    if not files:
        return JSONResponse(status_code=400, content={"error": "No files uploaded."})
    if dpi <= 0 or dpi > 1200:
        return JSONResponse(status_code=400, content={"error": "dpi must be between 1 and 1200."})

    doc = fitz.open()
    added = 0
    passthrough = 0
    skipped = []
    try:
        for f in files:
            name = f.filename or "image"
            if not name.lower().endswith(_IMAGE_EXTS):
                skipped.append(f"{name} (unsupported type)")
                continue
            data = await f.read()
            if not data:
                skipped.append(f"{name} (empty)")
                continue
            try:
                stream, w, h, direct = _prepare(data, name)
            except Exception as exc:
                logger.warning("images-to-pdf: %s", exc)
                skipped.append(f"{name} ({exc})")
                continue

            # Page size in PDF points; pixels are embedded 1:1 regardless.
            page_w = w * 72.0 / dpi
            page_h = h * 72.0 / dpi
            page = doc.new_page(width=page_w, height=page_h)
            page.insert_image(page.rect, stream=stream)
            added += 1
            passthrough += 1 if direct else 0

        if added == 0:
            return JSONResponse(status_code=400, content={
                "error": "No usable images.", "skipped": skipped,
            })

        out = doc.tobytes(deflate=True, garbage=3)
    finally:
        doc.close()

    logger.info("images-to-pdf: %d pages (%d jpeg passthrough), %d skipped, dpi=%d",
                added, passthrough, len(skipped), dpi)

    headers = {
        "Content-Disposition": 'attachment; filename="images.pdf"',
        "X-Pdf-Pages": str(added),
        "X-Pdf-Passthrough": str(passthrough),
        "X-Pdf-Skipped": str(len(skipped)),
        "Access-Control-Expose-Headers": "X-Pdf-Pages,X-Pdf-Passthrough,X-Pdf-Skipped",
    }
    return Response(content=out, media_type="application/pdf", headers=headers)
