# -*- coding: utf-8 -*-
"""Scrape the crime-map table from every folder's screenshot in public/test,
prepend the folder (community) name, and merge into one Excel."""
import io
import os
import sys
import glob

import numpy as np
from PIL import Image
import openpyxl

# This tool lives in backend/ so it can import the OCR adapter directly.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rapid_ocr_adapter import RapidOCRAdapter

# Folder to scan (each subfolder = one community, containing one screenshot).
# Pass a folder path as the first argument; defaults to public/test.
_DEFAULT_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "test")
)
TEST_DIR = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else _DEFAULT_DIR
OUT_XLSX = (
    os.path.abspath(sys.argv[2]) if len(sys.argv) > 2
    else os.path.join(TEST_DIR, "combined_crime_data.xlsx")
)

# Known columns in left-to-right order.
COLS = ["Class", "Incident #", "Crime", "Date/Time", "Location Name", "Address", "Accuracy", "Agency"]
# Keyword(s) used to locate each header label in the OCR output.
HEADER_KEYS = {
    "Class": ["class"],
    "Incident #": ["incident"],
    "Crime": ["crime"],
    "Date/Time": ["date"],
    "Location Name": ["location"],
    "Address": ["address"],
    "Accuracy": ["accuracy"],
    "Agency": ["agency"],
}

_engine = None


def _get_engine():
    """Lazily build a standalone OCR engine (only used by the CLI path)."""
    global _engine
    if _engine is None:
        _engine = RapidOCRAdapter(lang="en")
    return _engine


def words_from_array(arr, engine=None):
    """OCR a numpy image array → list of dicts {text, cx, cy, x0, x1, h}."""
    engine = engine or _get_engine()
    res = engine.ocr(arr, cls=True)
    out = []
    if not res or not res[0]:
        return out
    for box, (text, score) in res[0]:
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        x0, x1 = min(xs), max(xs)
        y0, y1 = min(ys), max(ys)
        t = (text or "").strip()
        if not t:
            continue
        out.append({"text": t, "cx": (x0 + x1) / 2, "cy": (y0 + y1) / 2,
                    "x0": x0, "x1": x1, "h": y1 - y0})
    return out


def ocr_words(img_path, engine=None, scale=2.0):
    """Return list of dicts: {text, cx, cy, x0, x1, h}.

    Upscales the image (default 2x) before OCR. The crime-map screenshots
    render small, low-contrast text (the pushpin icon + a short class like
    "Theft"); at native resolution RapidOCR's detector misses those cells
    entirely, leaving the Class column blank. Upscaling makes the small text
    detectable. All coordinates stay in the upscaled space, which is
    internally consistent — column detection and row clustering are relative,
    so the extracted text is unaffected.
    """
    img = Image.open(img_path).convert("RGB")
    if scale and scale != 1.0:
        img = img.resize((int(img.width * scale), int(img.height * scale)), Image.LANCZOS)
    arr = np.array(img)
    return words_from_array(arr, engine=engine)


def find_columns(words):
    """Locate header label x-centers. Returns (header_cy, {col: cx}) or (None, None).

    Anchor on the unambiguous "Incident #" header to fix the header row's
    y-position, then match every other column label ONLY within that row's
    y-band. This avoids matching the page title "Community Crime Map"
    (which contains 'crime') or other stray text elsewhere on the page.
    """
    # 1. Anchor: the "Incident" / "Class" / "Agency" labels are reliably
    #    detected even when OCR mangles others (e.g. "Crlme", "Locatlon").
    anchor = None
    for key in ("incident", "class", "agency", "accuracy"):
        for w in words:
            if key in w["text"].lower():
                if anchor is None or w["cy"] < anchor["cy"]:
                    anchor = w
        if anchor is not None:
            break
    if anchor is None:
        return None, None
    header_cy = anchor["cy"]
    band = max(anchor["h"], 18) * 1.5  # vertical tolerance for "same row"

    # 2. Collect every label-like word in the header band, left-to-right.
    #    A label has >= 3 alphabetic characters (filters out sort-arrow /
    #    filter-funnel icon glyphs OCR sometimes emits).
    band_words = sorted(
        (w for w in words
         if abs(w["cy"] - header_cy) <= band
         and sum(ch.isalpha() for ch in w["text"]) >= 3),
        key=lambda w: w["x0"],
    )
    # Merge words that sit on the same column (x0 within ~20px) — handles a
    # header label OCR split into two tokens.
    merged = []
    for w in band_words:
        if merged and w["x0"] - merged[-1]["x0"] < 20:
            continue
        merged.append(w)

    # 3a. Ideal case: exactly 8 header labels → map positionally to COLS.
    #     This is OCR-error-proof: it never needs to read a label correctly,
    #     only to see that a label exists at that x-position.
    if len(merged) == len(COLS):
        return header_cy, {COLS[i]: merged[i]["x0"] for i in range(len(COLS))}

    # 3b. Fallback: keyword-match whatever we can (some columns may be
    #     missing, but we still align the ones we recognise).
    col_cx = {}
    for col, keys in HEADER_KEYS.items():
        for w in merged:
            low = w["text"].lower()
            if any(k in low for k in keys):
                col_cx[col] = w["x0"]
                break
    if len(col_cx) < 5:
        return None, None
    return header_cy, col_cx


