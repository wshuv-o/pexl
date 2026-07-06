# pexl_api — RapidOCR build (memory-safe + OCR engine swap)

## What this build is

This is the **patched memory-safe build** PLUS a swap of the OCR runtime
from PaddleOCR (paddlepaddle) to RapidOCR (ONNX Runtime). The OCR models
themselves are the same — same accuracy — but the runtime is significantly
lighter and doesn't have paddlepaddle's compounding memory leak or
"could not execute a primitive" errors.

## Why we made this change

The previous PaddleOCR-based build, even after my memory-bounding patch,
was still exhibiting:

* "could not execute a primitive" warnings on every page (oneDNN issue)
* RSS growing to 13 GB on a 29-page PDF — paddlepaddle leaks ~100 MB per
  OCR call that is never returned to the OS
* Cascading PM2 restarts during heavy use

Root cause: paddlepaddle's C++ runtime has memory bugs and oneDNN
integration issues that no amount of Python-side patching can fix.

RapidOCR uses the SAME PaddleOCR models (PP-OCRv4 detection + recognition
+ classification) but runs them through Microsoft's ONNX Runtime instead
of paddlepaddle. Same neural network, same predictions, different inference
engine. ONNX Runtime is thread-safe, releases memory cleanly between
calls, and has no oneDNN integration to break.

## What changed in this build

| File | Change |
|------|--------|
| `requirements.txt` | Removed `paddleocr` + `paddlepaddle`. Added `rapidocr-onnxruntime`, `onnxruntime`, `opencv-python-headless`. |
| `rapid_ocr_adapter.py` | **NEW.** Thin wrapper around RapidOCR that exposes PaddleOCR's `.ocr(img, cls=True)` API. Means every existing call site in `main.py`, `searchable_pdf.py`, `automap.py`, `text_pipeline.py` works without modification. |
| `main.py` | Replaced `from paddleocr import PaddleOCR` with the adapter import. Removed the `_LockedOCR` wrapper class (no longer needed — RapidOCR is thread-safe). Removed `FLAGS_use_mkldnn` env workarounds. The rest of `main.py` (endpoints, OCR semaphore, store, etc.) is unchanged from the memory-safe build. |
| `ecosystem.config.js` | Removed `FLAGS_use_mkldnn` and `FLAGS_enable_mkldnn` env vars (no longer needed). Tuning defaults: 40 sessions / 5400s TTL / 4 concurrency / 300 DPI / 4500M memory cap. |
| `pdf_store.py` | Unchanged from the memory-safe build. |

**Files that were NOT touched:** `searchable_pdf.py`, `text_pipeline.py`,
`automap.py`, `table_extract.py`, `vector_extract.py`, `date_extract.py`,
`search_index.py`, `batch_service.py`, `services/doc_converter.py`,
`run_dev.py`. Your pipeline logic is identical.

## Deployment

```bash
# 0) From /root/test on the server
cd /root/test

# 1) Snapshot the current (PaddleOCR) build
cp -a pexl_api pexl_api.backup.paddleocr.$(date +%Y%m%d_%H%M%S)

# 2) Stop pexl-backend
pm2 stop pexl-backend
pm2 delete pexl-backend

# 3) Drop in the new build
cd pexl_api
unzip -o /root/pexl_api_rapidocr.zip

# 4) Install RapidOCR into the existing venv. paddleocr + paddlepaddle
#    can be left installed — they're ignored by the new code — but
#    removing them frees ~2 GB of disk and venv space.
source venv/bin/activate
pip uninstall -y paddleocr paddlepaddle
pip install -r requirements.txt
deactivate

# 5) Verify the new adapter is importable
./venv/bin/python -c "from rapid_ocr_adapter import RapidOCRAdapter; print('OK')"

# 6) Syntax-check everything
./venv/bin/python -m py_compile main.py pdf_store.py rapid_ocr_adapter.py searchable_pdf.py

# 7) Start under the new config
pm2 start ecosystem.config.js --update-env
pm2 save

# 8) Watch startup (RapidOCR downloads its ONNX models on first run,
#    can take 10–30 seconds depending on network)
pm2 logs pexl-backend --lines 80 --nostream
```

## Verification

```bash
# Health
curl -s http://127.0.0.1:8006/api/utility/health
# Expected: {"status":"ok"}

# Confirm new build is active
curl -s http://127.0.0.1:8006/api/utility/admin/stats | python3 -m json.tool
# Expected: max_sessions=40, ttl_sec=5400, ocr_max_concurrency=4, render_dpi=300

# Process should be MUCH smaller at idle than PaddleOCR was
ps -C python3 -o pid,rss,vsz,cmd | grep pexl
# Expected RSS: ~400-700 MB (was ~1.5 GB with PaddleOCR)

# Upload a real PDF and watch memory behaviour
# (do this in a separate terminal)
watch -n 5 'echo "=== $(date) ==="; \
  pm2 list | grep pexl-backend; \
  curl -s http://127.0.0.1:8006/api/utility/admin/stats | python3 -m json.tool | head -10; \
  free -h | head -3'
```

