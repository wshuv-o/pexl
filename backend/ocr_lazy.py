"""Lazy OCR engine singleton — matches boss-pdf's pattern.

The RapidOCR engine holds ~200 MB of model weights in RAM and takes 1-2 s
to construct. When users only extract data from digital PDFs, that memory
+ startup cost is wasted.

`get_ocr_engine()` creates the engine on first actual OCR call and caches
it for the rest of the process lifetime. Thread-safe via a double-checked
lock. Returns ``None`` when the RapidOCR adapter isn't installed (falls
back gracefully in call sites that already null-check).
"""

from __future__ import annotations

import logging
import threading

logger = logging.getLogger(__name__)

try:
    from rapid_ocr_adapter import RapidOCRAdapter
    _OCR_AVAILABLE = True
except ModuleNotFoundError:
    RapidOCRAdapter = None  # type: ignore
    _OCR_AVAILABLE = False


_instance = None            # None = never tried, False = tried and failed, else engine
_lock = threading.Lock()


def get_ocr_engine():
    """Return the shared OCR engine, constructing it on first call.

    Idempotent. Safe to call from multiple threads — the RapidOCR
    constructor only runs once. Every subsequent call is a fast attribute
    read.
    """
    global _instance
    # Fast path — no locking needed after the singleton is realized.
    if _instance is not None:
        return _instance if _instance is not False else None

    if not _OCR_AVAILABLE:
        _instance = False
        return None

    with _lock:
        # Double-check under the lock in case a concurrent caller beat us.
        if _instance is None:
            logger.info("OCR engine lazy-init: loading RapidOCR on first use...")
            try:
                _instance = RapidOCRAdapter(lang="en")
                logger.info("OCR engine ready.")
            except Exception as exc:
                logger.warning("OCR engine init failed: %s", exc)
                _instance = False

    return _instance if _instance is not False else None


def is_ocr_available() -> bool:
    """True when the RapidOCR adapter can be constructed. Doesn't force
    the engine to load — use `get_ocr_engine()` for that."""
    return bool(_OCR_AVAILABLE)
