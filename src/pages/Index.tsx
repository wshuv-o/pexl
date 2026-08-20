/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import {
  Upload, ChevronLeft, ChevronRight,
  AlertTriangle, FileSearch, X, ShieldCheck, LogOut,
  RotateCw, Eraser, DownloadCloud, Loader2, XCircle, Check,
  Pause, Play, Square, Layers,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import UploadZone from '@/components/UploadZone';
import PDFCardList from '@/components/PDFCardList';
import PDFViewer from '@/components/PDFViewer';
import ExcelPanel from '@/components/ExcelPanel';
import BatchPanel from '@/components/BatchPanel';
import ThemeToggle from '@/components/ThemeToggle';
import type { PDFSession, Highlight, ExtractedRow, DocumentType } from '@/types/utilscraper';
import { DOCUMENT_TYPES } from '@/types/utilscraper';
import { processFile, extractRegions, downloadAllOcrPdfsAsZip, getOcrProgress, triggerForceOcr, rotateSessionPdf, fetchConvertedPdf, extractTableRegion } from '@/lib/api';
import { highlightSlots, applyRegionUpdates } from '@/lib/extract-merge';
import { rasterizeIfVectorOnly } from '@/lib/vector-pdf-rasterizer';
import { sessionsCache } from '@/lib/sessions-cache';
import { useAuth } from '@/contexts/AuthContext';

export default function Index() {
  const { user, trackUsage, trackDownload, logout } = useAuth();
  const navigate = useNavigate();
  // Hydrate from the module-level cache so navigating to /usage and back
  // doesn't drop the open PDFs / extracted data. The cache lives as long
  // as the JS module — does NOT survive a hard refresh.
  const [sessions, setSessions]                 = useState<PDFSession[]>(() => sessionsCache.sessions);
  const [openTabs, setOpenTabs]                 = useState<string[]>(() => sessionsCache.openTabs);
  const [activeTabId, setActiveTabId]           = useState<string | null>(() => sessionsCache.activeTabId);
  const [pendingFiles, setPendingFiles]         = useState<File[]>([]);
  const [processing, setProcessing]             = useState(false);
  // Legacy processing-modal state removed — uploads no longer show a
  // blocking overlay. Each file's tab now spawns immediately with its own
  // 'processing' spinner. Matches boss-pdf's queue-list UX.
  const [extracting, setExtracting]             = useState(false);
  // Batch-extract run controls (pause / resume / stop) + live progress for
  // the floating control card. `extractCtrl` is a ref so the worker pool
  // always reads the latest flags without stale-closure issues.
  const [batchProgress, setBatchProgress]       = useState<{ done: number; total: number } | null>(null);
  const [batchPaused, setBatchPaused]           = useState(false);
  const extractCtrl = useRef<{ paused: boolean; cancelled: boolean }>({ paused: false, cancelled: false });
  const [showExcel, setShowExcel]               = useState(false);
  const [showBatchPanel, setShowBatchPanel]     = useState(false);
  const [excelWidth, setExcelWidth]             = useState(480); // px, draggable
  const [backendDown, setBackendDown]           = useState(false);
  const [zippingOcr, setZippingOcr]             = useState(false);
  const [forcingOcrId, setForcingOcrId]         = useState<string | null>(null);
  const [rotatingId, setRotatingId]             = useState<string | null>(null);
  const [rotatingAllPdfs, setRotatingAllPdfs]   = useState(false);
  // Separate boolean for the CCW batch button so its spinner stays
  // independent of the CW one (a user can in theory have one in flight
  // and click the other — the disabled state needs to match its action).
  const [rotatingIdCcw, setRotatingIdCcw]       = useState<string | null>(null);
  const [rotatingAllPdfsCcw, setRotatingAllPdfsCcw] = useState(false);
  // Same but for the ctrl/cmd-selected PDFs only.
  const [rotatingSelectedPdfs, setRotatingSelectedPdfs]       = useState(false);
  const [rotatingSelectedPdfsCcw, setRotatingSelectedPdfsCcw] = useState(false);
  // True while the "confirm doc type before processing" modal is open.
  const [confirmProcessOpen, setConfirmProcessOpen] = useState(false);
  // Global doc-type picker (in the tab bar). Affects EVERY uploaded
  // session in one go — per the requirement, doc type is treated as a
  // single batch-wide setting, not per-file.
  const [globalDocTypeOpen, setGlobalDocTypeOpen] = useState(false);
  useEffect(() => {
    if (!globalDocTypeOpen) return;
    const onDocClick = () => setGlobalDocTypeOpen(false);
    window.addEventListener('click', onDocClick);
    return () => window.removeEventListener('click', onDocClick);
  }, [globalDocTypeOpen]);
  const [activeBatchId, setActiveBatchId]       = useState<number | null>(null);
  const [navCollapsed, setNavCollapsed]         = useState(false);
  const [pendingDocType, setPendingDocType]     = useState<DocumentType>('utility_bill');
  const [dragTabId, setDragTabId]               = useState<string | null>(null);
  // Tabs the user has multi-selected (Ctrl/Cmd+click). Independent of the
  // active tab. Drives "Apply highlights to selected PDFs".
  const [multiSelectedTabIds, setMultiSelectedTabIds] = useState<Set<string>>(new Set());
  // Anchor for Shift+click range selection. Updated by plain and Ctrl-clicks,
  // held fixed during Shift-clicks so you can keep extending the range.
  const [tabAnchorId, setTabAnchorId] = useState<string | null>(null);
  const [pageJump, setPageJump]                 = useState<{ sessionId: string; page: number; nonce: number } | null>(null);
  // Session-wide custom field labels — survive tab switches and show up in
  // every PDF's label picker.
  const [customFields, setCustomFields]         = useState<string[]>(() => sessionsCache.customFields);
  // Controls whether the PDF upload zone is visible in the sidebar.
  // Default true until files exist, then hidden so the sidebar stays
  // tidy; the user reveals it again with a "+ Add PDFs" chip.
  const [showUploadZone, setShowUploadZone]     = useState(true);

  const activeSession = sessions.find(s => s.id === activeTabId);
  const hasUploaded   = sessions.length > 0 || pendingFiles.length > 0;

  // The upload zone NEVER auto-hides. It used to collapse after processing,
  // which made adding the next folder a hunt for the "+ Add PDFs" chip every
  // time. After the first upload it renders in its compact form (a slim
  // "drop more" strip), and the user can still hide it manually with the
  // "hide" button if they want the sidebar tidy.

  // Mirror tab/session state into the module-level cache so it survives
  // unmounts (e.g. when navigating to /usage and back).
  useEffect(() => { sessionsCache.sessions = sessions;       }, [sessions]);
  useEffect(() => { sessionsCache.openTabs = openTabs;       }, [openTabs]);
  useEffect(() => { sessionsCache.activeTabId = activeTabId; }, [activeTabId]);
  useEffect(() => { sessionsCache.customFields = customFields; }, [customFields]);

  // Tab sessions in order, resolved from IDs
  const tabSessions = useMemo(
    () => openTabs.map(id => sessions.find(s => s.id === id)).filter(Boolean) as PDFSession[],
    [openTabs, sessions],
  );

  // Open a tab (add if not already open) and make it active
  const openTab = useCallback((id: string) => {
    setOpenTabs(prev => prev.includes(id) ? prev : [...prev, id]);
    setActiveTabId(id);
  }, []);

  // Close a tab; if it was active, switch to the nearest neighbour
  const closeTab = useCallback((id: string) => {
    ocrPollStopsRef.current[id] = true;
    setOpenTabs(prev => {
      const next = prev.filter(t => t !== id);
      if (activeTabId === id) {
        const idx = prev.indexOf(id);
        const neighbour = next[Math.min(idx, next.length - 1)] ?? null;
        setActiveTabId(neighbour);
      }
      return next;
    });
  }, [activeTabId]);

  // Ctrl+Tab / Ctrl+Shift+Tab cycle through open PDF tabs in Pexl. We try
  // to preventDefault so the browser doesn't switch its own tabs, but note
  // Chrome reserves Ctrl+Tab in some contexts and may still steal the
  // event. Alt+Tab is OS-level and can't be intercepted at all.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // PDF tab switching keybinds:
      //   Ctrl+Tab / Ctrl+Shift+Tab  → next / previous tab
      //   Alt+PageDown / Alt+PageUp  → next / previous tab
      //
      // We intentionally do NOT bind Ctrl+PageUp / Ctrl+PageDown because
      // Chrome (and most browsers) reserves those at the window-manager
      // level for switching *browser* tabs — JavaScript receives the
      // event but cannot suppress the browser's default tab switch.
      // Alt+PageUp / Alt+PageDown is the standard non-reserved
      // alternative (used by Gmail, GitHub, etc.).
      let delta = 0;
      if (e.ctrlKey && e.key === 'Tab')               delta = e.shiftKey ? -1 : 1;
      else if (e.altKey && !e.ctrlKey && e.key === 'PageDown') delta = 1;
      else if (e.altKey && !e.ctrlKey && e.key === 'PageUp')   delta = -1;
      else return;

      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable) return;
      }
      if (openTabs.length === 0) return;
      e.preventDefault();
      const curIdx = activeTabId ? openTabs.indexOf(activeTabId) : -1;
      const nextIdx = ((curIdx + delta) % openTabs.length + openTabs.length) % openTabs.length;
      setActiveTabId(openTabs[nextIdx]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openTabs, activeTabId]);

  // Combined extracted data from ALL sessions for the Excel panel
  const combinedExtractedData = useMemo(
    () => sessions.flatMap(s => s.extractedData),
    [sessions],
  );

  // Auto-process repeat uploads: the doc-type modal shows for the FIRST batch
  // (it has to — that's where the type gets picked), and afterwards every
  // further upload processes immediately with the same type, zero clicks.
  // Opt-out via the modal checkbox; the preference persists in localStorage.
  // autoProcessKick defers the runProcessing call one render so it sees the
  // freshly-appended pendingFiles.
  const [skipDocTypeConfirm, setSkipDocTypeConfirm] = useState<boolean>(
    () => localStorage.getItem('pexl_skip_doctype_confirm') !== '0',
  );
  useEffect(() => {
    localStorage.setItem('pexl_skip_doctype_confirm', skipDocTypeConfirm ? '1' : '0');
  }, [skipDocTypeConfirm]);
  const docTypeConfirmedOnce = useRef(false);
  const [autoProcessKick, setAutoProcessKick] = useState(0);

  const handleFilesSelected = useCallback((files: File[]) => {
    if (files.length === 0) return;
    // STAGE the files only — do NOT open the doc-type modal or start
    // processing yet. This lets the user upload several times (files from
    // different folders / paths) in one session and accumulate them all.
    // The doc-type picker is deferred to the explicit "Proceed" button, so
    // the type is chosen ONCE for the whole staged set instead of on every
    // upload. The staging bar in the sidebar shows the running count.
    setPendingFiles(prev => [...prev, ...files]);
  }, []);

  const runProcessing = useCallback(async () => {
    if (!pendingFiles.length) return;

    // Worker-pool concurrency for uploads. Bumped 3 → 6 to match the browser
    // per-host cap (chrome ~6). With PEXL_MAX_SESSIONS now at 400 the
    // backend session store is no longer the bottleneck, and each upload
    // is I/O-bound so 6 in-flight is the sweet spot. Drop back to 3 if
    // the Hostinger box shows sustained 4xx/5xx during a 300-file batch.
    const CONCURRENCY = 6;

    setProcessing(true);
    // NOTE: we no longer open the ProcessingModal here. Files show up as
    // tabs immediately (with their own per-tab spinner via status:
    // 'processing') so the user can see everything they dropped without
    // a blocking overlay. Matches boss-pdf's "queued list" UX.

    // ── Pre-create ALL sessions with 'processing' status BEFORE any
    // worker starts. This gives the boss-pdf effect: drop files, see
    // every tab appear instantly, each with a spinner. Workers just
    // update the existing session state as uploads complete.
    const stamp = Date.now();
    const preItems: Array<{ file: File; originalIdx: number; tempId: string; folderName: string | undefined }> =
      pendingFiles.map((f, idx) => {
        const relPath =
          (f as File & { __relativePath?: string }).__relativePath
          || (f as File & { webkitRelativePath?: string }).webkitRelativePath;
        const folderName = relPath && relPath.includes('/')
          ? relPath.split('/').slice(0, -1).join('\\')
          : undefined;
        return {
          file: f,
          originalIdx: idx,
          tempId: `temp-${stamp}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
          folderName,
        };
      });

    setSessions(prev => [
      ...prev,
      ...preItems.map(it => ({
        id: it.tempId,
        // stableKey mirrors the tempId at creation and is never touched
        // again — even when `id` gets swapped to the backend's real
        // session_id, or later replaced after a 404 recovery reupload.
        // The viewer uses this as its React `key` so an in-progress table
        // drawing survives a mid-extract session renewal.
        stableKey: it.tempId,
        filename: it.file.name,
        file: it.file,
        folderName: it.folderName,
        docType: pendingDocType,
        total_pages: 0,
        pages: [],
        status: 'processing' as const,
        highlights: {},
        extractedData: [],
        startPage: 1,
        uploadedAt: Date.now(),
      })),
    ]);
    setOpenTabs(prev => {
      const merged = [...prev];
      for (const it of preItems) {
        if (!merged.includes(it.tempId)) merged.push(it.tempId);
      }
      return merged;
    });
    // Activate the first newly-added tab so the user sees their upload
    // context immediately.
    setActiveTabId(preItems[0].tempId);
    setNavCollapsed(true);
    // Clear the pre-upload queue now that everything is in tabs.
    setPendingFiles([]);

    // Working queue for the workers.
    const queue = [...preItems];

    type Result = {
      originalIdx: number;
      sessionId: string | null;
      ocrCount: number;
      filename?: string;
      errorMsg?: string;
    };
    const results: Result[] = [];
    let hadNetworkError = false;

    const processOne = async (
      item: { file: File; originalIdx: number; tempId: string; folderName: string | undefined },
    ): Promise<Result> => {
      let file = item.file;
      const tempId = item.tempId;

      // Vector-only PDF rasterisation (same rule as before). Runs on the
      // client; can be slow for large vector PDFs but has no effect on
      // normal scanned/native PDFs.
      if (/\.pdf$/i.test(file.name)) {
        try {
          const result = await rasterizeIfVectorOnly(file, { dpi: 200 });
          if (result.rasterized) {
            file = result.file;
            toast(`Rasterized vector PDF "${item.file.name}" for OCR`, {
              icon: '📄', duration: 3500,
            });
          }
        } catch (err) {
          console.warn('[rasterizeIfVectorOnly] failed:', err);
        }
      }

      // Retry loop — 3 attempts total with exponential backoff. Uploading
      // a few hundred PDFs in one go regularly trips a transient 429/500
      // or aborted connection somewhere in the middle; giving those files
      // one or two more shots recovers most of them instead of silently
      // dropping the tab and forcing the user to re-upload manually.
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          await new Promise(r => setTimeout(r, 600 * attempt));
        }
        try {
          const result = await processFile(file, '', () => {});
          const ocrCount = result.pages.filter(p => p.is_ocr).length;

          setSessions(prev => prev.map(s => s.id === tempId
            ? {
                ...s,
                id: result.session_id,
                total_pages: result.total_pages,
                pages: result.pages,
                file: result.convertedPdf ?? s.file,
                filename: result.convertedPdf?.name ?? s.filename,
                status: 'ready' as const,
              }
            : s,
          ));
          setOpenTabs(prev => prev.map(t => t === tempId ? result.session_id : t));
          if (activeTabId === tempId) setActiveTabId(result.session_id);
          // Auto-OCR polling used to fire here (one 2s poll chain per
          // scanned-page session) — a 300-file batch would spawn ~150
          // concurrent poll chains that each hit /ocr-progress every 2s,
          // burying the backend under ~75 req/sec of pointless status
          // pings while it should be serving actual work. Backend OCR
          // still runs in the background whether or not the client
          // polls; the extract path will either see values (OCR ready)
          // or null (not ready yet, user can re-extract later). The
          // Force Re-OCR flow still polls because that's a single-file
          // user-initiated action where progress is worth showing.
          // if (ocrCount > 0) startOcrPolling(result.session_id);
          void ocrCount;

          return { originalIdx: item.originalIdx, sessionId: result.session_id, ocrCount };
        } catch (err: unknown) {
          lastErr = err;
        }
      }

      const msg = lastErr instanceof Error ? lastErr.message : 'Unknown error';
      // Log every failure to the console with filename so the user can dig
      // in later without having to catch individual toast pops. The
      // per-file red toast used to fire once per failure — on a 294-file
      // batch with 100+ failures they'd pile up and drown out the actually
      // useful "X succeeded, Y failed" summary that comes at the end.
      console.error(`[upload failed] ${item.file.name}: ${msg}`);
      setSessions(prev => prev.filter(s => s.id !== tempId));
      setOpenTabs(prev => prev.filter(t => t !== tempId));
      if (msg.includes('fetch') || msg.includes('network')) hadNetworkError = true;
      return { originalIdx: item.originalIdx, sessionId: null, ocrCount: 0, filename: item.file.name, errorMsg: msg };
    };

    const nWorkers = Math.min(CONCURRENCY, queue.length);
    const workers = Array.from({ length: nWorkers }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) return;
        const r = await processOne(item);
        results.push(r);
      }
    });
    await Promise.all(workers);

    // Tabs already appeared upfront (in their original click order), so
    // no re-sort is needed here. We just aggregate a summary toast.
    const failed = results.filter(r => r.sessionId === null);
    const nSuccess = results.length - failed.length;
    const totalOcrPages = results.reduce((sum, r) => sum + r.ocrCount, 0);
    if (nSuccess > 0) {
      const ocrSuffix = totalOcrPages > 0 ? ` — ${totalOcrPages} pages OCR'd` : '';
      toast.success(`${nSuccess} PDF${nSuccess !== 1 ? 's' : ''} ready${ocrSuffix}`);
      if (totalOcrPages > 0) {
        toast('Draw boxes over the values you want, then click Extract',
              { duration: 5000, icon: 'ℹ️' });
      }
    }
    // Explicit failure summary so a 108-of-294 silent drop is visible at
    // a glance. The per-file console.error above already lists the
    // filename + error message for each one — the toast points there.
    if (failed.length > 0) {
      const preview = failed.slice(0, 3).map(f => f.filename ?? '(unknown)').join(', ');
      const more = failed.length > 3 ? ` +${failed.length - 3} more` : '';
      toast.error(
        `${failed.length} upload${failed.length !== 1 ? 's' : ''} failed — check the DevTools console for details.\nFirst: ${preview}${more}`,
        { duration: 10000 },
      );
    }
    if (hadNetworkError) setBackendDown(true);

    setProcessing(false);
  }, [pendingFiles, pendingDocType, activeTabId]);

  // The user clicked "Proceed" after staging one or more upload batches.
  // NOW pick the doc type (once, for everything staged) and then process.
  // If the user previously ticked "don't ask again", skip straight to
  // processing with the remembered type.
  const handleProceed = useCallback(() => {
    if (!pendingFiles.length) return;
    if (skipDocTypeConfirm && docTypeConfirmedOnce.current) {
      setAutoProcessKick(k => k + 1);
    } else {
      setConfirmProcessOpen(true);
    }
  }, [pendingFiles.length, skipDocTypeConfirm]);

  // Auto-process kicked off by handleProceed when "don't ask again"
  // is on. Runs in an effect (not inline) so runProcessing's closure sees
  // the pendingFiles that were appended in the same render.
  useEffect(() => {
    if (autoProcessKick === 0) return;
    setAutoProcessKick(0);
    if (pendingFiles.length > 0) {
      const label = DOCUMENT_TYPES.find(t => t.value === pendingDocType)?.label ?? pendingDocType;
      toast.success(`Processing ${pendingFiles.length} file${pendingFiles.length !== 1 ? 's' : ''} as ${label}`);
      runProcessing();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoProcessKick]);

  // Tracks which sessions have active OCR polls running. Setting to true stops the loop.
  const ocrPollStopsRef = useRef<Record<string, boolean>>({});

  const startOcrPolling = useCallback((sessionId: string) => {
    ocrPollStopsRef.current[sessionId] = false;
    const poll = async () => {
      if (ocrPollStopsRef.current[sessionId]) return;
      const progress = await getOcrProgress(sessionId);
      if (!progress) return;
      setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, ocrProgress: progress } : s));
      if (!progress.done && !ocrPollStopsRef.current[sessionId]) {
        setTimeout(poll, 2000);
      }
    };
    poll();
  }, []);

  const undoStacks = useRef<Record<string, Record<number, Highlight[]>[]>>({});
  const redoStacks = useRef<Record<string, Record<number, Highlight[]>[]>>({});
  const clipboard  = useRef<Highlight[] | null>(null);
  // PDFViewer updates this with its currently-selected highlight IDs so
  // Ctrl+X can cut them from the session.
  const selectedHighlightIdsRef = useRef<Set<string>>(new Set());
  const MAX_HISTORY = 10;

  const cloneHighlights = (src: Record<number, Highlight[]>): Record<number, Highlight[]> => {
    const out: Record<number, Highlight[]> = {};
    for (const [k, v] of Object.entries(src)) out[Number(k)] = v.map(h => ({ ...h }));
    return out;
  };

  const pushUndoSnapshot = useCallback((sessionId: string, prevHighlights: Record<number, Highlight[]>) => {
    const stack = undoStacks.current[sessionId] ?? [];
    stack.push(cloneHighlights(prevHighlights));
    while (stack.length > MAX_HISTORY) stack.shift();
    undoStacks.current[sessionId] = stack;
    // Any new change invalidates the redo stack
    redoStacks.current[sessionId] = [];
  }, []);

  const handleHighlightsChange = useCallback((sessionId: string, highlights: Record<number, Highlight[]>) => {
    setSessions(prev => {
      const s = prev.find(ss => ss.id === sessionId);
      if (s) pushUndoSnapshot(sessionId, s.highlights);
      return prev.map(ss => ss.id === sessionId ? { ...ss, highlights } : ss);
    });
  }, [pushUndoSnapshot]);

  const performUndo = useCallback(() => {
    if (!activeTabId) return;
    const stack = undoStacks.current[activeTabId] ?? [];
    if (stack.length === 0) return;
    const prevSnapshot = stack.pop()!;
    setSessions(prev => prev.map(s => {
      if (s.id !== activeTabId) return s;
      // Push current state onto redo stack before replacing
      const redo = redoStacks.current[activeTabId] ?? [];
      redo.push(cloneHighlights(s.highlights));
      while (redo.length > MAX_HISTORY) redo.shift();
      redoStacks.current[activeTabId] = redo;
      return { ...s, highlights: prevSnapshot };
    }));
  }, [activeTabId]);

  const performRedo = useCallback(() => {
    if (!activeTabId) return;
    const stack = redoStacks.current[activeTabId] ?? [];
    if (stack.length === 0) return;
    const nextSnapshot = stack.pop()!;
    setSessions(prev => prev.map(s => {
      if (s.id !== activeTabId) return s;
      const undo = undoStacks.current[activeTabId] ?? [];
      undo.push(cloneHighlights(s.highlights));
      while (undo.length > MAX_HISTORY) undo.shift();
      undoStacks.current[activeTabId] = undo;
      return { ...s, highlights: nextSnapshot };
    }));
  }, [activeTabId]);

  // Ctrl+X — cut the highlights currently selected in the active PDFViewer.
  // Removes them from the session and copies them to the in-memory clipboard.
  // Does nothing if no highlights are selected.
  const performCut = useCallback(() => {
    if (!activeTabId) return;
    const selected = selectedHighlightIdsRef.current;
    if (selected.size === 0) return;
    setSessions(prev => prev.map(s => {
      if (s.id !== activeTabId) return s;
      const cut: Highlight[] = [];
      const remaining: Record<number, Highlight[]> = {};
      for (const [pageStr, pageHls] of Object.entries(s.highlights)) {
        const page = Number(pageStr);
        const keep: Highlight[] = [];
        for (const h of pageHls) {
          if (selected.has(h.id)) cut.push({ ...h });
          else keep.push(h);
        }
        if (keep.length > 0) remaining[page] = keep;
      }
      if (cut.length === 0) return s;
      pushUndoSnapshot(s.id, s.highlights);
      clipboard.current = cut;
      return { ...s, highlights: remaining };
    }));
    toast.success(`Cut ${selected.size} highlight${selected.size !== 1 ? 's' : ''}`);
  }, [activeTabId, pushUndoSnapshot]);

  // Ctrl+V — paste the clipboard highlights onto the active session, keeping
  // their original page numbers. New IDs are generated so re-paste creates
  // new copies. Extracted values are cleared so they'll re-extract.
  const performPaste = useCallback(() => {
    if (!activeTabId || !clipboard.current || clipboard.current.length === 0) return;
    setSessions(prev => prev.map(s => {
      if (s.id !== activeTabId) return s;
      pushUndoSnapshot(s.id, s.highlights);
      const next = cloneHighlights(s.highlights);
      for (const h of clipboard.current!) {
        const page = h.page;
        if (!next[page]) next[page] = [];
        next[page].push({
          ...h,
          id: `hl-${Date.now()}-${page}-${Math.random().toString(36).slice(2, 6)}`,
          extractedValue: undefined,
          confidence: undefined,
        });
      }
      return { ...s, highlights: next };
    }));
  }, [activeTabId, pushUndoSnapshot]);

  // Global Ctrl+Z / Ctrl+Y / Ctrl+X / Ctrl+V keybinds. Skipped while user is
  // typing in an input or contenteditable so built-in browser undo/cut/paste
  // for form fields still works.
  useEffect(() => {
    const isEditable = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
    };
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      if (isEditable(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); performUndo(); }
      else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); performRedo(); }
      else if (key === 'x') { e.preventDefault(); performCut(); }
      else if (key === 'v') { e.preventDefault(); performPaste(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [performUndo, performRedo, performCut, performPaste]);

  const handleStartPageChange = useCallback((sessionId: string, startPage: number) => {
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, startPage } : s));
  }, []);

  const handleBulkStartPageChange = useCallback((startPage: number) => {
    setSessions(prev => prev.map(s => {
      // Only apply if the PDF actually has that many pages
      const total = s.total_pages || s.pages.length;
      if (startPage > total) return s;
      return { ...s, startPage };
    }));
  }, []);

  // Pause/resume/stop controls for an in-flight batch extract. These flip
  // flags on the ref the worker pool polls; up-to-CONCURRENCY requests that
  // are already awaiting will still finish, but no NEW files start until
  // resumed (or the run is abandoned on stop).
  const pauseExtract  = useCallback(() => { extractCtrl.current.paused = true;  setBatchPaused(true);  }, []);
  const resumeExtract = useCallback(() => { extractCtrl.current.paused = false; setBatchPaused(false); }, []);
  const stopExtract   = useCallback(() => {
    extractCtrl.current.cancelled = true;
    extractCtrl.current.paused = false; // release the pause gate so workers can exit
    setBatchPaused(false);
  }, []);

  // Extract every session whose tab is currently OPEN and has highlights.
  // Closed-tab sessions keep their existing extractedData (still visible in
  // the Excel panel) but are skipped on subsequent extract runs — closing a
  // tab is our signal that the user is done with that PDF.
  const handleExtract = useCallback(async () => {
    const openTabSet = new Set(openTabs);
    // Only skip sessions that literally have no File blob (nothing to feed
    // pdfjs) or no highlights. We used to also require `status === ready |
    // extracted` — that silently dropped every session still being analysed
    // by the backend at click time, so a 294-file batch would return 29
    // results simply because 265 uploads hadn't finished their backend-side
    // analysis yet. Client-first extractRegions works on the raw File blob
    // via pdfjs and doesn't need the backend's is_ocr flag or page list, so
    // 'processing' sessions can extract just fine. Any highlight on an OCR
    // page whose backend session isn't ready falls through to null — same
    // outcome as if the network was slow, never worse.
    const targets = sessions.filter(s =>
      s.file
      && Object.values(s.highlights).flat().length > 0
      && s.status !== 'uploading'
      && openTabSet.has(s.id)
    );
    if (!targets.length) { toast('Draw highlight boxes first', { icon: 'ℹ️' }); return; }

    setExtracting(true);
    // Reveal the results panel up front so extracted rows stream into it live
    // as each file finishes, instead of appearing all at once at the end.
    setShowExcel(true);
    // Fresh run: clear any leftover pause/stop flags and seed the progress card.
    extractCtrl.current = { paused: false, cancelled: false };
    setBatchPaused(false);
    setBatchProgress({ done: 0, total: targets.length });
    let totalExtracted = 0;
    let totalNull = 0;
    // Pages we actually extracted from, summed over the run — the unit
    // odin-ems reports on. Counted per file as "distinct pages carrying at
    // least one highlight", not the PDF's page count, so a 40-page appraisal
    // with boxes on 3 pages contributes 3.
    let totalPagesExtracted = 0;

    // Bounded worker pool. The old `Promise.allSettled(targets.map(...))`
    // fired all N requests simultaneously, which just stacked up in the
    // browser's ~6-per-host HTTP queue AND the backend's OCR semaphore
    // (PEXL_OCR_MAX_CONCURRENCY=4). 6 workers matches those limits
    // exactly — same total throughput, cleaner progress feedback, no
    // browser thrash. Progress toast updates as each session completes.
    const CONCURRENCY = 6;
    // Multi-file runs surface progress in the floating control card (with
    // pause/stop); a single file just gets a lightweight spinner toast.
    const toastId = targets.length > 1 ? null : toast.loading('Extracting…');
    let done = 0;

    type WorkerResult = {
      sess: PDFSession;
      newHighlights: Record<number, Highlight[]>;
      sessResults: ExtractedRow[];
      liveId: string;
    };

    // Rows for the results panel, built from whatever values have landed so
    // far. Highlights still waiting on a page carry `extractedValue ===
    // undefined` and are simply absent, so the same builder serves both the
    // page-by-page partials and the final apply.
    const rowsOf = (
      hls: Record<number, Highlight[]>,
      sess: PDFSession,
      sessionId: string,
    ): ExtractedRow[] =>
      Object.values(hls).flat()
        .filter(h => h.extractedValue !== undefined)
        .map(h => ({
          page: h.page, field: h.field, value: h.extractedValue ?? null,
          confidence: h.confidence ?? 'low', wasOcr: h.wasOcr ?? false,
          filename: sess.filename, folderName: sess.folderName, sessionId,
        }));

    const runOne = async (sess: PDFSession): Promise<WorkerResult> => {
      const clearedHighlights: Record<number, Highlight[]> = {};
      for (const [pageNum, pageHls] of Object.entries(sess.highlights)) {
        clearedHighlights[Number(pageNum)] = pageHls.map(h => ({
          ...h, extractedValue: undefined, confidence: undefined, wasOcr: undefined,
        }));
      }
      const allHl = Object.values(clearedHighlights).flat();

      // Reverse route from a flat result index back to its page slot —
      // partial results name their slot because pages finish out of order.
      const slots = highlightSlots(clearedHighlights);

      // Working copy the partials fold into, held outside React state so a
      // burst of pages coalesces into one render.
      let live: Record<number, Highlight[]> = clearedHighlights;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        flushTimer = null;
        const snapshot = live;
        setSessions(prev => prev.map(s =>
          s.id === sess.id
            ? { ...s, highlights: snapshot, extractedData: rowsOf(snapshot, sess, s.id) }
            : s,
        ));
      };

      let liveId = sess.id;
      const results = await extractRegions(liveId, allHl, sess.file!, {
        strict: true,
        onSessionRenewed: (_oldId, newId) => {
          liveId = newId;
        },
        // Values for one page of this PDF, the moment that page resolves.
        // This is what makes a single multi-page document fill in as it goes
        // instead of sitting empty until its last page returns.
        onPartial: updates => {
          const next = applyRegionUpdates(live, slots, updates);
          if (next === live) return;          // nothing matched — no repaint
          live = next;
          // Coalesce: a 300-page document would otherwise fire 300
          // setSessions calls, each one mapping the whole session list.
          if (flushTimer === null) flushTimer = setTimeout(flush, 120);
        },
      });
      // Drop any pending flush — applyOne runs next with the authoritative
      // state, and a late timer would repaint a stale snapshot over it.
      if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }

      const newHighlights = { ...clearedHighlights };
      let idx = 0;
      for (const [pageNum, pageHls] of Object.entries(newHighlights)) {
        newHighlights[Number(pageNum)] = pageHls.map(h => {
          const r = results[idx++];
          return r ? { ...h, extractedValue: r.value, confidence: r.confidence, wasOcr: r.wasOcr } : h;
        });
      }
      const sessResults = rowsOf(newHighlights, sess, liveId);
      return { sess, newHighlights, sessResults, liveId };
    };

    // Apply each file's results to state the instant its worker finishes,
    // instead of collecting everything and doing one setSessions after the
    // whole pool drains. The results panel reads from sessions[].extractedData
    // (see combinedExtractedData), so streaming the updates in makes rows
    // appear live as each PDF completes — no waiting for all N files.
    const applyOne = (value: WorkerResult) => {
      const { sess, newHighlights, sessResults, liveId } = value;
      totalExtracted += sessResults.length;
      totalNull      += sessResults.filter(r => !r.value).length;
      // Tally here rather than at the end: a stopped run then reports only
      // the pages of the files it actually got through, matching how
      // `processed` below is capped at `done`.
      totalPagesExtracted += Object.values(newHighlights).filter(hls => hls.length > 0).length;
      setSessions(prev => prev.map(s =>
        s.id === sess.id
          ? { ...s, id: liveId, highlights: newHighlights, extractedData: sessResults, status: 'extracted' as const }
          : s,
      ));
      // A renewed backend session means the id changed mid-flight; keep the
      // open-tabs list and active tab pointing at the live id.
      if (liveId !== sess.id) {
        setOpenTabs(prev => prev.map(t => (t === sess.id ? liveId : t)));
        setActiveTabId(prev => (prev === sess.id ? liveId : prev));
      }
    };

    const queue = [...targets];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        // Stop → abandon the run. Pause → hold here (polling the flag) until
        // resumed or stopped, without spinning the CPU.
        if (extractCtrl.current.cancelled) return;
        while (extractCtrl.current.paused && !extractCtrl.current.cancelled) {
          await new Promise(r => setTimeout(r, 150));
        }
        if (extractCtrl.current.cancelled) return;
        const sess = queue.shift();
        if (!sess) return;
        try {
          applyOne(await runOne(sess));
        } catch (reason: any) {
          toast.error(`Extraction failed: ${reason?.message ?? 'unknown error'}`);
        }
        done++;
        setBatchProgress({ done, total: targets.length });
      }
    });
    await Promise.all(workers);
    if (toastId) toast.dismiss(toastId);

    // Batch extract loads pdfjs documents for every session it touched via
    // the client-first fast path. Even with the LRU cap in pdf-extract.ts,
    // ~12 large PDFs stay parked in memory. For a 300-file batch that's
    // fine mid-run but wasteful afterwards; free them so the browser can
    // reclaim the memory before the user opens the next tab / extracts
    // another batch. Also drops the per-page text-content cache.
    //
    // BUT keep the documents for the tabs the user still has open cached —
    // otherwise a single-row Re-extract right after a batch pays a full cold
    // pdfjs reload + text re-parse of the whole PDF, which is what made the
    // per-row Re-extract button feel like it hung ("40 rows fast, one row
    // slow"). Open tabs are the only files a Re-extract can realistically hit.
    try {
      const { clearDocumentCacheExcept } = await import('@/lib/pdf-extract');
      const keepFiles = sessions
        .filter(s => openTabs.includes(s.id) && s.file)
        .map(s => s.file!) as File[];
      clearDocumentCacheExcept(keepFiles);
    } catch { /* non-fatal */ }

    const stopped = extractCtrl.current.cancelled;
    setBatchProgress(null);
    setBatchPaused(false);

    if (stopped) {
      toast(`Stopped — extracted ${totalExtracted} value${totalExtracted !== 1 ? 's' : ''} from ${done} of ${targets.length} PDF${targets.length !== 1 ? 's' : ''}`, { icon: '⏹️' });
    } else {
      toast.success(`Extracted ${totalExtracted} value${totalExtracted !== 1 ? 's' : ''} from ${targets.length} PDF${targets.length !== 1 ? 's' : ''}`);
    }
    if (totalNull > 0) toast.warning(`${totalNull} field${totalNull !== 1 ? 's' : ''} returned empty`);
    setExtracting(false);

    // Track usage — count only the files actually processed, so a stopped run
    // isn't billed for the PDFs it never touched. On a full run `done` equals
    // targets.length, so this is unchanged for the common case.
    // Report each session's doc type so the usage dashboard can show
    // "user X scraped N appraisal, M utility_bill, …", and use the *earliest*
    // uploadedAt as the batch start so (finished_at − uploaded_at) reflects
    // the user's full waiting time.
    const processed = targets.slice(0, done);
    const docTypes = processed.map(t => t.docType);
    const uploadStarts = processed
      .map(t => t.uploadedAt)
      .filter((n): n is number => typeof n === 'number');
    const batchUploadedAt = uploadStarts.length > 0 ? Math.min(...uploadStarts) : undefined;
    trackUsage(processed.length, totalExtracted, docTypes, batchUploadedAt, Date.now(), totalPagesExtracted)
      .catch(() => {});
  }, [sessions, openTabs, trackUsage]);

  const handleReExtractPage = useCallback(async (sessionId: string, page: number) => {
    const sess = sessions.find(s => s.id === sessionId);
    if (!sess) {
      toast.error('Session not found — try re-uploading the file');
      return;
    }
    if (!sess.file) {
      // File blob is gone (cache-hydrated session). Without it we can't
      // recover the session if the backend has evicted it. Tell the user
      // instead of silently failing — that's what made the per-row
      // Re-extract button feel broken.
      toast.error('Original file is no longer in this tab — re-upload to re-extract');
      return;
    }
    const pageHighlights = sess.highlights[page] ?? [];
    if (!pageHighlights.length) { toast('No highlights on this page', { icon: 'ℹ️' }); return; }

    // Track the live session id — may be renewed once if the session expired.
    let liveId = sessionId;

    setExtracting(true);
    try {
      const cleared = pageHighlights.map(h => ({ ...h, extractedValue: undefined, confidence: undefined, wasOcr: undefined }));
      const results = await extractRegions(liveId, cleared, sess.file, {
        strict: true,
        onSessionRenewed: (oldId, newId) => {
          liveId = newId;
          setSessions(prev => prev.map(s => s.id === oldId ? { ...s, id: newId } : s));
        },
      });

      setSessions(prev => prev.map(s => {
        if (s.id !== liveId) return s;
        const newHls = { ...s.highlights };
        newHls[page] = (s.highlights[page] ?? []).map((h, i) => {
          const r = results[i];
          return r ? { ...h, extractedValue: r.value, confidence: r.confidence, wasOcr: r.wasOcr } : h;
        });
        const allResults: ExtractedRow[] = Object.values(newHls).flat()
          .filter(h => h.extractedValue !== undefined)
          .map(h => ({
            page: h.page, field: h.field, value: h.extractedValue ?? null,
            confidence: h.confidence ?? 'low', wasOcr: h.wasOcr ?? false,
            filename: s.filename, folderName: s.folderName, sessionId: s.id,
          }));
        // Preserve any manually-edited values for OTHER pages
        const editedOtherPages = s.extractedData.filter(r => r.page !== page && r.edited);
        for (const e of editedOtherPages) {
          const idx = allResults.findIndex(r => r.sessionId === e.sessionId && r.page === e.page && r.field === e.field);
          if (idx >= 0) allResults[idx] = { ...allResults[idx], value: e.value, edited: true };
        }
        return { ...s, highlights: newHls, extractedData: allResults, status: 'extracted' as const };
      }));
      toast.success(`Re-extracted page ${page}`);
    } catch (err: any) { toast.error(`Re-extraction failed: ${err.message}`); }
    setExtracting(false);
  }, [sessions]);

  const handleReExtractHighlight = useCallback(async (highlightId: string) => {
    if (!activeSession?.file) return;
    // Read the highlight's bounds from the LATEST session state (not the stale
    // closure) — this matters right after a resize, where `handleResizeHighlight`
    // has just scheduled a geometry update that hasn't committed yet.
    let found: Highlight | null = null;
    setSessions(prev => prev.map(s => {
      if (s.id !== activeSession.id) return s;
      const hls: Record<number, Highlight[]> = {};
      for (const [pageNum, pageHls] of Object.entries(s.highlights)) {
        hls[Number(pageNum)] = pageHls.map(h => {
          if (h.id === highlightId) {
            found = { ...h, extractedValue: undefined, confidence: undefined };
            return found!;
          }
          return h;
        });
      }
      return { ...s, highlights: hls };
    }));
    if (!found) return;
    setExtracting(true);
    try {
      const results = await extractRegions(activeSession.id, [found], activeSession.file, { strict: true });
      const result = results[0];
      if (!result) return;
      setSessions(prev => prev.map(s => {
        if (s.id !== activeSession.id) return s;
        const hls = { ...s.highlights };
        for (const [pageNum, pageHls] of Object.entries(hls))
          hls[Number(pageNum)] = pageHls.map(h => h.id === highlightId
            ? { ...h, extractedValue: result.value, confidence: result.confidence, wasOcr: result.wasOcr } : h);
        const allResults: ExtractedRow[] = Object.values(hls).flat()
          .filter(h => h.extractedValue !== undefined)
          .map(h => ({
            page: h.page, field: h.field, value: h.extractedValue ?? null,
            confidence: h.confidence ?? 'low', wasOcr: h.wasOcr ?? false,
            filename: s.filename, folderName: s.folderName, sessionId: s.id,
          }));
        return { ...s, highlights: hls, extractedData: allResults };
      }));
      if (result.value) toast.success(`Re-extracted: ${result.value}`);
      else toast.warning('Re-extraction returned empty');
    } catch (err: any) { toast.error(`Re-extraction failed: ${err.message}`); }
    setExtracting(false);
  }, [activeSession]);

  // Mirror the active session's highlights to all other PDFs. The highlight
  // BOXES on target PDFs are repositioned by searching the target text for
  // whatever text the source highlight was sitting on — so the boxes end up
  // over the correct text even when the target's layout differs. Falls back
  // to raw coords if the text can't be located (scanned page, no match).
  const handleApplyToAllPdfs = useCallback(async (
    sourceHighlights: Record<number, Highlight[]>,
    // Optional — if provided, mirror only to these session IDs. Used by
    // "Apply highlights to selected PDFs" (ctrl-click tabs to build the set).
    restrictIds?: Set<string>,
  ) => {
    const sourceSession = sessions.find(s => s.id === activeTabId);
    if (!sourceSession?.file) return;
    const srcStart = sourceSession.startPage || 1;

    // Same permissive filter as handleExtractTableFromPdfs — the old strict
    // `status in ('ready','extracted') && !!file` dropped sessions still in
    // 'processing' state at click time (a 294-file batch shows as "copied
    // to 60 PDFs" simply because 234 were still analysing). Client-side
    // copy doesn't need the local file, and it doesn't matter whether the
    // backend has finished analysing — we're just writing highlights to
    // React state on each target session.
    const targets = sessions.filter(s =>
      s.id !== activeTabId
      && s.status !== 'uploading'
      && (restrictIds ? restrictIds.has(s.id) : true),
    );

    // Clone each source highlight onto the equivalent target page at the
    // same raw coordinates — no text lookup, no auto-snapping to matching
    // text on the target PDF.
    const perTargetUpdates = targets.map(target => {
      const tgtStart = target.startPage || 1;
      // total_pages is 0 while the backend is still analysing a session.
      // Fall back to Infinity so the page-bounds check below doesn't
      // silently drop every highlight for 'processing' sessions. A 294-file
      // batch previously got highlights on only the ~20 sessions that had
      // made it to 'ready' at click time — the rest hit `tgtPage > 0` and
      // were skipped. Extraction later re-validates: a highlight that
      // lands on a non-existent page just returns null, which is exactly
      // the same outcome as if we'd skipped it, without dropping the whole
      // session.
      const totalPgs = target.total_pages || target.pages.length || Infinity;
      const next: Record<number, Highlight[]> = {};

      for (const [pageStr, pageHls] of Object.entries(sourceHighlights)) {
        const srcPage = Number(pageStr);
        const tgtPage = tgtStart + (srcPage - srcStart);
        if (tgtPage < 1 || tgtPage > totalPgs) continue;

        next[tgtPage] = pageHls.map(h => ({
          ...h,
          id: `hl-${Date.now()}-${target.id.slice(-4)}-${tgtPage}-${Math.random().toString(36).slice(2, 6)}`,
          page: tgtPage,
          extractedValue: undefined,
          confidence: undefined,
        }));
      }

      return { id: target.id, next };
    });

    setSessions(prev => prev.map(s => {
      const update = perTargetUpdates.find(u => u.id === s.id);
      if (!update) return s;
      return { ...s, highlights: update.next, extractedData: [], status: 'ready' as const };
    }));

    const totalApplied = perTargetUpdates.reduce((sum, u) => sum + Object.values(u.next).flat().length, 0);
    if (totalApplied === 0) {
      toast('No matching target PDFs were updated.', { icon: 'ℹ️' });
    } else {
      const scope = restrictIds ? 'selected PDF' : 'PDF';
      toast.success(`Mirrored to ${perTargetUpdates.length} ${scope}${perTargetUpdates.length !== 1 ? 's' : ''}`);
    }
  }, [activeTabId, sessions]);

  // Apply key-anchored auto-extract pairs to every other open PDF.
  // For each pair: search every page of every other open PDF for the
  // captured key text. On each match, place a value highlight at
  // (keyMatch + offset). Only the value is highlighted on targets — the
  // key was just for anchoring.
  const handleAutoApplyAllPdfs = useCallback(async (
    pairs: ReadonlyArray<{
      field: string;
      fieldLabel: string;
      sourcePage: number;
      keyText: string;
      offsetX: number;
      offsetY: number;
      valueWidth: number;
      valueHeight: number;
      sourceKeyX: number;
      sourceKeyY: number;
      useAbsoluteCoords?: boolean;
      absoluteValueX?: number;
      absoluteValueY?: number;
    }>,
    tableOnly: boolean,
  ) => {
    const { findAllTextPositionsInPdfPage, detectTableRegionsInPdfPage } = await import('@/lib/pdf-extract');
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

    const targets = sessions.filter(s =>
      s.id !== activeTabId
      && (s.status === 'ready' || s.status === 'extracted')
      && !!s.file,
    );
    if (targets.length === 0) {
      toast('No other open PDFs to apply to.', { icon: 'ℹ️' });
      return;
    }

    let totalAdded = 0;
    let pdfsTouched = 0;
    const perTarget: { id: string; merged: Record<number, Highlight[]> }[] = [];

    for (const target of targets) {
      const file = target.file!;
      const totalPgs = target.total_pages || target.pages.length;
      const merged: Record<number, Highlight[]> = { ...target.highlights };
      let addedHere = 0;

      // Per-page table region cache for this target.
      const tableCache = new Map<number, Array<{ x: number; y: number; width: number; height: number }>>();
      const getTables = async (pg: number) => {
        if (tableCache.has(pg)) return tableCache.get(pg)!;
        const t = await detectTableRegionsInPdfPage(file, pg);
        tableCache.set(pg, t);
        return t;
      };
      const preferInTable = async (
        cands: Array<{ x: number; y: number; width: number; height: number }>,
        pg: number,
      ) => {
        if (cands.length === 0) return null;
        if (cands.length === 1 && !tableOnly) return cands[0];
        const tables = await getTables(pg);
        if (tables.length > 0) {
          const inTable = cands.filter(c =>
            tables.some(t =>
              c.x + c.width  / 2 >= t.x && c.x + c.width  / 2 <= t.x + t.width &&
              c.y + c.height / 2 >= t.y && c.y + c.height / 2 <= t.y + t.height,
            ),
          );
          if (inTable.length > 0) return inTable[0];
        }
        if (tableOnly) return null;
        return cands[0];
      };

      for (let pg = 1; pg <= totalPgs; pg++) {
        if (pg % 5 === 0) await new Promise(r => setTimeout(r, 0));
        for (const p of pairs) {
          try {
            let x: number, y: number, w: number, h: number;

            if (p.useAbsoluteCoords) {
              // Key was completely unreadable — apply only to the same page as the
              // source drawing; placing at absolute coords on every page is wrong.
              if (pg !== p.sourcePage) continue;
              x = p.absoluteValueX!;
              y = p.absoluteValueY!;
              w = p.valueWidth;
              h = p.valueHeight;
            } else {
              // Constrain key search to the region where the key appeared on the
              // source page (±35% X, ±25% Y). Handles layout drift across PDFs
              // without grabbing a wrong same-named label elsewhere on the page.
              const inSearchRegion = (c: { x: number; y: number; width: number; height: number }) => {
                const cx = c.x + c.width / 2, cy = c.y + c.height / 2;
                return cx >= Math.max(0, p.sourceKeyX - 0.35) && cx <= Math.min(1, p.sourceKeyX + 0.35)
                    && cy >= Math.max(0, p.sourceKeyY - 0.25) && cy <= Math.min(1, p.sourceKeyY + 0.25);
              };
              // Locate the key on this page via pdfjs (text layer). Constrain
              // to the source region so we don't grab a same-named label
              // elsewhere on the page.
              let match: { x: number; y: number; width: number; height: number } | null = null;
              const allCands = await findAllTextPositionsInPdfPage(file, pg, p.keyText);
              const regionCands = allCands.filter(inSearchRegion);
              match = await preferInTable(regionCands.length > 0 ? regionCands : allCands, pg);
              // No key found anywhere — place value at the source coordinates on every
              // page so layout drift is handled statically rather than skipping.
              if (!match) {
                x = clamp01(p.sourceKeyX + p.offsetX);
                y = clamp01(p.sourceKeyY + p.offsetY);
                w = p.valueWidth;
                h = p.valueHeight;
              } else {
                x = clamp01(match.x + p.offsetX);
                y = clamp01(match.y + p.offsetY);
                w = Math.min(p.valueWidth,  0.999 - x);
                h = Math.min(p.valueHeight, 0.999 - y);
              }
            }

            if (w <= 0 || h <= 0) continue;
            const hl: Highlight = {
              id: `auto-${Date.now()}-${target.id.slice(-4)}-${pg}-${p.field}-${Math.random().toString(36).slice(2, 5)}`,
              page:  pg,
              field: p.field,
              x, y, width: w, height: h,
              isAutoExtracted: true,
            };
            merged[pg] = [...(merged[pg] ?? []), hl];
            addedHere++;
          } catch (err) {
            console.warn('[autoApplyAllPdfs] place failed:', err);
          }
        }
      }

      if (addedHere > 0) {
        perTarget.push({ id: target.id, merged });
        totalAdded += addedHere;
        pdfsTouched++;
      }
    }

    if (perTarget.length > 0) {
      setSessions(prev => prev.map(s => {
        const u = perTarget.find(t => t.id === s.id);
        return u ? { ...s, highlights: u.merged, status: 'ready' as const } : s;
      }));
    }

    if (totalAdded === 0) {
      toast('No key matches found in other PDFs.', { icon: 'ℹ️' });
    } else {
      toast.success(`Placed ${totalAdded} highlight${totalAdded !== 1 ? 's' : ''} across ${pdfsTouched} PDF${pdfsTouched !== 1 ? 's' : ''}.`);
    }
  }, [activeTabId, sessions]);

  // Excel panel row click → switch to that PDF's tab (if needed) and scroll its
  // viewer to the row's page. Uses a nonce so clicking the same row repeatedly
  // still re-fires the scroll.

  // Remove all highlights with the given field from every OTHER open PDF.
  const handleRemoveFieldFromAllPdfs = useCallback((field: string) => {
    setSessions(prev => prev.map(s => {
      if (s.id === activeTabId) return s;
      const next: Record<number, Highlight[]> = {};
      for (const [pgStr, hls] of Object.entries(s.highlights)) {
        const kept = hls.filter(h => h.field !== field);
        if (kept.length) next[Number(pgStr)] = kept;
      }
      return { ...s, highlights: next };
    }));
  }, [activeTabId]);

  // Same but restricted to the ctrl/cmd-selected tabs.
  const handleRemoveFieldFromSelectedPdfs = useCallback((field: string) => {
    setSessions(prev => prev.map(s => {
      if (!multiSelectedTabIds.has(s.id)) return s;
      const next: Record<number, Highlight[]> = {};
      for (const [pgStr, hls] of Object.entries(s.highlights)) {
        const kept = hls.filter(h => h.field !== field);
        if (kept.length) next[Number(pgStr)] = kept;
      }
      return { ...s, highlights: next };
    }));
  }, [multiSelectedTabIds]);

  // Copy an ad-hoc "table-select" region drawn on the active PDF to every
  // other open PDF (or just the ctrl/cmd-selected ones) and pull a table
  // from the same page + normalized coords on each. Results — plus the
  // (possibly sanitized) source rows — are combined into one Excel workbook
  // with a sheet per PDF, then downloaded.
  //
  // No text anchoring: coords are applied verbatim. This matches
  // handleApplyToAllPdfs and works well for batches of same-layout
  // documents (e.g. monthly utility bills from the same provider). PDFs
  // where the layout has shifted end up with an empty sheet the user can
  // ignore or re-select from that tab.
  const handleExtractTableFromPdfs = useCallback(async (
    region: { page: number; x: number; y: number; width: number; height: number },
    sourceRows: string[][],
    restrictIds?: Set<string>,
  ): Promise<void> => {
    const sourceSession = sessions.find(s => s.id === activeTabId);
    if (!sourceSession) { toast.error('No active PDF'); return; }

    // Include every session that isn't still uploading. We intentionally do
    // NOT require status === 'ready'|'extracted' or a local File blob:
    //   - 'processing' sessions still exist on the backend and the table
    //     endpoint works on them.
    //   - Cache-hydrated sessions have no File blob but their session id may
    //     still be alive on the backend; if the backend evicted them we'll
    //     fail cleanly per-file and surface the count in the final toast.
    // The old strict filter was silently dropping most of a large batch
    // (e.g. 294 uploaded → 28 targeted) whenever many sessions were still
    // finishing processing at click time.
    const targets = sessions.filter(s =>
      s.id !== activeTabId
      && s.status !== 'uploading'
      && (restrictIds ? restrictIds.has(s.id) : true),
    );
    if (targets.length === 0) {
      toast(restrictIds ? 'No selected PDFs to copy to' : 'No other open PDFs to copy to', { icon: 'ℹ️' });
      return;
    }

    const toastId = toast.loading(`Extracting table from ${targets.length} PDF${targets.length !== 1 ? 's' : ''}…`);

    type PerFile = { filename: string; rows: string[][]; failed: boolean };
    // Track renewed session IDs so a stale one gets swapped after batch.
    const renewals: Array<{ oldId: string; newId: string }> = [];

    const runOne = async (sess: PDFSession): Promise<PerFile> => {
      try {
        const result = await extractTableRegion(
          sess.id, region.page, region.x, region.y, region.width, region.height,
          false,
          {
            file: sess.file,
            onSessionRenewed: (oldId, newId) => { renewals.push({ oldId, newId }); },
          },
        );
        return { filename: sess.filename, rows: result.rows ?? [], failed: false };
      } catch {
        return { filename: sess.filename, rows: [], failed: true };
      }
    };

    // Modest concurrency so a batch of 300 doesn't hammer the backend with
    // 300 simultaneous table extractions. 3 matches the upload concurrency.
    const CONCURRENCY = 3;
    const queue = [...targets];
    const perFile: PerFile[] = [];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        const s = queue.shift();
        if (!s) return;
        perFile.push(await runOne(s));
      }
    });
    await Promise.all(workers);

    if (renewals.length > 0) {
      setSessions(prev => prev.map(s => {
        const swap = renewals.find(r => r.oldId === s.id);
        return swap ? { ...s, id: swap.newId } : s;
      }));
      setOpenTabs(prev => prev.map(t => renewals.find(r => r.oldId === t)?.newId ?? t));
      setActiveTabId(prev => (prev && renewals.find(r => r.oldId === prev)?.newId) ?? prev);
    }

    // Build one workbook: source sheet first, then a sheet per target.
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();

    // Excel sheet names cap at 31 chars and forbid : \ / ? * [ ]
    const usedNames = new Set<string>();
    const safeName = (raw: string): string => {
      const stem = raw.replace(/\.[^.]+$/, '').replace(/[:\\/?*[\]]/g, '_').slice(0, 27) || 'Sheet';
      let name = stem;
      let i = 2;
      while (usedNames.has(name.toLowerCase())) { name = `${stem.slice(0, 27 - String(i).length - 1)}_${i}`; i++; }
      usedNames.add(name.toLowerCase());
      return name;
    };

    const writeSheet = (name: string, rows: string[][]) => {
      const ws = wb.addWorksheet(safeName(name));
      if (rows.length === 0) { ws.addRow(['(no data)']); return; }
      for (const r of rows) ws.addRow(r);
      // Auto-size columns loosely — cap at 60 chars so long text doesn't
      // blow the sheet width.
      const ncols = Math.max(...rows.map(r => r.length));
      for (let ci = 1; ci <= ncols; ci++) {
        let max = 8;
        for (const r of rows) {
          const v = r[ci - 1];
          if (v) max = Math.max(max, String(v).length);
        }
        ws.getColumn(ci).width = Math.min(max + 2, 60);
      }
    };

    writeSheet(sourceSession.filename, sourceRows);
    for (const pf of perFile) writeSheet(pf.filename, pf.rows);

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `table_p${region.page}_across_${targets.length + 1}_pdfs.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    const failedCount = perFile.filter(p => p.failed).length;
    toast.dismiss(toastId);
    if (failedCount === 0) {
      toast.success(`Extracted table from ${targets.length + 1} PDFs`);
    } else {
      toast.warning(
        `${targets.length + 1 - failedCount}/${targets.length + 1} succeeded — ${failedCount} failed (layout drift?)`,
      );
    }
  }, [sessions, activeTabId]);

  // Rotate a set of sessions sequentially. Shared by the "Rotate all open"
  // and "Rotate selected" toolbar buttons in both CW and CCW directions.
  // Sequential (not parallel) — the backend page-render is expensive and
  // parallel requests would queue anyway on the Hostinger box.
  const rotateManyPdfs = useCallback(async (
    targets: PDFSession[],
    direction: 90 | -90,
    verb: string,     // shown in the toast, e.g. 'CW' / 'CCW'
    scope: string,    // shown in the toast, e.g. 'all open' / 'selected'
  ): Promise<void> => {
    if (targets.length === 0) {
      toast(`No ${scope} PDFs to rotate`, { icon: 'ℹ️' });
      return;
    }
    const toastId = toast.loading(`Rotating 1 / ${targets.length} (${verb})…`);
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < targets.length; i++) {
      const sess = targets[i];
      toast.loading(`Rotating ${i + 1} / ${targets.length} ${verb} — ${sess.filename}`, { id: toastId });
      const result = await rotateSessionPdf(sess.id, direction);
      if (!result) { failed++; continue; }

      const newFile = await fetchConvertedPdf(sess.id, sess.filename);
      setSessions(prev => prev.map(s => s.id === sess.id
        ? {
            ...s,
            file: newFile ?? s.file,
            total_pages: result.page_count ?? s.total_pages,
            highlights: {},
            extractedData: [],
            status: 'ready' as const,
            forceOcr: false,
            ocrProgress: null,
          }
        : s
      ));
      succeeded++;
    }

    toast.dismiss(toastId);
    if (failed === 0) {
      toast.success(`Rotated ${succeeded} PDF${succeeded !== 1 ? 's' : ''} ${verb}`);
    } else if (succeeded === 0) {
      toast.error(`All ${failed} rotation${failed !== 1 ? 's' : ''} failed`);
    } else {
      toast(`Rotated ${succeeded} / ${targets.length} ${verb} — ${failed} failed`, { icon: '⚠️' });
    }
  }, []);

  // Adds a user-typed custom field label to the session-wide list, so every
  // PDF's label picker shows it.
  const handleAddCustomField = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCustomFields(prev => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
  }, []);

  const handleExcelRowClick = useCallback((sessionId: string, page: number) => {
    if (sessionId !== activeTabId) {
      setOpenTabs(prev => (prev.includes(sessionId) ? prev : [...prev, sessionId]));
      setActiveTabId(sessionId);
    }
    setPageJump({ sessionId, page, nonce: Date.now() });
  }, [activeTabId]);

  // Can we show a viewer?
  // Show the viewer as soon as we have the local File blob — even while the
  // backend is still analysing (status 'processing'). PDFViewer renders from
  // URL.createObjectURL(session.file), so it doesn't need the backend to be
  // done. This kills the "Select a PDF from the sidebar" empty state that
  // used to hang around until the first upload finished.
  const hasActiveViewer = !!activeSession &&
    activeSession.status !== 'uploading' &&
    (activeSession.status !== 'processing' || !!activeSession.file);

  // Guarantee: whenever there are open tabs, exactly one is active. Handles
  // three separate broken-state cases that all showed up in practice:
  //   1. `activeTabId` is null (fresh cache, or user hit Clear).
  //   2. `activeTabId` points at a tab that's no longer in `openTabs`
  //      (closed tab, or a stale renewal that didn't propagate).
  //   3. `activeTabId` exists but its session was removed from `sessions`
  //      (upload failed after the tab was created).
  // In all three cases we fall back to the first open tab so the viewer
  // is never showing the "Select a PDF from the sidebar" empty state while
  // tabs are visible above it.
  useEffect(() => {
    if (openTabs.length === 0) return;
    const stillOpen = activeTabId && openTabs.includes(activeTabId);
    const sessionExists = activeTabId && sessions.some(s => s.id === activeTabId);
    if (!stillOpen || !sessionExists) {
      setActiveTabId(openTabs[0]);
    }
  }, [activeTabId, openTabs, sessions]);

  return (
    <div className="h-screen flex bg-background">

      {/* ── Left sidebar: logo + upload + PDF list ─────────────────────── */}
      <aside className={`${navCollapsed ? 'w-14' : 'w-64'} shrink-0 bg-card border-r border-border
                         flex flex-col transition-all duration-200 z-30 overflow-hidden`}>

        {/* Logo row */}
        <div className={`flex items-center gap-2.5 h-14 border-b border-border shrink-0 ${navCollapsed ? 'justify-center px-2' : 'px-4'}`}>
          <img src="/favicon.ico" alt="Pexl" className={`${navCollapsed ? 'w-5 h-5' : 'w-7 h-7'} rounded-lg shrink-0 transition-all duration-200`} />
          {!navCollapsed && <span className="font-bold text-foreground text-sm tracking-tight">Pexl</span>}
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-auto custom-scrollbar">
          {navCollapsed ? (
            /* Collapsed — just icons */
            <div className="flex flex-col items-center gap-2 py-4">
              <button
                className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center text-primary"
                title="Upload PDFs"
                onClick={() => setNavCollapsed(false)}
              >
                <Upload className="w-4 h-4" />
              </button>
              {sessions.length > 0 && (
                <button
                  className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center text-muted-foreground"
                  title="Your PDFs"
                  onClick={() => setNavCollapsed(false)}
                >
                  <FileSearch className="w-4 h-4" />
                </button>
              )}
            </div>
          ) : (
            <div className="p-4 space-y-5">

              {/* Upload section — visible only when no files are queued
                  yet, or when the user explicitly re-opens it via the
                  "+ Add PDFs" chip in the Your-PDFs header. Keeps the
                  sidebar focused once PDFs are loaded. */}
              {showUploadZone && (
                <div>
                  <div className="flex items-center gap-2 mb-2.5">
                    <Upload className="w-3.5 h-3.5 text-primary" />
                    <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Upload PDFs</h2>
                    {hasUploaded && (
                      <button
                        className="ml-auto text-[10px] text-muted-foreground hover:text-foreground"
                        onClick={() => setShowUploadZone(false)}
                        title="Hide the upload area"
                      >
                        hide
                      </button>
                    )}
                  </div>
                  <UploadZone
                    compact={hasUploaded}
                    onFilesSelected={handleFilesSelected}
                  />
                </div>
              )}

              {/* Staging bar — appears once files are staged. Lets the user
                  keep adding files from other folders/paths, then click
                  Proceed to pick the doc type ONCE and process everything. */}
              {pendingFiles.length > 0 && !processing && (
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 space-y-2">
                  <p className="text-[11px] text-foreground">
                    <span className="font-semibold">
                      {pendingFiles.length} file{pendingFiles.length !== 1 ? 's' : ''} staged
                    </span>
                    {' '}— add more from other folders, then proceed.
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleProceed}
                      className="flex-1 h-8 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-colors"
                    >
                      Proceed
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingFiles([])}
                      className="px-3 h-8 rounded-md text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                      title="Clear the staged files"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              )}

              {/* Instructions — shown before first upload */}
              {!hasUploaded && (
                <div className="bg-primary/5 border border-primary/20 rounded-xl p-3">
                  <p className="text-[11px] font-semibold text-primary mb-1.5">How it works</p>
                  <ol className="text-[11px] text-primary/80 space-y-1 list-decimal list-inside leading-relaxed">
                    <li>Choose document type</li>
                    <li>Upload PDF files</li>
                    <li>Draw boxes over the values</li>
                    <li>Label each box with field type</li>
                    <li>Click <strong>Extract</strong></li>
                    <li>Export to <strong>.xlsx</strong></li>
                  </ol>
                </div>
              )}

              {/* PDF list */}
              {sessions.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-2.5">
                    <FileSearch className="w-3.5 h-3.5 text-muted-foreground" />
                    <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Your PDFs</h2>
                    <span className="text-[10px] text-muted-foreground/60">{sessions.length} file{sessions.length !== 1 ? 's' : ''}</span>
                    {!showUploadZone && (
                      <button
                        className="ml-auto flex items-center gap-1 text-[10px] font-medium text-primary hover:underline"
                        onClick={() => setShowUploadZone(true)}
                        title="Show the upload area again"
                      >
                        <Upload className="w-3 h-3" /> Add PDFs
                      </button>
                    )}
                  </div>

                  {/* Bulk start-page control — skip cover pages for ALL PDFs at once */}
                  {sessions.length > 1 && (
                    <div className="bg-muted/60 border border-border rounded-lg px-3 py-2 mb-2 flex items-center gap-2">
                      <span className="text-[11px] text-muted-foreground whitespace-nowrap">All PDFs start at page</span>
                      <input
                        type="number"
                        min={1}
                        defaultValue={sessions[0]?.startPage ?? 1}
                        className="w-12 h-6 text-center text-xs bg-background rounded border border-border
                                   text-foreground outline-none focus:ring-1 focus:ring-primary"
                        onChange={e => {
                          const n = parseInt(e.target.value);
                          if (!isNaN(n) && n >= 1) handleBulkStartPageChange(n);
                        }}
                      />
                      <span className="text-[10px] text-muted-foreground/70">skip covers</span>
                    </div>
                  )}

                  <PDFCardList
                    sessions={sessions}
                    expandedId={activeTabId}
                    onToggle={openTab}
                    onStartPageChange={handleStartPageChange}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Collapse toggle */}
        <div className="p-2 border-t border-border shrink-0">
          <button
            className="w-full flex items-center justify-center p-2 rounded-lg
                       text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            onClick={() => setNavCollapsed(v => !v)}
            title={navCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {navCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>
      </aside>

      {/* ── Main area ────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Top bar */}
        <header className="h-14 bg-card border-b border-border flex items-center px-6 gap-4 shrink-0">
          <div>
            <h1 className="text-base font-bold text-foreground">Pexl</h1>
            <p className="text-[11px] text-muted-foreground">Upload PDFs · highlight values · export to Excel</p>
          </div>
          {backendDown && (
            <div className="ml-auto flex items-center gap-2 bg-destructive/10 border border-destructive/20
                            text-destructive text-xs px-3 py-1.5 rounded-lg">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              Backend offline — OCR unavailable
              <button className="underline ml-1" onClick={() => setBackendDown(false)}>Dismiss</button>
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={async () => {
                const ready = sessions.filter(s => s.status === 'ready' || s.status === 'extracted');
                if (ready.length === 0) { toast('No PDFs ready to download yet', { icon: 'ℹ️' }); return; }
                setZippingOcr(true);
                try {
                  const { added, missing, renewed } = await downloadAllOcrPdfsAsZip(
                    // Pass each session's local File so the backend can be
                    // transparently re-uploaded if the session has expired.
                    ready.map(s => ({ id: s.id, filename: s.filename, file: s.file }))
                  );
                  // Adopt any new session IDs the backend handed back so
                  // subsequent actions (Extract, etc.) don't also 404.
                  if (renewed.length > 0) {
                    setSessions(prev => prev.map(s => {
                      const swap = renewed.find(r => r.oldId === s.id);
                      return swap ? { ...s, id: swap.newId } : s;
                    }));
                    setOpenTabs(prev => prev.map(t => renewed.find(r => r.oldId === t)?.newId ?? t));
                    setActiveTabId(prev => (prev && renewed.find(r => r.oldId === prev)?.newId) ?? prev);
                  }
                  toast.success(`Downloaded ${added} OCR'd PDF${added !== 1 ? 's' : ''} as zip`);
                  if (missing.length > 0) toast.warning(`${missing.length} PDF${missing.length !== 1 ? 's' : ''} missing from backend`);
                } catch (err: any) {
                  toast.error(err?.message || 'Zip download failed');
                }
                setZippingOcr(false);
              }}
              disabled={zippingOcr || sessions.length === 0}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground
                         transition-all duration-200 px-2 py-1.5 rounded-lg hover:bg-muted
                         disabled:opacity-40 disabled:cursor-not-allowed"
              title="Download all OCR'd PDFs as a zip"
            >
              {zippingOcr
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <DownloadCloud className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">Download OCR</span>
            </button>
            <button
              onClick={() => {
                if (sessions.length === 0) return;
                if (!confirm('Reset workspace? Highlights and extracted data will be cleared, but uploaded PDFs will stay.')) return;
                setSessions(prev => prev.map(s => ({
                  ...s,
                  highlights: {},
                  extractedData: [],
                  status: s.status === 'extracted' ? 'ready' : s.status,
                })));
                setShowExcel(false);
              }}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-all duration-200 px-2 py-1.5 rounded-lg hover:bg-muted"
              title="Refresh workspace (keeps uploaded PDFs, clears highlights & data)"
            >
              <RotateCw className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Refresh</span>
            </button>
            <button
              onClick={() => {
                const totalHls = sessions.reduce((s, sess) => s + Object.values(sess.highlights).flat().length, 0);
                if (totalHls === 0) return;
                if (!confirm(`Remove all ${totalHls} highlights from all PDFs?`)) return;
                setSessions(prev => prev.map(s => ({
                  ...s,
                  highlights: {},
                  extractedData: [],
                  status: s.status === 'extracted' ? 'ready' : s.status,
                })));
                setShowExcel(false);
              }}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-destructive transition-all duration-200 px-2 py-1.5 rounded-lg hover:bg-destructive/10"
              title="Remove all highlights from all PDFs"
            >
              <Eraser className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Clear</span>
            </button>
            <button
              onClick={() => setShowBatchPanel(true)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-all duration-200 px-2 py-1.5 rounded-lg hover:bg-muted"
              title="Batches — download, rename, delete & inspect saved batches"
            >
              <Layers className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Batches</span>
            </button>
            <button
              onClick={() => navigate('/usage')}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-all duration-200 px-2 py-1.5 rounded-lg hover:bg-muted"
              title="Usage Dashboard"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Usage</span>
            </button>
            <ThemeToggle />
            <button
              onClick={() => { logout(); navigate('/login'); }}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-all duration-200 px-2 py-1.5 rounded-lg hover:bg-muted"
              title="Sign out"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </header>

        {/* Content */}
        <div className="flex-1 flex flex-col overflow-hidden">

          {/* ── Tab bar ──────────────────────────────────────────────── */}
          {tabSessions.length > 0 && (
            <div className="bg-muted flex items-end shrink-0 px-1 pt-1">
            <div className="flex items-end overflow-x-auto flex-1 min-w-0 gap-px">
              {tabSessions.map(s => {
                const isActive = s.id === activeTabId;
                const dt = DOCUMENT_TYPES.find(d => d.value === s.docType);
                return (
                  <div
                    // stableKey is the tempId assigned at upload and never
                    // changes. `s.id` changes when a session's tempId gets
                    // swapped for the backend's real session_id at the end
                    // of processing — using it as the key here caused a
                    // mass unmount + remount of the whole tab strip at the
                    // moment all uploads finished (visible as a one-time
                    // flicker on 300-file batches).
                    key={s.stableKey ?? s.id}
                    draggable
                    onDragStart={e => {
                      setDragTabId(s.id);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragOver={e => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                    }}
                    onDrop={e => {
                      e.preventDefault();
                      if (dragTabId && dragTabId !== s.id) {
                        setOpenTabs(prev => {
                          const next = prev.filter(t => t !== dragTabId);
                          const dropIdx = next.indexOf(s.id);
                          next.splice(dropIdx, 0, dragTabId);
                          return next;
                        });
                      }
                      setDragTabId(null);
                    }}
                    onDragEnd={() => setDragTabId(null)}
                    // Active tab uses `bg-background` (the content pane color)
                    // so it visually "cuts through" the muted tab-bar strip
                    // above the viewer — the same VS Code / browser-tab
                    // pattern. The primary-colored top border reinforces
                    // which tab is active in both dark and light modes,
                    // where `bg-card` vs `bg-muted` alone was too subtle.
                    className={`group flex items-center gap-1.5 pl-3 pr-1 py-1.5 rounded-t-lg text-xs cursor-grab
                      max-w-[200px] min-w-[100px] select-none transition-colors border-t-2
                      ${dragTabId === s.id ? 'opacity-40' : ''}
                      ${multiSelectedTabIds.has(s.id) ? 'ring-2 ring-primary ring-offset-1 ring-offset-muted' : ''}
                      ${isActive
                        ? 'bg-background border-t-primary text-foreground font-semibold shadow-sm'
                        : 'bg-muted/40 border-t-transparent text-muted-foreground/70 hover:bg-muted/70 hover:text-foreground'
                      }`}
                    onClick={e => {
                      // Shift+click → add every tab between the current
                      // anchor and this one to the multi-select set.
                      // Works like Explorer / VSCode file list behavior.
                      if (e.shiftKey && tabAnchorId && tabAnchorId !== s.id) {
                        e.stopPropagation();
                        const aIdx = openTabs.indexOf(tabAnchorId);
                        const bIdx = openTabs.indexOf(s.id);
                        if (aIdx !== -1 && bIdx !== -1) {
                          const lo = Math.min(aIdx, bIdx);
                          const hi = Math.max(aIdx, bIdx);
                          setMultiSelectedTabIds(prev => {
                            const next = new Set(prev);
                            for (let i = lo; i <= hi; i++) next.add(openTabs[i]);
                            return next;
                          });
                        }
                        return;
                      }
                      // Ctrl / Cmd click → toggle this tab in the multi-select
                      // set WITHOUT switching active. Updates the anchor so
                      // the next Shift+click extends from here.
                      if (e.ctrlKey || e.metaKey) {
                        e.stopPropagation();
                        setMultiSelectedTabIds(prev => {
                          const next = new Set(prev);
                          if (next.has(s.id)) next.delete(s.id);
                          else next.add(s.id);
                          return next;
                        });
                        setTabAnchorId(s.id);
                        return;
                      }
                      // Plain click → switch active tab and reset the anchor
                      // so future Shift+clicks range from here.
                      setActiveTabId(s.id);
                      setTabAnchorId(s.id);
                    }}
                    title={`${s.filename}\nCtrl/Cmd+click: toggle selection\nShift+click: select range`}
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ backgroundColor: dt?.color ?? '#64748b' }}
                    />
                    {/* RTL direction makes the ellipsis appear at the START of
                        the string instead of the end — so a bunch of files
                        sharing a "39.0-3-..." prefix show their distinguishing
                        suffix. The leading LRM (‎) forces the actual
                        letters to render left-to-right so numbers and dashes
                        aren't visually reversed. Full name is on the tooltip. */}
                    <span dir="rtl" className="truncate flex-1 text-left">
                      {'‎' + s.filename}
                    </span>
                    <button
                      className={`p-0.5 rounded transition-colors shrink-0
                        ${isActive
                          ? 'hover:bg-muted text-muted-foreground hover:text-foreground'
                          : 'opacity-0 group-hover:opacity-100 hover:bg-muted text-muted-foreground hover:text-foreground'
                        }`}
                      onClick={e => { e.stopPropagation(); closeTab(s.id); }}
                      title="Close tab"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
              {multiSelectedTabIds.size > 0 && (
                <button
                  onClick={() => { setMultiSelectedTabIds(new Set()); setTabAnchorId(null); }}
                  className="ml-2 mb-0.5 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs
                             bg-primary/10 text-primary hover:bg-primary/20 transition-colors shrink-0"
                  title="Clear PDF selection"
                >
                  <XCircle className="w-3.5 h-3.5" />
                  <span>Clear selection ({multiSelectedTabIds.size})</span>
                </button>
              )}
            </div>

              {/* Global doc-type picker — single setting for the whole batch.
                  Changing it updates every open session's docType at once,
                  so the Excel export's templated sheet matches what the
                  user picked. Already-extracted values stay in Plain Data
                  regardless. */}
              {(() => {
                const currentType = activeSession?.docType ?? pendingDocType;
                const currentDef = DOCUMENT_TYPES.find(d => d.value === currentType);
                return (
                  <div className="relative ml-auto mb-0.5 shrink-0">
                    <button
                      type="button"
                      onClick={e => {
                        e.stopPropagation();
                        setGlobalDocTypeOpen(o => !o);
                      }}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs
                                 bg-muted/60 hover:bg-muted text-foreground transition-colors"
                      title="Change document type for every uploaded PDF"
                    >
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: currentDef?.color ?? '#64748b' }}
                      />
                      <span className="font-medium">{currentDef?.label ?? 'Doc type'}</span>
                      <ChevronRight className="w-3 h-3 rotate-90 text-muted-foreground" />
                    </button>
                    {globalDocTypeOpen && (
                      <div
                        className="absolute top-full right-0 mt-1 z-50 bg-card border border-border rounded-lg shadow-xl py-1 min-w-[200px]"
                        onClick={e => e.stopPropagation()}
                      >
                        <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground font-semibold border-b border-border mb-0.5">
                          Document Type — applies to all PDFs
                        </div>
                        {DOCUMENT_TYPES.map(t => (
                          <button
                            key={t.value}
                            type="button"
                            className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors
                              ${t.value === currentType
                                ? 'bg-primary/10 text-foreground font-medium'
                                : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                            onClick={() => {
                              if (t.value !== currentType) {
                                setSessions(prev => prev.map(s => ({ ...s, docType: t.value })));
                                setPendingDocType(t.value); // future uploads default to this too
                                toast.success(`Doc type changed to "${t.label}" for all PDFs`, {
                                  description: 'Already-extracted values stay in the Plain Data sheet. Re-extract to refresh the templated sheet.',
                                  duration: 5000,
                                });
                              }
                              setGlobalDocTypeOpen(false);
                            }}
                          >
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: t.color }} />
                            <span className="flex-1">{t.label}</span>
                            {t.value === currentType && <Check className="w-3 h-3 text-primary shrink-0" />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          {/* ── Viewer + Excel panel ─────────────────────────────────── */}
          {hasActiveViewer ? (
            <div className="flex-1 flex overflow-hidden">
              <div className="flex-1 flex flex-col overflow-hidden min-w-0">
                {/* OCR progress banner — shown while background index build is running */}
                {activeSession?.ocrProgress && !activeSession.ocrProgress.done && activeSession.ocrProgress.total_pages > 0 && activeSession.ocrProgress.current_page > 0 && (
                  <div className="bg-primary/5 border-b border-primary/20 px-4 py-1.5 flex items-center gap-3 shrink-0">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-primary shrink-0" />
                    <span className="text-xs text-primary/80 whitespace-nowrap">
                      {activeSession.forceOcr ? 'Force Re-OCR' : 'OCR indexing'} — page {activeSession.ocrProgress.current_page}/{activeSession.ocrProgress.total_pages}
                      {activeSession.ocrProgress.elapsed_sec > 0 && ` · ${activeSession.ocrProgress.elapsed_sec.toFixed(0)}s`}
                    </span>
                    <div className="flex-1 h-1.5 bg-primary/10 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full transition-all duration-500"
                        style={{
                          width: `${Math.round((activeSession.ocrProgress.current_page / activeSession.ocrProgress.total_pages) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                )}
                <PDFViewer
                  key={activeSession.stableKey ?? activeSession.id}
                  session={activeSession}
                  onHighlightsChange={handleHighlightsChange}
                  onExtract={handleExtract}
                  onReExtract={handleReExtractHighlight}
                  onApplyToAllPdfs={handleApplyToAllPdfs}
                  onApplyToSelectedPdfs={multiSelectedTabIds.size > 0
                    ? (src) => handleApplyToAllPdfs(src, multiSelectedTabIds)
                    : undefined}
                  selectedPdfCount={multiSelectedTabIds.size}
                  onStartPageChange={handleStartPageChange}
                  extracting={extracting}
                  scrollToPageTrigger={pageJump && pageJump.sessionId === activeSession.id ? pageJump : null}
                  customFields={customFields}
                  onCustomFieldAdd={handleAddCustomField}
                  onSelectionChange={ids => { selectedHighlightIdsRef.current = ids; }}
                  onSessionRenewed={(oldId, newId) => {
                    // Backend forgot this session and we silently re-uploaded.
                    // Swap the id everywhere it's referenced so subsequent
                    // actions (Extract, etc.) don't also hit 404.
                    setSessions(prev => prev.map(s => s.id === oldId ? { ...s, id: newId } : s));
                    setOpenTabs(prev => prev.map(t => t === oldId ? newId : t));
                    setActiveTabId(prev => prev === oldId ? newId : prev);
                  }}
                  onPdfReplaced={(newFile) => {
                    // OCR download finished — swap the active session's File
                    // so the viewer re-renders with the searchable copy and
                    // text-select operates on the new OCR text layer.
                    setSessions(prev => prev.map(s =>
                      s.id === activeSession.id ? { ...s, file: newFile } : s,
                    ));
                  }}
                  onAutoApplyAllPdfs={handleAutoApplyAllPdfs}
                  onExtractTableFromAllPdfs={(region, sourceRows) =>
                    handleExtractTableFromPdfs(region, sourceRows)}
                  onExtractTableFromSelectedPdfs={multiSelectedTabIds.size > 0
                    ? (region, sourceRows) => handleExtractTableFromPdfs(region, sourceRows, multiSelectedTabIds)
                    : undefined}
                  onRemoveFieldFromAllPdfs={handleRemoveFieldFromAllPdfs}
                  onRemoveFieldFromSelectedPdfs={multiSelectedTabIds.size > 0
                    ? handleRemoveFieldFromSelectedPdfs
                    : undefined}
                  rotatingAllPdfsCcw={rotatingAllPdfsCcw}
                  onRotateAllPdfsCcw={async () => {
                    if (rotatingAllPdfsCcw) return;
                    setRotatingAllPdfsCcw(true);
                    const openTabSet = new Set(openTabs);
                    await rotateManyPdfs(
                      sessions.filter(s => openTabSet.has(s.id)),
                      -90, 'CCW', 'open',
                    );
                    setRotatingAllPdfsCcw(false);
                  }}
                  rotatingSelectedPdfs={rotatingSelectedPdfs}
                  onRotateSelectedPdfs={multiSelectedTabIds.size > 0
                    ? async () => {
                        if (rotatingSelectedPdfs) return;
                        setRotatingSelectedPdfs(true);
                        await rotateManyPdfs(
                          sessions.filter(s => multiSelectedTabIds.has(s.id)),
                          90, 'CW', 'selected',
                        );
                        setRotatingSelectedPdfs(false);
                      }
                    : undefined}
                  rotatingSelectedPdfsCcw={rotatingSelectedPdfsCcw}
                  onRotateSelectedPdfsCcw={multiSelectedTabIds.size > 0
                    ? async () => {
                        if (rotatingSelectedPdfsCcw) return;
                        setRotatingSelectedPdfsCcw(true);
                        await rotateManyPdfs(
                          sessions.filter(s => multiSelectedTabIds.has(s.id)),
                          -90, 'CCW', 'selected',
                        );
                        setRotatingSelectedPdfsCcw(false);
                      }
                    : undefined}
                  rotatingAllCcw={rotatingIdCcw === activeSession.id}
                  onRotateAllCcw={async () => {
                    if (rotatingIdCcw === activeSession.id) return;
                    setRotatingIdCcw(activeSession.id);
                    const result = await rotateSessionPdf(activeSession.id, -90);
                    if (!result) {
                      setRotatingIdCcw(null);
                      toast.error('Rotate failed — session may have expired, try re-uploading');
                      return;
                    }
                    const newFile = await fetchConvertedPdf(activeSession.id, activeSession.filename);
                    setRotatingIdCcw(null);
                    setSessions(prev => prev.map(s => s.id === activeSession.id
                      ? {
                          ...s,
                          file: newFile ?? s.file,
                          total_pages: result.page_count ?? s.total_pages,
                          highlights: {},
                          extractedData: [],
                          status: 'ready' as const,
                          forceOcr: false,
                          ocrProgress: null,
                        }
                      : s
                    ));
                  }}
                  rotatingAllPdfs={rotatingAllPdfs}
                  onRotateAllPdfs={async () => {
                    if (rotatingAllPdfs) return;
                    setRotatingAllPdfs(true);
                    const openTabSet = new Set(openTabs);
                    await rotateManyPdfs(
                      sessions.filter(s => openTabSet.has(s.id)),
                      90, 'CW', 'open',
                    );
                    setRotatingAllPdfs(false);
                  }}
                  rotatingAll={rotatingId === activeSession.id}
                  onRotateAll={async () => {
                    if (rotatingId === activeSession.id) return;
                    setRotatingId(activeSession.id);
                    const result = await rotateSessionPdf(activeSession.id, 90);
                    if (!result) {
                      setRotatingId(null);
                      toast.error('Rotate failed — session may have expired, try re-uploading');
                      return;
                    }

                    // Refetch the now-rotated PDF blob so pdf.js renders the new pages.
                    const newFile = await fetchConvertedPdf(activeSession.id, activeSession.filename);
                    setRotatingId(null);

                    setSessions(prev => prev.map(s => s.id === activeSession.id
                      ? {
                          ...s,
                          file: newFile ?? s.file,
                          total_pages: result.page_count ?? s.total_pages,
                          highlights: {},
                          extractedData: [],
                          status: 'ready',
                          // After baking, every page is a scanned image; force-ocr
                          // is cleared because the user can re-trigger if needed.
                          forceOcr: false,
                          ocrProgress: null,
                        }
                      : s
                    ));
                  }}
                  forcingOcr={forcingOcrId === activeSession.id}
                  onForceOcr={async () => {
                    if (forcingOcrId === activeSession.id) return;
                    setForcingOcrId(activeSession.id);
                    // Optimistically mark the session as force-ocr — the
                    // toolbar badge flips to the amber "Force OCR active"
                    // state immediately. We DON'T seed a fake ocrProgress
                    // here because the backend endpoint just flips a flag
                    // and clears caches; the actual OCR runs later when
                    // the user clicks Download OCR. Seeding a 0/N progress
                    // bar made it look like something was hanging forever.
                    let liveId = activeSession.id;
                    setSessions(prev => prev.map(s => s.id === activeSession.id
                      ? { ...s, forceOcr: true, ocrProgress: null }
                      : s
                    ));
                    const result = await triggerForceOcr(activeSession.id, {
                      file: activeSession.file,
                      onSessionRenewed: (oldId, newId) => {
                        liveId = newId;
                        setSessions(prev => prev.map(s => s.id === oldId ? { ...s, id: newId } : s));
                        setOpenTabs(prev => prev.map(t => t === oldId ? newId : t));
                        setActiveTabId(prev => prev === oldId ? newId : prev);
                      },
                    });
                    setForcingOcrId(null);
                    if (!result) {
                      // Roll back the optimistic flag so the toolbar badge
                      // matches reality (nothing changed on the server).
                      setSessions(prev => prev.map(s => s.id === liveId
                        ? { ...s, forceOcr: false }
                        : s
                      ));
                      toast.error('Force Re-OCR failed — check your connection and try again');
                      return;
                    }
                    toast.success(
                      'Force Re-OCR enabled — click "Download OCR" to build a fresh searchable PDF',
                      { duration: 6000 },
                    );
                  }}
                />
              </div>

              {showExcel && combinedExtractedData.length > 0 && (
                <>
                  {/* Drag handle */}
                  <div
                    className="w-1 bg-border hover:bg-primary cursor-col-resize shrink-0 relative group transition-all duration-200"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      const startX = e.clientX;
                      const startWidth = excelWidth;
                      const onMove = (ev: MouseEvent) => {
                        const delta = startX - ev.clientX;
                        const newW = Math.max(320, Math.min(1200, startWidth + delta));
                        setExcelWidth(newW);
                      };
                      const onUp = () => {
                        window.removeEventListener('mousemove', onMove);
                        window.removeEventListener('mouseup', onUp);
                      };
                      window.addEventListener('mousemove', onMove);
                      window.addEventListener('mouseup', onUp);
                    }}
                  >
                    {/* Wider hit area */}
                    <div className="absolute inset-y-0 -left-1 -right-1" />
                  </div>
                  <div
                    className="border-l border-border shrink-0 overflow-hidden"
                    style={{ width: `${excelWidth}px` }}
                  >
                    <ExcelPanel
                      data={combinedExtractedData}
                      filename={sessions.filter(s => s.extractedData.length > 0).map(s => s.filename).join(', ')}
                      provider={DOCUMENT_TYPES.find(d => d.value === activeSession.docType)?.label ?? 'Document'}
                      forceDocType={activeSession.docType}
                      onClose={() => setShowExcel(false)}
                      onReExtract={handleExtract}
                      onReExtractPage={handleReExtractPage}
                      onDataChange={(d: ExtractedRow[]) => {
                        setSessions(prev => prev.map(s => ({
                          ...s,
                          extractedData: d.filter(r => r.sessionId === s.id),
                        })));
                      }}
                      multiFile={sessions.filter(s => s.extractedData.length > 0).length > 1}
                      onDownload={() => {
                        // For the multi-file Excel download, anchor
                        // uploaded_at to the earliest session in the
                        // batch and finished_at to right now.
                        const uploads = sessions
                          .filter(s => s.extractedData.length > 0)
                          .map(s => s.uploadedAt)
                          .filter((n): n is number => typeof n === 'number');
                        const startedAt = uploads.length > 0 ? Math.min(...uploads) : undefined;
                        trackDownload(startedAt, Date.now()).catch(() => {});
                      }}
                      onRowClick={handleExcelRowClick}
                      externalBatchId={activeBatchId}
                      onDeleteRow={(sessionId, page) => {
                        setSessions(prev => prev.map(s => {
                          if (s.id !== sessionId) return s;
                          const highlights = { ...s.highlights };
                          delete highlights[page];
                          return { ...s, highlights };
                        }));
                      }}
                    />
                  </div>
                </>
              )}
            </div>
          ) : (
            /* Empty state */
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                  <FileSearch className="w-8 h-8 text-primary/50" />
                </div>
                <p className="text-sm font-semibold text-foreground/70">
                  {hasUploaded ? 'Select a PDF from the sidebar to view' : 'Upload a PDF to get started'}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {hasUploaded ? 'Click any file on the left' : 'Use the upload panel on the left'}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ProcessingModal removed — uploads render as per-tab spinners now. */}

      {/* Doc-type confirmation modal — last chance to fix the type for
          a batch before processing starts. The picker mutates
          pendingDocType directly so closing without confirming still
          retains whatever the user just chose. */}
      {confirmProcessOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
          onClick={() => setConfirmProcessOpen(false)}
        >
          <div
            className="bg-background border border-border rounded-xl shadow-2xl w-[420px] max-w-[92vw]"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-border">
              <h3 className="text-base font-semibold">Confirm document type</h3>
              <p className="text-xs text-muted-foreground mt-1">
                You're about to process{' '}
                <span className="font-medium text-foreground">
                  {pendingFiles.length} file{pendingFiles.length !== 1 ? 's' : ''}
                </span>
                . Pick the right type below — it controls which fields are
                recognised and how the Excel export is built.
              </p>
            </div>

            <div className="px-3 py-2 max-h-[60vh] overflow-auto">
              {DOCUMENT_TYPES.map(t => (
                <button
                  key={t.value}
                  type="button"
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-left transition-colors
                    ${t.value === pendingDocType
                      ? 'bg-primary/10 ring-1 ring-primary/30 text-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                  onClick={() => setPendingDocType(t.value)}
                >
                  <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: t.color }} />
                  <span className="flex-1 font-medium">{t.label}</span>
                  {t.value === pendingDocType && <Check className="w-4 h-4 text-primary shrink-0" />}
                </button>
              ))}
            </div>

            <div className="px-5 pt-3 border-t border-border">
              <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={skipDocTypeConfirm}
                  onChange={e => setSkipDocTypeConfirm(e.target.checked)}
                />
                <span>
                  Process future uploads immediately as this type — no dialog,
                  no extra clicks (recommended). Uncheck to be asked every
                  time. The type can be changed any time from the toolbar
                  dropdown.
                </span>
              </label>
            </div>
            <div className="px-5 py-3 flex justify-end gap-2">
              <button
                type="button"
                className="px-4 py-1.5 text-sm rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                onClick={() => setConfirmProcessOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="px-4 py-1.5 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                onClick={() => {
                  docTypeConfirmedOnce.current = true;
                  setConfirmProcessOpen(false);
                  runProcessing();
                }}
              >
                Start processing
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating batch-extract control — pause / resume / stop a long run.
          Shown only while a batch is in flight (batchProgress != null). */}
      {batchProgress && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[70] flex items-center gap-3 rounded-xl border border-border bg-card/95 backdrop-blur px-4 py-2.5 shadow-2xl">
          <Loader2 className={`w-4 h-4 text-primary ${batchPaused ? 'opacity-40' : 'animate-spin'}`} />
          <span className="text-sm font-medium tabular-nums whitespace-nowrap">
            {batchPaused ? 'Paused' : 'Extracting'} {batchProgress.done} / {batchProgress.total}
          </span>
          <div className="w-28 h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${Math.round((batchProgress.done / Math.max(1, batchProgress.total)) * 100)}%` }}
            />
          </div>
          {batchPaused ? (
            <button
              type="button"
              onClick={resumeExtract}
              className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <Play className="w-3.5 h-3.5" /> Resume
            </button>
          ) : (
            <button
              type="button"
              onClick={pauseExtract}
              className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium bg-muted hover:bg-muted/70 transition-colors"
            >
              <Pause className="w-3.5 h-3.5" /> Pause
            </button>
          )}
          <button
            type="button"
            onClick={stopExtract}
            className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-500/10 transition-colors"
          >
            <Square className="w-3.5 h-3.5" /> Stop
          </button>
        </div>
      )}

      {/* Batch Manager — opened from the "Batches" button in the header.
          Manager-only (download / rename / delete / inspect); batch
          creation still happens from the Excel panel's batch selector. */}
      {showBatchPanel && (
        <BatchPanel
          username={user?.username ?? 'unknown'}
          onClose={() => setShowBatchPanel(false)}
        />
      )}
    </div>
  );
}
