/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import {
  Upload, ChevronLeft, ChevronRight,
  AlertTriangle, FileSearch, X, ShieldCheck, LogOut,
  RotateCw, Eraser, DownloadCloud, Loader2, XCircle,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import UploadZone from '@/components/UploadZone';
import PDFCardList from '@/components/PDFCardList';
import ProcessingModal from '@/components/ProcessingModal';
import PDFViewer from '@/components/PDFViewer';
import ExcelPanel from '@/components/ExcelPanel';
import ThemeToggle from '@/components/ThemeToggle';
import type { PDFSession, Highlight, ExtractedRow, DocumentType } from '@/types/utilscraper';
import { DOCUMENT_TYPES } from '@/types/utilscraper';
import { processFile, extractRegions, downloadAllOcrPdfsAsZip, downloadExcel } from '@/lib/api';
import { rasterizeIfVectorOnly } from '@/lib/vector-pdf-rasterizer';
import { sessionsCache } from '@/lib/sessions-cache';
import { useAuth } from '@/contexts/AuthContext';

export default function Index() {
  const { user, trackUsage, trackDownload, logout } = useAuth();
  const navigate = useNavigate();
  // Hydrate from the module-level cache so navigating to /admin and back
  // doesn't drop the open PDFs / extracted data. The cache lives as long
  // as the JS module — does NOT survive a hard refresh.
  const [sessions, setSessions]                 = useState<PDFSession[]>(() => sessionsCache.sessions);
  const [openTabs, setOpenTabs]                 = useState<string[]>(() => sessionsCache.openTabs);
  const [activeTabId, setActiveTabId]           = useState<string | null>(() => sessionsCache.activeTabId);
  const [pendingFiles, setPendingFiles]         = useState<File[]>([]);
  const [processing, setProcessing]             = useState(false);
  const [modalOpen, setModalOpen]               = useState(false);
  const [modalStep, setModalStep]               = useState(0);
  const [modalDetail, setModalDetail]           = useState('');
  const [modalFileIdx, setModalFileIdx]         = useState(0);
  const [modalTotalFiles, setModalTotalFiles]   = useState(0);
  const [extracting, setExtracting]             = useState(false);
  const [showExcel, setShowExcel]               = useState(false);
  const [excelWidth, setExcelWidth]             = useState(480); // px, draggable
  const [backendDown, setBackendDown]           = useState(false);
  const [zippingOcr, setZippingOcr]             = useState(false);
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

  // Hide the upload zone only AFTER files have actually been processed
  // (sessions exist). While `pendingFiles` is populated the Process button
  // lives inside the zone, so we must keep it visible until the user
  // clicks it. The "+ Add PDFs" chip in the Your-PDFs header brings it
  // back when the user wants to queue more.
  useEffect(() => {
    if (sessions.length > 0 && pendingFiles.length === 0) setShowUploadZone(false);
  }, [sessions.length, pendingFiles.length]);

  // Mirror tab/session state into the module-level cache so it survives
  // unmounts (e.g. when navigating to /admin and back).
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
      if (e.key !== 'Tab' || !e.ctrlKey) return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable) return;
      }
      if (openTabs.length === 0) return;
      e.preventDefault();
      const curIdx = activeTabId ? openTabs.indexOf(activeTabId) : -1;
      const delta  = e.shiftKey ? -1 : 1;
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

  const handleFilesSelected = useCallback((files: File[]) => {
    setPendingFiles(prev => [...prev, ...files]);
  }, []);

  const handleProcess = useCallback(async () => {
    if (!pendingFiles.length) return;
    setProcessing(true);
    setModalTotalFiles(pendingFiles.length);
    setModalFileIdx(0);
    const newSessionIds: string[] = [];
    for (let i = 0; i < pendingFiles.length; i++) {
      let file = pendingFiles[i];

      // Vector-only PDFs (no text layer, no embedded images, only path
      // drawings) come back empty from the backend's image-OCR pipeline.
      // Rasterize them client-side to a regular image-PDF before upload
      // so the existing /process endpoint can OCR them as image scans.
      if (/\.pdf$/i.test(file.name)) {
        try {
          const result = await rasterizeIfVectorOnly(file, { dpi: 200 });
          if (result.rasterized) {
            file = result.file;
            toast(`Rasterized vector PDF "${pendingFiles[i].name}" for OCR`, {
              icon: '📄', duration: 3500,
            });
          }
        } catch (err) {
          console.warn('[rasterizeIfVectorOnly] failed:', err);
          // fall through with the original file — backend may still cope
        }
      }

      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      // Browsers don't expose absolute filesystem paths (e.g. "C:\Users\...")
      // for security. The fullest path available is relative to whatever the
      // user selected:
      //   - folder picker → file.webkitRelativePath = "TopFolder/sub/file.pdf"
      //   - folder drag-drop → file.__relativePath = "TopFolder/sub/file.pdf"
      //     (set by UploadZone during the directory walk)
      // We join all segments except the filename with backslashes so it reads
      // like a Windows path, e.g. "Statement 2\4.9.2026".
      const relPath =
        (file as File & { __relativePath?: string }).__relativePath
        || (file as File & { webkitRelativePath?: string }).webkitRelativePath;
      const folderName = relPath && relPath.includes('/')
        ? relPath.split('/').slice(0, -1).join('\\')
        : undefined;
      setSessions(prev => [...prev, {
        id: tempId, filename: file.name, file, folderName,
        docType: pendingDocType,
        total_pages: 0, pages: [], status: 'processing',
        highlights: {}, extractedData: [],
        startPage: 1,
      }]);
      setModalOpen(true); setModalStep(0); setModalDetail('');
      setModalFileIdx(i + 1);
      try {
        const result = await processFile(file, '', (step, detail) => {
          setModalStep(step); setModalDetail(detail || '');
        });
        const ocrCount = result.pages.filter(p => p.is_ocr).length;
        // Update temp session with real ID
        setSessions(prev => prev.map(s => s.id === tempId
          ? {
              ...s,
              id: result.session_id,
              total_pages: result.total_pages,
              pages: result.pages,
              // Replace the in-browser Word blob with the backend-converted
              // PDF so react-pdf can render it in the viewer.
              file: result.convertedPdf ?? s.file,
              filename: result.convertedPdf?.name ?? s.filename,
              status: 'ready' as const,
            }
          : s,
        ));
        // Also fix any tab that was opened with the tempId
        setOpenTabs(prev => prev.map(t => t === tempId ? result.session_id : t));
        if (activeTabId === tempId) setActiveTabId(result.session_id);
        newSessionIds.push(result.session_id);
        setModalOpen(false);
        toast.success(`PDF ready — ${ocrCount > 0 ? `${ocrCount} pages OCR'd` : 'all native text'}`);
        if (ocrCount > 0) toast('Draw boxes over the values you want, then click Extract', { duration: 5000, icon: 'ℹ️' });
      } catch (err: any) {
        setModalOpen(false);
        setSessions(prev => prev.filter(s => s.id !== tempId));
        setOpenTabs(prev => prev.filter(t => t !== tempId));
        toast.error(`Processing failed: ${err.message || 'Unknown error'}`);
        if (err.message?.includes('fetch') || err.message?.includes('network')) setBackendDown(true);
      }
    }
    // Open all processed files as tabs, activate the first one
    if (newSessionIds.length > 0) {
      setOpenTabs(prev => {
        const merged = [...prev];
        for (const id of newSessionIds) {
          if (!merged.includes(id)) merged.push(id);
        }
        return merged;
      });
      setActiveTabId(newSessionIds[0]);
      setNavCollapsed(true);
    }
    setPendingFiles([]); setProcessing(false);
  }, [pendingFiles, pendingDocType, activeTabId]);

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

  // Extract every session whose tab is currently OPEN and has highlights.
  // Closed-tab sessions keep their existing extractedData (still visible in
  // the Excel panel) but are skipped on subsequent extract runs — closing a
  // tab is our signal that the user is done with that PDF.
  const handleExtract = useCallback(async () => {
    const openTabSet = new Set(openTabs);
    const targets = sessions.filter(s =>
      s.file && Object.values(s.highlights).flat().length > 0 &&
      (s.status === 'ready' || s.status === 'extracted') &&
      openTabSet.has(s.id)
    );
    if (!targets.length) { toast('Draw highlight boxes first', { icon: 'ℹ️' }); return; }

    setExtracting(true);
    let totalExtracted = 0;
    let totalNull = 0;

    // Process all sessions in parallel — each makes one backend call.
    const settled = await Promise.allSettled(targets.map(async sess => {
      const clearedHighlights: Record<number, Highlight[]> = {};
      for (const [pageNum, pageHls] of Object.entries(sess.highlights)) {
        clearedHighlights[Number(pageNum)] = pageHls.map(h => ({
          ...h, extractedValue: undefined, confidence: undefined, wasOcr: undefined,
        }));
      }
      const allHl = Object.values(clearedHighlights).flat();
      const results = await extractRegions(sess.id, allHl, sess.file!, { strict: true });

      const newHighlights = { ...clearedHighlights };
      let idx = 0;
      for (const [pageNum, pageHls] of Object.entries(newHighlights)) {
        newHighlights[Number(pageNum)] = pageHls.map(h => {
          const r = results[idx++];
          return r ? { ...h, extractedValue: r.value, confidence: r.confidence, wasOcr: r.wasOcr } : h;
        });
      }
      const sessResults: ExtractedRow[] = Object.values(newHighlights).flat()
        .filter(h => h.extractedValue !== undefined)
        .map(h => ({
          page: h.page, field: h.field, value: h.extractedValue ?? null,
          confidence: h.confidence ?? 'low', wasOcr: h.wasOcr ?? false,
          filename: sess.filename, folderName: sess.folderName, sessionId: sess.id,
        }));
      return { sess, newHighlights, sessResults };
    }));

    const updates: { id: string; highlights: Record<number, Highlight[]>; extractedData: ExtractedRow[] }[] = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        const { sess, newHighlights, sessResults } = result.value;
        updates.push({ id: sess.id, highlights: newHighlights, extractedData: sessResults });
        totalExtracted += sessResults.length;
        totalNull += sessResults.filter(r => !r.value).length;
      } else {
        toast.error(`Extraction failed: ${result.reason?.message ?? 'unknown error'}`);
      }
    }
    if (updates.length > 0) {
      setSessions(prev => prev.map(s => {
        const u = updates.find(x => x.id === s.id);
        return u ? { ...s, highlights: u.highlights, extractedData: u.extractedData, status: 'extracted' as const } : s;
      }));
    }

    setShowExcel(true);
    toast.success(`Extracted ${totalExtracted} value${totalExtracted !== 1 ? 's' : ''} from ${targets.length} PDF${targets.length !== 1 ? 's' : ''}`);
    if (totalNull > 0) toast.warning(`${totalNull} field${totalNull !== 1 ? 's' : ''} returned empty`);
    setExtracting(false);

    // Track usage — also report each session's doc type so the admin
    // dashboard can show "user X scraped N appraisal, M utility_bill, …".
    const docTypes = targets.map(t => t.docType);
    trackUsage(targets.length, totalExtracted, docTypes).catch(() => {});
  }, [sessions, openTabs, trackUsage]);

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

    const targets = sessions.filter(s =>
      s.id !== activeTabId
      && (s.status === 'ready' || s.status === 'extracted')
      && !!s.file
      && (restrictIds ? restrictIds.has(s.id) : true),
    );

    // Clone each source highlight onto the equivalent target page at the
    // same raw coordinates — no text lookup, no auto-snapping to matching
    // text on the target PDF.
    const perTargetUpdates = targets.map(target => {
      const tgtStart = target.startPage || 1;
      const totalPgs = target.total_pages || target.pages.length;
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
    const { searchBackend } = await import('@/lib/api');
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

      // Cache backend search by key text for THIS target — one network
      // round-trip per key, then per-page lookup is local.
      const backendByKey = new Map<string, Map<number, { x: number; y: number; width: number; height: number }[]>>();
      // Track the live session id for this target — may be renewed once if the
      // original session expired (e.g. server restarted since upload).
      let liveTargetId = target.id;
      let targetSessionRenewed = false;
      const fetchBackendKey = async (q: string) => {
        if (backendByKey.has(q)) return backendByKey.get(q)!;
        const map = new Map<number, { x: number; y: number; width: number; height: number }[]>();
        for (const mode of ['exact', 'partial', 'fuzzy'] as const) {
          let r = await searchBackend(liveTargetId, q, mode);
          // null means HTTP error (likely 404 = session expired). Try re-uploading once.
          if (r === null && !targetSessionRenewed && file) {
            targetSessionRenewed = true;
            console.warn(`[AutoApply] "${target.filename}" session expired — re-uploading…`);
            try {
              const { reprocessFile } = await import('@/lib/api');
              const newId = await reprocessFile(file);
              if (newId) {
                liveTargetId = newId;
                console.log(`[AutoApply] "${target.filename}" re-uploaded → session ${newId.slice(-6)}`);
                // The re-upload creates a fresh session whose search index is not yet
                // built. Building it (OCR on all pages) can take minutes for large
                // scanned PDFs. Apply a timeout so we fall through to the source-page
                // coordinate fallback quickly — the index will be cached for next time.
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 5_000);
                try {
                  r = await searchBackend(liveTargetId, q, mode, { signal: ctrl.signal });
                } catch { r = null; } finally { clearTimeout(timer); }
              }
            } catch { /* fall through to pdfjs */ }
          }
          if (!r || r.results.length === 0) continue;
          for (const m of r.results) {
            const dims = r.page_sizes[String(m.page)];
            if (!dims) continue;
            const arr = map.get(m.page) ?? [];
            for (const [x1, y1, x2, y2] of m.boxes) {
              arr.push({
                x: x1 / dims.width,
                y: y1 / dims.height,
                width:  (x2 - x1) / dims.width,
                height: (y2 - y1) / dims.height,
              });
            }
            map.set(m.page, arr);
          }
          if (map.size > 0) break;
        }
        backendByKey.set(q, map);
        return map;
      };

      // Prefetch all keys in parallel before the page loop.
      await Promise.all(pairs.filter(p => !p.useAbsoluteCoords).map(p => fetchBackendKey(p.keyText)));

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
              let match: { x: number; y: number; width: number; height: number } | null = null;
              const backendMap = await fetchBackendKey(p.keyText);
              match = await preferInTable(backendMap.get(pg) ?? [], pg);
              if (!match) {
                const cands = await findAllTextPositionsInPdfPage(file, pg, p.keyText);
                match = await preferInTable(cands, pg);
              }
              if (!match) {
                // Key readable (OCR got text) but not in the search index — the label
                // is image-embedded (e.g. DocuSign form background). Fall back to the
                // drawn box coordinates, but only for the matching source page.
                if (pg !== p.sourcePage) continue;
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

  // Download Excel tables for every ctrl/cmd-selected PDF sequentially.
  const handleDownloadExcelSelected = useCallback(async (): Promise<void> => {
    const targets = sessions.filter(s => multiSelectedTabIds.has(s.id));
    if (targets.length === 0) {
      toast('No PDFs selected — Ctrl/Cmd+click tabs to select', { icon: 'ℹ️' });
      return;
    }
    let done = 0;
    const failed: string[] = [];
    for (const s of targets) {
      try {
        await downloadExcel(s.id, s.filename);
        done++;
      } catch (err) {
        failed.push(s.filename);
      }
    }
    if (done > 0) toast.success(`Downloaded Excel for ${done} PDF${done !== 1 ? 's' : ''}`);
    if (failed.length > 0) toast.error(`Failed: ${failed.join(', ')}`);
  }, [sessions, multiSelectedTabIds]);

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
  const hasActiveViewer = activeSession &&
    activeSession.status !== 'uploading' &&
    activeSession.status !== 'processing';

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
                    pendingFiles={pendingFiles}
                    onFileRemove={(idx) => setPendingFiles(prev => prev.filter((_, i) => i !== idx))}
                    docType={pendingDocType}
                    onDocTypeChange={setPendingDocType}
                    onProcess={handleProcess}
                    processing={processing}
                  />
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
            {user?.roles.includes('admin') && (
              <button
                onClick={() => navigate('/admin')}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-all duration-200 px-2 py-1.5 rounded-lg hover:bg-muted"
                title="Usage Dashboard"
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Usage</span>
              </button>
            )}
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
            <div className="bg-muted flex items-end overflow-x-auto shrink-0 px-1 pt-1 gap-px">
              {tabSessions.map(s => {
                const isActive = s.id === activeTabId;
                const dt = DOCUMENT_TYPES.find(d => d.value === s.docType);
                return (
                  <div
                    key={s.id}
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
                    className={`group flex items-center gap-1.5 pl-3 pr-1 py-1.5 rounded-t-lg text-xs cursor-grab
                      max-w-[200px] min-w-[100px] select-none transition-colors
                      ${dragTabId === s.id ? 'opacity-40' : ''}
                      ${multiSelectedTabIds.has(s.id) ? 'ring-2 ring-primary ring-offset-1 ring-offset-muted' : ''}
                      ${isActive
                        ? 'bg-card text-foreground font-medium'
                        : 'bg-muted/60 text-muted-foreground hover:bg-muted/80'
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
                    <span className="truncate flex-1">{s.filename}</span>
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
          )}

          {/* ── Viewer + Excel panel ─────────────────────────────────── */}
          {hasActiveViewer ? (
            <div className="flex-1 flex overflow-hidden">
              <div className="flex-1 flex flex-col overflow-hidden min-w-0">
                <PDFViewer
                  key={activeSession.id}
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
                  onAutoApplyAllPdfs={handleAutoApplyAllPdfs}
                  onRemoveFieldFromAllPdfs={handleRemoveFieldFromAllPdfs}
                  onRemoveFieldFromSelectedPdfs={multiSelectedTabIds.size > 0
                    ? handleRemoveFieldFromSelectedPdfs
                    : undefined}
                  onDownloadExcelSelected={multiSelectedTabIds.size > 0
                    ? handleDownloadExcelSelected
                    : undefined}
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
                      onClose={() => setShowExcel(false)}
                      onReExtract={handleExtract}
                      onDataChange={(d: ExtractedRow[]) => {
                        setSessions(prev => prev.map(s => ({
                          ...s,
                          extractedData: d.filter(r => r.sessionId === s.id),
                        })));
                      }}
                      multiFile={sessions.filter(s => s.extractedData.length > 0).length > 1}
                      onDownload={() => trackDownload().catch(() => {})}
                      onRowClick={handleExcelRowClick}
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

      <ProcessingModal open={modalOpen} step={modalStep} detail={modalDetail} fileIndex={modalFileIdx} totalFiles={modalTotalFiles} />
    </div>
  );
}