## What success looks like

After running the 29-page PDF that previously OOMed the server:

* **No "could not execute a primitive" warnings.** This error was specific
  to paddlepaddle's oneDNN integration; RapidOCR can't produce it.
* **RSS climbs while OCR runs, then comes back down between requests.**
  Previously it climbed monotonically because of the per-call leak.
* **No PM2 restarts.** The worker should stay alive through the whole
  document, then for the next one, and the next.
* **Throughput similar to before.** Same models, same per-page inference
  cost. Don't expect a speedup — expect stability.

## If RapidOCR can't read something the old build could

Possible but unlikely on clean typed PDFs. If you see accuracy regressions
on specific documents, the model files are identical so the issue would
be in the adapter. Things to check:

1. **Result-shape bug** — capture an example via:
   ```bash
   pm2 logs pexl-backend | grep -i "ocr"
   ```
2. **Image preprocessing difference** — RapidOCR normalises differently;
   for some weird inputs (very high contrast, unusual aspect ratios) it may
   detect text boundaries differently.

If accuracy is unacceptable on a specific document type, the rollback
path is to restore the PaddleOCR backup. It's 60 seconds — see below.

## Rollback

```bash
pm2 delete pexl-backend
cd /root/test
mv pexl_api pexl_api.failed
mv pexl_api.backup.paddleocr.<timestamp> pexl_api
cd pexl_api
pm2 start ecosystem.config.js
pm2 save
```

The PaddleOCR build is preserved in your backup directory; nothing about
this deploy is destructive.

## Memory comparison (typical numbers)

| Scenario | PaddleOCR build | RapidOCR build |
|---|---|---|
| Idle worker | ~1.5 GB | ~400-700 MB |
| Processing a 5-page PDF | climbs to ~2.5 GB | ~1 GB peak, drops back |
| Processing a 30-page PDF | climbs to 13+ GB, OOM | ~1.5 GB peak, stable |
| After 100 pages | OOM long ago | unchanged |

These are estimates; your real numbers will vary by PDF content.

## Tunables (unchanged from previous build)

All knobs live in `ecosystem.config.js`. Edit and run
`pm2 restart pexl-backend --update-env` to apply without redeploying code.

| Env var | Default | Effect |
|---|---|---|
| `PEXL_MAX_SESSIONS` | 400 | Hard cap on simultaneous live PDFs |
| `PEXL_SESSION_TTL_SEC` | 5400 | Session expiry (1.5 h) |
| `PEXL_OCR_MAX_CONCURRENCY` | 4 | Parallel OCR pipelines |
| `PEXL_RENDER_DPI` | 300 | Region-OCR render quality |
| `max_memory_restart` | 6G | PM2 clean-restart threshold |

---

## OCR speed patch (double-OCR elimination)

### What was slow

A 29-page fully-scanned PDF took ~8m44s to produce a downloadable searchable
PDF. The root cause was **every scanned page being OCR'd twice**:

1. **On upload** — `_build_index_bg` calls `build_structured_pages`, which
   OCRs every scanned page and stores the results in `pdf_doc.structured_pages`.
2. **On `/ocr-pdf` download** — `_build_image_only_searchable_pdf` re-renders
   every page and runs OCR again from scratch, ignoring the cached results.

For a 29-page scan this means 58 OCR calls for one PDF download.

### What was changed

**`searchable_pdf.py` — `_build_image_only_searchable_pdf`**

Before the OCR call for each page, the function now checks
`pdf_doc.structured_pages[page_idx]`. If that page was already OCR'd
(`Page.is_ocr == True`) and has words, the cached `Word.bbox` coordinates
(already in PDF points) are used directly to build the invisible text overlay —
no second OCR call needed.

The native-text path is deliberately excluded: if a page was classified as
native (not scanned), its cached words came from the PDF text layer, which
may be garbled — the whole reason `image_only=True` mode exists. Only
scanned-page results are reused.

Fallback is automatic: if `structured_pages` is None (background build not yet
complete), or the page has no cached words, the code falls through to the
existing OCR path unchanged.

### Expected speedup

| Scenario | Before | After |
|---|---|---|
| 29-page fully-scanned PDF | ~8m44s (58 OCR calls) | ~4–5m (29 OCR calls) |
| Second download of same session | cached, instant | cached, instant |
| 1-page utility bill | ~18s | ~18s (no change) |
| Mixed PDF (some native, some scanned) | scales with scanned count | same |

**If the user calls `/ocr-pdf` before the background index build finishes**
(i.e. immediately after upload), the cache will be empty and OCR runs at
full cost — same as before. The speedup is fully realized when the background
build completes first, which is the normal usage pattern.

### Files changed

| File | Change |
|---|---|
| `searchable_pdf.py` | Added cache check in `_build_image_only_searchable_pdf` before each OCR call. ~35 lines added. |
