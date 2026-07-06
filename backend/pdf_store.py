"""Temporary store for uploaded documents.

Small files (< DISK_THRESHOLD_MB) live entirely in memory.
Large files (>= DISK_THRESHOLD_MB) are written to a temp file on disk so that
fitz can mmap them — this cuts peak RAM from ~3x file size down to ~1x.

Memory-safety guarantees added in the patched version
-----------------------------------------------------
* The store is a strict LRU bounded by ``PEXL_MAX_SESSIONS`` (default 200).
* Sessions auto-expire after ``PEXL_SESSION_TTL_SEC`` seconds (default
  14_400 = 4 h); a background sweeper thread runs every 60 s, so memory is
  freed even when no new uploads arrive. Bump the env var if users work on
  batches for longer than that.
* ``PDFDocument.close()`` explicitly drops the heavyweight per-session
  caches (``searchable_pdf_bytes``, ``structured_pages``) in addition to
  the fitz document and any temp file.
* ``PDFDocument.release_caches()`` exposes the same cache-clearing logic so
  callers can free memory mid-session (e.g. after a download finishes) without
  invalidating the session entirely.

All four numbers (max sessions, TTL, disk threshold, sweeper interval) are
overridable via environment variables, so ops can tune without code changes.
"""

import concurrent.futures
import gc
import logging
import os
import re
import tempfile
import threading
import time
import uuid
from collections import OrderedDict

import fitz

from vector_extract import classify_vector

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Tunables (env-overridable)
# ---------------------------------------------------------------------------

def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        v = int(raw)
        return v if v > 0 else default
    except ValueError:
        return default


# Files at or above this size are stored on disk instead of in RAM.
DISK_THRESHOLD_MB = _env_int("PEXL_DISK_THRESHOLD_MB", 30)
DISK_THRESHOLD_BYTES = DISK_THRESHOLD_MB * 1024 * 1024

# Hard cap on simultaneous live sessions. Bumped from 20 → 200 so batches of
# a few hundred PDFs don't get their older sessions LRU-evicted mid-workflow.
# Disk-backed storage (see DISK_THRESHOLD_MB) keeps RSS predictable — most of
# a large batch spills to temp files and is mmapped on demand.
MAX_SESSIONS = _env_int("PEXL_MAX_SESSIONS", 200)

# Time-to-live (seconds) for a session — measured from creation.
SESSION_TTL_SEC = _env_int("PEXL_SESSION_TTL_SEC", 4 * 60 * 60)  # default 4 hours

# How often the background sweeper runs.
SWEEPER_INTERVAL_SEC = _env_int("PEXL_SWEEPER_INTERVAL_SEC", 60)

# During initial upload classification, skip the (slower) image-presence check
# once a document exceeds this page count — we rely on text density alone.
FAST_CLASSIFY_ABOVE_PAGES = _env_int("PEXL_FAST_CLASSIFY_ABOVE_PAGES", 100)


# ---------------------------------------------------------------------------
# DocuSign / AcroForm noise stripping (unchanged from upstream)
# ---------------------------------------------------------------------------

_DS_NOISE_RE = re.compile(
    r"\[(?:text|sig|initial|date|checkbox|radio|approve|decline|formula|"
    r"attachment|note|dropdown|hyperlink|payment)[|][^\]]*\]"
    r"|Doc\s*ID\s*:\s*[0-9a-f]{20,}",
    re.IGNORECASE,
)


def _clean_page_text(raw: str) -> str:
    text = _DS_NOISE_RE.sub("", raw)
    return re.sub(r"\s+", " ", text).strip()


def _classify_page(page: fitz.Page, fast: bool = False) -> dict:
    """Classify a page as one of: native / mixed / scanned / form.

    native  — good text layer; OCR not needed
    mixed   — text layer present AND raster image background (e.g. DocuSign)
    scanned — no usable text; must OCR the rendered image
    form    — DocuSign / AcroForm placeholder text dominates; treat as scanned
              so image-embedded labels get indexed via OCR

    fast=True skips the image-presence check (used for large documents).
    """
    raw_text = (page.get_text("text") or "").strip()
    clean_text = _clean_page_text(raw_text)

    char_count = len(clean_text)
    letter_count = sum(1 for c in clean_text if c.isalpha())

    has_images = False
    if not fast:
        try:
            has_images = bool(page.get_images())
        except Exception:
            pass

    has_form_markers = bool(
        re.search(r"\[(?:text|sig|initial|date|checkbox|radio)[|]", raw_text, re.IGNORECASE)
    )

    if char_count >= 150 and letter_count >= 50:
        page_type = "mixed" if has_images else "native"
    elif char_count >= 30 and letter_count >= 10:
        page_type = "mixed"
    else:
        page_type = "scanned"

    if has_form_markers and char_count < 200:
        page_type = "form"

    is_ocr = page_type in ("scanned", "mixed", "form")

    # Vector-rich pages need OCR when text has been outlined (converted to
    # paths) — but we don't want to trigger OCR just because the page has a
    # logo, chart axis labels, or signature-field decorations. So we only
    # run the (expensive) get_drawings() analysis when the page has very
    # little native text; a page with plenty of text is trusted as-is.
    #
    # Skips get_drawings() entirely on the common case (native pages with
    # good text layers) — that's the 100-500ms/page saving that was
    # inflating upload response time on complex multi-page PDFs.
    is_vector = False
    vec_items = 0
    vec_curves = 0
    if not is_ocr and char_count < 30:
        # Very little text AND currently classified as native → possibly
        # vector-outlined text worth OCRing. Pay the drawing-parse cost.
        vec = classify_vector(page)
        is_vector = vec["is_vector"]
        vec_items = vec["n_items"]
        vec_curves = vec["n_curves"]
        if is_vector:
            page_type = "mixed"
            is_ocr = True

    return {
        "page_number":   page.number + 1,
        "page_type":     page_type,
        "is_ocr":        is_ocr,
        "char_count":    char_count,
        "has_images":    has_images,
        "is_vector":     is_vector,
        "vector_items":  vec_items,
        "vector_curves": vec_curves,
        "status":        page_type,
    }


# ---------------------------------------------------------------------------
# PDFDocument
# ---------------------------------------------------------------------------

class PDFDocument:
    """Wraps a fitz.Document with metadata.

    Large files are stored on disk; small files are kept in-memory.
    All consumers should use the `pdf_bytes` property (reads from disk when
    needed) or `pdf_path` (non-None only for disk-stored files).
    """

    def __init__(self, pdf_bytes: bytes, filename: str):
        self.filename = filename
        self.created_at = time.time()
        self.last_used_at = self.created_at
        self._temp_path: str | None = None
        self._raw_bytes: bytes | None = None
        self._closed = False

        if len(pdf_bytes) >= DISK_THRESHOLD_BYTES:
            # Write to a temp file so fitz can mmap it — avoids keeping a
            # second full copy of the PDF in Python heap memory.
            fd, path = tempfile.mkstemp(suffix=".pdf", prefix="pexl_upload_")
            try:
                os.write(fd, pdf_bytes)
            finally:
                os.close(fd)
            self._temp_path = path
            self.doc = fitz.open(path)
            # Drop our reference to the in-memory bytes — fitz now reads
            # from disk via mmap.
            del pdf_bytes
        else:
            self._raw_bytes = pdf_bytes
            self.doc = fitz.open(stream=pdf_bytes, filetype="pdf")

        # Classify pages; skip image-presence check for large documents
        # to keep upload response times acceptable.
        fast = len(self.doc) > FAST_CLASSIFY_ABOVE_PAGES
        self.page_info = [_classify_page(self.doc[i], fast=fast) for i in range(len(self.doc))]

        # Lazily-populated caches
        self.searchable_pdf_bytes: bytes | None = None
        self.structured_pages = None
        self._searchable_cache_key: tuple | None = None
        # Live progress updated by build_structured_pages; polled by frontend.
        # Starts as `done=True` because OCR is now fully lazy — it runs only
        # when the user requests the OCR-download PDF. Highlight extraction
        # uses per-region OCR instead, which doesn't touch this progress dict.
        self.ocr_progress: dict = {
            "current_page": 0,
            "total_pages": 0,
            "done": True,
            "elapsed_sec": 0.0,
        }
        # When True, every page is treated as scanned and fully re-OCR'd
        # regardless of its native text layer.
        self.force_ocr: bool = False

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def page_count(self) -> int:
        return len(self.doc) if not self._closed else 0

    @property
    def ocr_pages_count(self) -> int:
        return sum(1 for p in self.page_info if p["is_ocr"])

    @property
    def pdf_bytes(self) -> bytes | None:
        """Return the raw PDF bytes.

        For in-memory sessions: instant.
        For disk-based sessions: reads the file (use sparingly for large PDFs).
        """
        if self._raw_bytes is not None:
            return self._raw_bytes
        if self._temp_path and os.path.exists(self._temp_path):
            try:
                with open(self._temp_path, "rb") as fh:
                    return fh.read()
            except Exception:
                return None
        return None

    @property
    def pdf_path(self) -> str | None:
        """File-system path for disk-stored PDFs; None for in-memory."""
        return self._temp_path

    def approx_cache_bytes(self) -> int:
        """Rough estimate of memory held by the per-session caches.

        Used by the diagnostics endpoint; not authoritative.
        """
        n = 0
        if self._raw_bytes is not None:
            n += len(self._raw_bytes)
        if self.searchable_pdf_bytes is not None:
            n += len(self.searchable_pdf_bytes)
        if self.structured_pages is not None:
            # ~200 bytes per word is a generous estimate (text + bbox + ids).
            try:
                n += 200 * sum(len(p.words) for p in self.structured_pages)
            except Exception:
                pass
        return n

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    # ------------------------------------------------------------------
    # Mutation
    # ------------------------------------------------------------------

    def rotate_all(self, delta: int, dpi: int = 150) -> None:
        """Apply a visual rotation of ``delta`` degrees to every page AND
        bake the result in.

        Each page is rendered at its target orientation, then replaced by
        the rasterised upright image. The resulting document has
        ``rotation == 0`` on every page with content in physical-upright
        coordinates — which is what OCR / table extraction / coordinate-
        based highlighting actually need (PyMuPDF's ``insert_text`` and
        a bunch of other APIs operate in physical, not display, coords).

        Trade-off: vector content on rotated pages becomes a bitmap.
        For scanned PDFs (the common reason a user reaches for rotate)
        there's nothing to lose since the page was already one big image.

        Perf notes:
          * Default DPI is 150 (down from 200) — same effective quality
            for OCR, ~44% fewer pixels to encode.
          * Pages render to JPEG (quality 85) rather than PNG — 5-10×
            faster to encode and produces a much smaller output PDF.
          * Per-page render runs in a thread pool. PyMuPDF releases the
            GIL during rasterisation so threads actually parallelise; the
            doc-level new_page/insert_image work stays serial because
            fitz.Document mutation is not thread-safe.

        ``delta`` must be a multiple of 90. Raises ``ValueError`` otherwise.
        """
        if delta % 90 != 0:
            raise ValueError("delta must be a multiple of 90")
        delta = delta % 360

        # Apply target rotation to every page up front so the parallel
        # render section is read-only on each page.
        for pg in self.doc:
            pg.set_rotation((pg.rotation + delta) % 360)

        def _render(idx: int) -> tuple[int, bytes, float, float]:
            pg = self.doc[idx]
            pix = pg.get_pixmap(dpi=dpi)
            try:
                data = pix.tobytes("jpeg", jpg_quality=85)
            finally:
                pix = None  # release the C-side pixmap buffer
            return idx, data, float(pg.rect.width), float(pg.rect.height)

        n_pages = len(self.doc)
        # Cap concurrency: more threads start fighting for memory/cache
        # rather than helping. 4 is a good sweet spot on small VPS hosts.
        workers = min(4, max(1, n_pages))

        new_doc = fitz.open()
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
                rendered = sorted(ex.map(_render, range(n_pages)))

            for _idx, data, w, h in rendered:
                new_page = new_doc.new_page(width=w, height=h)
                new_page.insert_image(new_page.rect, stream=data)

            new_bytes = new_doc.tobytes()
        finally:
            new_doc.close()

        # Swap the document. Close the old one before we overwrite/replace
        # backing storage so any mmap handles are released.
        try:
            self.doc.close()
        except Exception:
            pass

        if self._temp_path:
            with open(self._temp_path, "wb") as fh:
                fh.write(new_bytes)
            self.doc = fitz.open(self._temp_path)
        else:
            self._raw_bytes = new_bytes
            self.doc = fitz.open(stream=new_bytes, filetype="pdf")

        # Invalidate every derived cache — none of them are valid for the
        # rotated document.
        self.searchable_pdf_bytes = None
        self.structured_pages = None
        self._searchable_cache_key = None

        # Re-classify pages so the frontend sees updated is_ocr / is_vector
        # flags (after baking, every page is a scanned image).
        fast = len(self.doc) > FAST_CLASSIFY_ABOVE_PAGES
        self.page_info = [_classify_page(self.doc[i], fast=fast) for i in range(len(self.doc))]
        self.last_used_at = time.time()

    def release_caches(self) -> None:
        """Drop the heavy per-session caches without closing the session.

        Useful after a one-shot endpoint (e.g. ``/ocr-pdf`` download) so the
        rendered PDF and structured-page OCR data don't sit in RAM until TTL
        expires. Subsequent requests will rebuild what they need.
        """
        self.searchable_pdf_bytes = None
        self.structured_pages = None
        self._searchable_cache_key = None

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.release_caches()
        try:
            self.doc.close()
        except Exception:
            pass
        if self._temp_path and os.path.exists(self._temp_path):
            try:
                os.unlink(self._temp_path)
            except Exception:
                pass
        self._temp_path = None
        self._raw_bytes = None


