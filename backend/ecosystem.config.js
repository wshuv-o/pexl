// PM2 ecosystem config for pexl_api (patched build)
//
// Deployment notes
// ----------------
//   1) Copy this file alongside main.py.
//   2) From the project directory, run:
//        pm2 delete pexl_api 2>/dev/null
//        pm2 start ecosystem.config.js
//        pm2 save
//        pm2 startup     # only once per server, to install the boot hook
//
// What this config buys you
// -------------------------
//   * max_memory_restart: PM2 cleanly restarts the worker when RSS hits 3.5 GB,
//     long BEFORE the kernel OOM killer fires. Other services on the box stay
//     up — the crash is localised to this app.
//   * exp_backoff_restart_delay: if the worker is genuinely sick, PM2 backs
//     off restart attempts instead of fork-bombing.
//   * env: tunes the in-app memory knobs. Adjust freely without editing code.
//   * stop_exit_codes / kill_timeout: gives FastAPI's shutdown hook 8 s to
//     close sessions and flush temp files before SIGKILL.
//
// Tuning guide
// ------------
//   Current settings (throughput-leaning, suitable for the 15 GB box):
//     PEXL_OCR_MAX_CONCURRENCY=4   PEXL_MAX_SESSIONS=400
//     PEXL_SESSION_TTL_SEC=5400    PEXL_RENDER_DPI=300
//     max_memory_restart: '6G'
//
//   If pexl_api is sharing the box with more demanding services:
//     PEXL_OCR_MAX_CONCURRENCY=2   PEXL_MAX_SESSIONS=400
//     PEXL_SESSION_TTL_SEC=1800    PEXL_RENDER_DPI=220
//     max_memory_restart: '3G'
//
//   If users complain about lost sessions on larger batches:
//     PEXL_SESSION_TTL_SEC=10800   (3 h)
//     PEXL_MAX_SESSIONS=500
//     max_memory_restart: '8G'   (also raise systemd MemoryMax if installed)
module.exports = {
  apps: [
    {
      name: 'pexl_api',
      script: 'venv/bin/uvicorn',
      args: 'main:app --host 0.0.0.0 --port 8006 --workers 1 --proxy-headers --forwarded-allow-ips=*',
      interpreter: 'none',

      // Memory safety — the single most important setting on this box.
      // Bumped from 4500M → 6G to accommodate the higher session cap; most
      // sessions >30MB spill to disk (see DISK_THRESHOLD_MB) so 6G leaves
      // ~9G for MySQL / Node apps on the 15G box.
      max_memory_restart: '6G',

      // Restart strategy
      autorestart: true,
      max_restarts: 20,
      min_uptime: '30s',
      exp_backoff_restart_delay: 2000,

      // Give FastAPI's shutdown hook time to close sessions and unlink temp files.
      kill_timeout: 8000,

      // Logs
      out_file:    '/root/.pm2/logs/pexl_api-out.log',
      error_file:  '/root/.pm2/logs/pexl_api-error.log',
      merge_logs:  true,
      time:        true,

      // Tunables (patched build picks these up at startup)
      //
      // Current settings prioritise throughput and user experience over
      // raw frugality. The box has 15 GB; with these values pexl_api can
      // use up to ~6 GB before PM2 restarts it. That still leaves
      // ~9 GB for MySQL, Logflare, Node apps, etc.
      env: {
        PEXL_MAX_SESSIONS:         '400',    // batches of a few hundred PDFs
        PEXL_SESSION_TTL_SEC:      '5400',   // 1.5 h — users won't lose work over lunch
        PEXL_SWEEPER_INTERVAL_SEC: '60',
        PEXL_DISK_THRESHOLD_MB:    '30',
        PEXL_OCR_MAX_CONCURRENCY:  '4',      // 4 OCR pipelines can run in parallel
        PEXL_RENDER_DPI:           '300',    // original quality preserved
        // RapidOCR uses ONNX Runtime — no paddle/oneDNN environment
        // workarounds needed. Removed from this build.
        //
        // Cap math libs to a sensible thread count; the box also runs
        // MySQL, Logflare, multiple Node apps. Leaving these unset lets
        // OpenBLAS/MKL spawn 1 thread per core and steal CPU from
        // everyone else. ONNX Runtime also respects these.
        OMP_NUM_THREADS:     '2',
        OPENBLAS_NUM_THREADS:'2',
        MKL_NUM_THREADS:     '2',
      },
    },
  ],
};
