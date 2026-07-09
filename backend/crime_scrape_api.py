"""Web gateway for the crime-map folder scraper.

The frontend /crime-scrape page lets the user pick a folder whose subfolders
are communities, each containing one or more LexisNexis crime-map screenshots.
Every file is uploaded with its relative path preserved in the `paths` field;
this endpoint groups images by community (the folder directly containing the
image), scrapes each screenshot's table, prepends the community name, and
returns one combined .xlsx — the same output as the folder_table_scrape CLI.
"""

import io
import logging
import posixpath

import openpyxl
from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import JSONResponse, Response

import folder_table_scrape as fts
from ocr_lazy import get_ocr_engine

logger = logging.getLogger(__name__)
router = APIRouter()

_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp", ".gif")


def _community_of(rel_path: str) -> str:
    """Community = the folder directly containing the image.

    "batch/Agave Village/shot.png" -> "Agave Village"
    "Agave Village/shot.png"       -> "Agave Village"
    "shot.png"                     -> "(root)"
    """
    rel = rel_path.replace("\\", "/").strip("/")
    parent = posixpath.dirname(rel)
    if not parent:
        return "(root)"
    return posixpath.basename(parent)


@router.post("/api/crime-scrape")
async def crime_scrape(
    files: list[UploadFile] = File(...),
    paths: list[str] = Form(...),
):
    """Scrape every crime-map screenshot in an uploaded folder into one Excel."""
    if not files:
        return JSONResponse(status_code=400, content={"error": "No files uploaded."})
    if len(paths) != len(files):
        # Fall back to each file's own filename if paths weren't supplied 1:1.
        paths = [f.filename or "" for f in files]

    engine = get_ocr_engine()

    # Group (community, filename, bytes) and process in a stable order.
    items = []
    for f, p in zip(files, paths):
        name = (p or f.filename or "").lower()
        if not name.endswith(_IMAGE_EXTS):
            continue
        data = await f.read()
        if data:
            items.append((_community_of(p or f.filename or ""), (p or f.filename), data))

    if not items:
        return JSONResponse(status_code=400, content={"error": "No image files found in the upload."})

    items.sort(key=lambda t: (t[0].lower(), t[1].lower()))

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Crime Data"
    ws.append(["Community"] + fts.COLS)

    total_rows = 0
    per_community = {}
    errors = 0
    for community, path, data in items:
        try:
            rows = fts.extract_table_from_bytes(data, engine=engine)
        except Exception:
            logger.exception("crime-scrape failed on %s", path)
            errors += 1
            continue
        for row in rows:
            ws.append([community] + [row[c] for c in fts.COLS])
        total_rows += len(rows)
        per_community[community] = per_community.get(community, 0) + len(rows)

    buf = io.BytesIO()
    wb.save(buf)

    logger.info("crime-scrape: %d images, %d communities, %d rows, %d errors",
                len(items), len(per_community), total_rows, errors)

    headers = {
        "Content-Disposition": 'attachment; filename="combined_crime_data.xlsx"',
        # Surface a small summary the frontend can read without parsing the file.
        "X-Crime-Rows": str(total_rows),
        "X-Crime-Images": str(len(items)),
        "X-Crime-Communities": str(len(per_community)),
        "X-Crime-Errors": str(errors),
        "Access-Control-Expose-Headers": "X-Crime-Rows,X-Crime-Images,X-Crime-Communities,X-Crime-Errors",
    }
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )
