/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import {
  Upload, ChevronLeft, ChevronRight,
  AlertTriangle, FileSearch, X, ShieldCheck, LogOut, Landmark,
  RotateCw, Eraser,
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
import { processFile, extractRegions } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';

export default function Index() {
  const { user, trackUsage, trackDownload, logout } = useAuth();
  const navigate = useNavigate();
  const [sessions, setSessions]                 = useState<PDFSession[]>([]);
  const [openTabs, setOpenTabs]                 = useState<string[]>([]);
  const [activeTabId, setActiveTabId]           = useState<string | null>(null);
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
  const [navCollapsed, setNavCollapsed]         = useState(false);
  const [pendingDocType, setPendingDocType]     = useState<DocumentType>('utility_bill');
  const [dragTabId, setDragTabId]               = useState<string | null>(null);

  const activeSession = sessions.find(s => s.id === activeTabId);
  const hasUploaded   = sessions.length > 0 || pendingFiles.length > 0;

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
      const file = pendingFiles[i];
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setSessions(prev => [...prev, {
        id: tempId, filename: file.name, file,
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
          ? { ...s, id: result.session_id, total_pages: result.total_pages, pages: result.pages, status: 'ready' as const } : s
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

  const handleHighlightsChange = useCallback((sessionId: string, highlights: Record<number, Highlight[]>) => {
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, highlights } : s));
  }, []);

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

  // Extract ALL sessions that have highlights (not just the active tab)
  const handleExtract = useCallback(async () => {
    const targets = sessions.filter(s =>
      s.file && Object.values(s.highlights).flat().length > 0 &&
      (s.status === 'ready' || s.status === 'extracted')
    );
    if (!targets.length) { toast('Draw highlight boxes first', { icon: 'ℹ️' }); return; }

    setExtracting(true);
    let totalExtracted = 0;
    let totalNull = 0;

    for (const sess of targets) {
      // Clear all previous extracted values — fresh extraction every time
      const clearedHighlights: Record<number, Highlight[]> = {};
      for (const [pageNum, pageHls] of Object.entries(sess.highlights)) {
        clearedHighlights[Number(pageNum)] = pageHls.map(h => ({
          ...h, extractedValue: undefined, confidence: undefined, wasOcr: undefined,
        }));
      }
      const allHl = Object.values(clearedHighlights).flat();

      try {
        const results = await extractRegions(sess.id, allHl, sess.file!);

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
            filename: sess.filename, sessionId: sess.id,
          }));

        setSessions(prev => prev.map(s => s.id === sess.id
          ? { ...s, highlights: newHighlights, extractedData: sessResults, status: 'extracted' as const } : s));

        totalExtracted += sessResults.length;
        totalNull += sessResults.filter(r => !r.value).length;
      } catch (err: any) {
        toast.error(`Extraction failed for ${sess.filename}: ${err.message}`);
      }
    }

    setShowExcel(true);
    toast.success(`Extracted ${totalExtracted} value${totalExtracted !== 1 ? 's' : ''} from ${targets.length} PDF${targets.length !== 1 ? 's' : ''}`);
    if (totalNull > 0) toast.warning(`${totalNull} field${totalNull !== 1 ? 's' : ''} returned empty`);
    setExtracting(false);

    // Track usage
    trackUsage(targets.length, totalExtracted).catch(() => {});
  }, [sessions, trackUsage]);

  const handleReExtractHighlight = useCallback(async (highlightId: string) => {
    if (!activeSession?.file) return;
    const newHighlights = { ...activeSession.highlights };
    let found: Highlight | null = null;
    for (const [pageNum, pageHls] of Object.entries(newHighlights)) {
      newHighlights[Number(pageNum)] = pageHls.map(h => {
        if (h.id === highlightId) { found = { ...h, extractedValue: undefined, confidence: undefined }; return found; }
        return h;
      });
    }
    if (!found) return;
    setSessions(prev => prev.map(s => s.id === activeSession.id ? { ...s, highlights: newHighlights } : s));
    setExtracting(true);
    try {
      const results = await extractRegions(activeSession.id, [found], activeSession.file);
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
          .map(h => ({ page: h.page, field: h.field, value: h.extractedValue ?? null, confidence: h.confidence ?? 'low', wasOcr: h.wasOcr ?? false }));
        return { ...s, highlights: hls, extractedData: allResults };
      }));
      if (result.value) toast.success(`Re-extracted: ${result.value}`);
      else toast.warning('Re-extraction returned empty');
    } catch (err: any) { toast.error(`Re-extraction failed: ${err.message}`); }
    setExtracting(false);
  }, [activeSession]);

  // Mirror the active session's highlights to all other PDFs, mapping via startPage offsets.
  // Source page 3 with startPage=2 → relative page 1 → target page = target.startPage + 1 - 1
  const handleApplyToAllPdfs = useCallback((sourceHighlights: Record<number, Highlight[]>) => {
    const sourceSession = sessions.find(s => s.id === activeTabId);
    if (!sourceSession) return;
    const srcStart = sourceSession.startPage || 1;

    setSessions(prev => prev.map(s => {
      if (s.id === activeTabId) return s; // skip the source session
      if (s.status !== 'ready' && s.status !== 'extracted') return s;
      const tgtStart = s.startPage || 1;
      const totalPgs = s.total_pages || s.pages.length;
      const next: Record<number, Highlight[]> = {};

      for (const [pageStr, pageHls] of Object.entries(sourceHighlights)) {
        const srcPage = Number(pageStr);
        // Map: source relative → target actual
        const relPage = srcPage - srcStart;           // 0-based content page index
        const tgtPage = tgtStart + relPage;           // target actual page
        if (tgtPage < 1 || tgtPage > totalPgs) continue;

        next[tgtPage] = pageHls.map(h => ({
          ...h,
          id: `hl-${Date.now()}-${s.id.slice(-4)}-${tgtPage}-${Math.random().toString(36).slice(2, 6)}`,
          page: tgtPage,
          extractedValue: undefined,
          confidence: undefined,
        }));
      }
      return { ...s, highlights: next, extractedData: [], status: 'ready' as const };
    }));
    toast.success('Highlights mirrored to all open PDFs (offset-mapped)');
  }, [activeTabId, sessions]);

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

              {/* Upload section */}
              <div>
                <div className="flex items-center gap-2 mb-2.5">
                  <Upload className="w-3.5 h-3.5 text-primary" />
                  <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Upload PDFs</h2>
                </div>
                <UploadZone
                  compact={hasUploaded}
                  onFilesSelected={handleFilesSelected}
                  pendingFiles={pendingFiles}
                  docType={pendingDocType}
                  onDocTypeChange={setPendingDocType}
                  onProcess={handleProcess}
                  processing={processing}
                />
              </div>

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
                    <span className="ml-auto text-[10px] text-muted-foreground/60">{sessions.length} file{sessions.length !== 1 ? 's' : ''}</span>
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
                      ${isActive
                        ? 'bg-card text-foreground font-medium'
                        : 'bg-muted/60 text-muted-foreground hover:bg-muted/80'
                      }`}
                    onClick={() => setActiveTabId(s.id)}
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
                  onStartPageChange={handleStartPageChange}
                  extracting={extracting}
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