# ---------------------------------------------------------------------------
# PDFStore  (bounded LRU + background sweeper)
# ---------------------------------------------------------------------------

class PDFStore:
    """Thread-safe LRU store of PDF sessions.

    Eviction policy:
      * On every ``add()`` and on every sweeper tick, sessions older than
        ``ttl`` seconds are closed and removed.
      * If still over ``max_sessions`` after expiry-cleanup, the
        least-recently-used session is evicted to make room.
      * ``get()`` touches the session, moving it to the MRU end.
    """

    def __init__(
        self,
        ttl: int = SESSION_TTL_SEC,
        max_sessions: int = MAX_SESSIONS,
        sweeper_interval: int = SWEEPER_INTERVAL_SEC,
    ):
        self._docs: "OrderedDict[str, PDFDocument]" = OrderedDict()
        self._lock = threading.Lock()
        self._ttl = ttl
        self._max = max_sessions
        self._sweeper_interval = sweeper_interval
        self._sweeper_stop = threading.Event()
        self._sweeper_thread = threading.Thread(
            target=self._sweeper_loop,
            name="pdfstore-sweeper",
            daemon=True,
        )
        self._sweeper_thread.start()
        logger.info(
            "PDFStore initialised  ttl=%ds  max_sessions=%d  sweeper=%ds  disk_threshold=%dMB",
            self._ttl, self._max, self._sweeper_interval, DISK_THRESHOLD_MB,
        )

    # ----- public API -----

    def add(self, pdf_bytes: bytes, filename: str) -> str:
        session_id = uuid.uuid4().hex
        with self._lock:
            self._expire_locked()
            # If still at/over capacity, evict LRU until we have room.
            while len(self._docs) >= self._max:
                old_id, old_doc = self._docs.popitem(last=False)
                logger.info(
                    "PDFStore: LRU-evicting session=%s (over cap %d)",
                    old_id[-6:], self._max,
                )
                old_doc.close()
            self._docs[session_id] = PDFDocument(pdf_bytes, filename)
        # gc.collect outside the lock — the caller's bytes can now go.
        gc.collect()
        return session_id

    def get(self, session_id: str) -> PDFDocument | None:
        with self._lock:
            doc = self._docs.get(session_id)
            if doc is None:
                return None
            doc.last_used_at = time.time()
            self._docs.move_to_end(session_id)  # mark MRU
            return doc

    def remove(self, session_id: str) -> bool:
        with self._lock:
            doc = self._docs.pop(session_id, None)
        if doc:
            doc.close()
            return True
        return False

    def stats(self) -> dict:
        """Diagnostics snapshot."""
        with self._lock:
            sessions = []
            total_cache = 0
            now = time.time()
            for sid, d in self._docs.items():
                approx = d.approx_cache_bytes()
                total_cache += approx
                sessions.append({
                    "session_id":         sid,
                    "filename":           d.filename,
                    "page_count":         d.page_count,
                    "age_sec":            int(now - d.created_at),
                    "idle_sec":           int(now - d.last_used_at),
                    "approx_bytes":       approx,
                    "has_searchable_pdf": d.searchable_pdf_bytes is not None,
                })
            return {
                "session_count":      len(self._docs),
                "max_sessions":       self._max,
                "ttl_sec":            self._ttl,
                "approx_total_bytes": total_cache,
                "sessions":           sessions,
            }

    def shutdown(self) -> None:
        """Stop the sweeper and close every live session.  Safe to call twice."""
        self._sweeper_stop.set()
        with self._lock:
            for d in self._docs.values():
                d.close()
            self._docs.clear()

    # ----- internal -----

    def _expire_locked(self) -> None:
        """Drop sessions whose TTL has elapsed.  Caller MUST hold ``self._lock``."""
        now = time.time()
        expired = [k for k, v in self._docs.items() if now - v.created_at > self._ttl]
        for k in expired:
            doc = self._docs.pop(k)
            logger.info(
                "PDFStore: TTL-expiring session=%s age=%ds",
                k[-6:], int(now - doc.created_at),
            )
            doc.close()

    def _sweeper_loop(self) -> None:
        while not self._sweeper_stop.wait(self._sweeper_interval):
            try:
                with self._lock:
                    self._expire_locked()
            except Exception as exc:
                logger.warning("PDFStore sweeper error: %s", exc)


# Singleton used everywhere else in the codebase.
store = PDFStore()
