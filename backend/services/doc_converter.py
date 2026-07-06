"""
DOC/DOCX → PDF converter using LibreOffice headless.
After conversion the downstream PDF pipeline works unchanged.
"""

import subprocess
import tempfile
import pathlib
import shutil
import logging
from typing import Optional

logger = logging.getLogger(__name__)
_DOC_EXTENSIONS = {".doc", ".docx"}


def is_doc_file(filename: str) -> bool:
    return pathlib.Path(filename).suffix.lower() in _DOC_EXTENSIONS


def _find_soffice() -> Optional[str]:
    for name in ("soffice", "libreoffice"):
        found = shutil.which(name)
        if found:
            return found
    for path in (
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    ):
        if pathlib.Path(path).exists():
            return path
    return None


def convert_to_pdf(doc_bytes: bytes, original_filename: str) -> bytes:
    soffice = _find_soffice()
    if not soffice:
        raise RuntimeError(
            "LibreOffice not installed. Install it to enable DOC/DOCX support "
            "(Linux: `apt install libreoffice`)."
        )

    ext = pathlib.Path(original_filename).suffix.lower() or ".docx"
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp = pathlib.Path(tmp_dir)
        src = tmp / f"input{ext}"
        src.write_bytes(doc_bytes)
        try:
            result = subprocess.run(
                [soffice, "--headless", "--convert-to", "pdf",
                 "--outdir", str(tmp), str(src)],
                capture_output=True,
                timeout=90,
                text=True,
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError("LibreOffice conversion timed out (> 90s)")
        except OSError as exc:
            raise RuntimeError(f"Failed to launch LibreOffice ({soffice}): {exc}")

        if result.returncode != 0:
            raise RuntimeError(
                f"LibreOffice conversion failed (exit {result.returncode}): "
                f"{result.stderr.strip() or result.stdout.strip()}"
            )

        pdf_path = tmp / f"{src.stem}.pdf"
        if not pdf_path.exists():
            raise RuntimeError("LibreOffice finished but produced no PDF output")

        pdf_bytes = pdf_path.read_bytes()
        logger.info("Converted %s → PDF (%d → %d bytes)",
                    original_filename, len(doc_bytes), len(pdf_bytes))
        return pdf_bytes
