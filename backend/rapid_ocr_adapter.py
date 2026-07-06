"""RapidOCR -> PaddleOCR API adapter.

The rest of the codebase was written against PaddleOCR's
``engine.ocr(img, cls=True)`` API, which returns:

    [                                          # outer list  (one entry per image)
        [                                      # results for image #0
            [ box, (text, score) ],
            [ box, (text, score) ],
            ...
        ]
    ]

RapidOCR's native API is similar but slightly different:

    result, elapse = engine(img)               # tuple, not list
    # result is either None  (no text)  or
    # [
    #     [ box, text, score ],                # flat triplet, not (text, score)
    #     ...
    # ]

This adapter wraps a ``rapidocr_onnxruntime.RapidOCR`` instance and exposes
an ``.ocr(img, cls=True, ...)`` method whose return value is byte-identical
in shape to PaddleOCR's, so every existing call site in main.py,
searchable_pdf.py, automap.py and text_pipeline.py continues to work
without modification.

Why this approach
-----------------
The alternative would be to rewrite each of the five OCR call sites to
parse RapidOCR's native shape. That spreads the API knowledge across
multiple files and creates five places where a bug can be introduced.
A single adapter is one place to get right, one place to test.

What this adapter does NOT do
-----------------------------
* Convert from PaddleOCR's result shape to RapidOCR's — that direction is
  not needed; we only translate the other way.
* Wrap the engine in a lock. PaddleOCR's _LockedOCR wrapper was needed
  because PaddleOCR's C++ code was not thread-safe (segfaulted under
  concurrent calls). RapidOCR + ONNX Runtime IS thread-safe by design,
  so no lock is needed. We keep a lock around the call anyway out of an
  abundance of caution and because the calling code expects the same
  serialised-call semantics; the cost is negligible.
"""

import logging
import threading
from typing import Any

logger = logging.getLogger(__name__)


class RapidOCRAdapter:
    """Drop-in replacement for ``paddleocr.PaddleOCR`` that delegates to
    ``rapidocr_onnxruntime.RapidOCR``.

    Only the methods actually used by the codebase are implemented:
      * ``ocr(img, cls=True, ...)`` — returns PaddleOCR-shaped result
    """

    def __init__(self, lang: str = "en", **_ignored_kwargs):
        # Import inside __init__ so that simply importing this module
        # doesn't pull in onnxruntime / model weights.
        from rapidocr_onnxruntime import RapidOCR
        self._engine = RapidOCR()
        self._lock = threading.Lock()
        self._lang = lang
        logger.info("RapidOCRAdapter initialised (lang=%s)", lang)

    def ocr(self, img: Any, cls: bool = True, **_ignored_kwargs) -> list:
        """Run OCR on ``img`` and return results in PaddleOCR shape.

        Parameters mirror PaddleOCR's API; ``cls`` is accepted for
        compatibility but RapidOCR always uses its classifier when angle
        detection is needed.

        Returns
        -------
        list
            ``[[[box, (text, score)], ...]]`` — outer list has exactly one
            element (since we pass one image), inner list is the detections.
            Returns ``[None]`` when no text was detected, matching
            PaddleOCR's quirky empty-image behaviour.
        """
        with self._lock:
            try:
                native_result, _elapse = self._engine(img)
            except Exception:
                # Propagate so the caller's try/except matches PaddleOCR behaviour.
                raise

        # RapidOCR returns ``(None, None)`` (or ``(None, elapse)``) when no
        # text is detected. PaddleOCR returns ``[None]`` in the same case
        # (an outer list containing a single None). Match that.
        if native_result is None:
            return [None]

        # Translate flat [box, text, score] triplets into PaddleOCR's
        # nested [box, (text, score)] shape and wrap in an outer list.
        translated = []
        for entry in native_result:
            # Defensive: skip malformed entries instead of crashing the pipeline.
            if not entry or len(entry) < 3:
                continue
            box, text, score = entry[0], entry[1], entry[2]
            try:
                score_f = float(score)
            except (TypeError, ValueError):
                score_f = 0.0
            translated.append([box, (text, score_f)])

        return [translated]