def assign_col(x0, col_left):
    """Bucket a word by its left edge: it belongs to the rightmost column
    whose header left-edge is <= the word's left edge (with a small margin
    for cell text that's indented a hair past the header)."""
    margin = 12.0
    ordered = sorted(col_left.items(), key=lambda kv: kv[1])  # (col, left) by x
    chosen = ordered[0][0]
    for col, left in ordered:
        if x0 >= left - margin:
            chosen = col
        else:
            break
    return chosen


def cluster_rows(words, tol):
    """Group words into rows by cy proximity."""
    words = sorted(words, key=lambda w: w["cy"])
    rows = []
    cur = []
    last_cy = None
    for w in words:
        if last_cy is None or abs(w["cy"] - last_cy) <= tol:
            cur.append(w)
        else:
            rows.append(cur)
            cur = [w]
        last_cy = w["cy"] if last_cy is None else (last_cy + w["cy"]) / 2 if abs(w["cy"] - last_cy) <= tol else w["cy"]
    if cur:
        rows.append(cur)
    return rows


def rows_from_words(words):
    """Turn an OCR word list into crime-table row dicts. Shared by the CLI
    (file path) and the web gateway (uploaded bytes)."""
    if not words:
        return []
    header_cy, col_cx = find_columns(words)
    if col_cx is None:
        return []
    med_h = float(np.median([w["h"] for w in words])) or 20.0
    row_tol = med_h * 0.7
    # Data words = below the header row.
    data = [w for w in words if w["cy"] > header_cy + med_h * 0.6]
    rows = cluster_rows(data, row_tol)
    table = []
    for r in rows:
        cells = {c: [] for c in COLS}
        for w in r:
            col = assign_col(w["x0"], col_cx)
            cells[col].append((w["x0"], w["text"]))
        row_vals = {}
        for c in COLS:
            parts = [t for _, t in sorted(cells[c], key=lambda p: p[0])]
            row_vals[c] = " ".join(parts).strip()
        # "No results found." pages have no crime data — skip entirely.
        # Check BEFORE stripping the Class token (the strip would eat the
        # leading "No" and defeat this match).
        joined = " ".join(row_vals.values()).lower()
        if "results found" in joined or "no result" in joined:
            continue
        # Strip the leading map-pin icon glyph that OCR misreads as a short
        # token in the Class column (e.g. "O Theft" -> "Theft", "SA Sexual
        # Assault" -> "Sexual Assault").
        cls = row_vals["Class"]
        toks = cls.split()
        if len(toks) >= 2 and len(toks[0]) <= 2 and not toks[0][0].isdigit():
            row_vals["Class"] = " ".join(toks[1:])
        # Skip empty rows / stray footer lines (require an incident # or a crime).
        if row_vals["Incident #"] or row_vals["Crime"] or row_vals["Class"]:
            table.append(row_vals)
    return table


def extract_table(img_path, engine=None):
    """Scrape one screenshot file (CLI path)."""
    return rows_from_words(ocr_words(img_path, engine=engine))


def extract_table_from_bytes(image_bytes, engine=None, scale=2.0):
    """Scrape one screenshot given raw bytes (web gateway path).

    Mirrors ocr_words()'s 2x upscale so faint small text (e.g. the 'Theft'
    class label) is detected."""
    from PIL import Image
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    if scale and scale != 1.0:
        img = img.resize((int(img.width * scale), int(img.height * scale)), Image.LANCZOS)
    words = words_from_array(np.array(img), engine=engine)
    return rows_from_words(words)


def main():
    folders = sorted(
        d for d in os.listdir(TEST_DIR)
        if os.path.isdir(os.path.join(TEST_DIR, d))
    )
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Crime Data"
    ws.append(["Community"] + COLS)

    total_rows = 0
    summary = []
    for folder in folders:
        fdir = os.path.join(TEST_DIR, folder)
        # Gather EVERY image in the folder (a folder may hold several
        # screenshots — e.g. paginated pages of the same table). Process
        # them all and append every row; duplicates are acceptable.
        imgs = []
        for ext in ("*.png", "*.jpg", "*.jpeg", "*.tif", "*.tiff", "*.bmp", "*.webp", "*.gif",
                    "*.PNG", "*.JPG", "*.JPEG"):
            imgs.extend(glob.glob(os.path.join(fdir, ext)))
        imgs = sorted(set(imgs))
        if not imgs:
            summary.append((folder, "NO IMAGE", 0))
            continue
        folder_rows = 0
        for img in imgs:
            try:
                table = extract_table(img)
            except Exception as e:
                print(f"{folder:42s}  ERROR on {os.path.basename(img)}: {e}", flush=True)
                continue
            for row in table:
                ws.append([folder] + [row[c] for c in COLS])
            folder_rows += len(table)
            print(f"{folder:42s} {len(table):>3} rows  ({os.path.basename(img)})", flush=True)
        total_rows += folder_rows
        summary.append((folder, f"{len(imgs)} image(s)", folder_rows))

    wb.save(OUT_XLSX)
    print("\n" + "=" * 60)
    print(f"Folders processed : {len(folders)}")
    print(f"Total data rows   : {total_rows}")
    print(f"Saved             : {OUT_XLSX}")
    zero = [s for s in summary if s[2] == 0]
    if zero:
        print(f"\nFolders with 0 rows ({len(zero)}):")
        for f, note, _ in zero:
            print(f"  - {f}: {note}")


if __name__ == "__main__":
    main()
