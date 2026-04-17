import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import type { PDFSession, Highlight, FieldLabel, ViewerTool } from '@/types/utilscraper';
import ViewerToolbar from './ViewerToolbar';
import HighlightOverlay from './HighlightOverlay';
import FieldLabelPicker from './FieldLabelPicker';
import HighlightLegend from './HighlightLegend';

// Set worker unconditionally — pdf-extract.ts also sets this
// so pdfjs works both in viewer and in api.ts calls
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface PDFViewerProps {
  session: PDFSession;
  onHighlightsChange: (sessionId: string, highlights: Record<number, Highlight[]>) => void;
  onExtract: () => void;
  onReExtract: (highlightId: string) => void;
  onApplyToAllPdfs: (sourceHighlights: Record<number, Highlight[]>) => void;
  onStartPageChange: (sessionId: string, startPage: number) => void;
  extracting: boolean;
  // When this changes, scroll to the given page. `nonce` forces re-fire even if
  // the user clicks the same row twice.
  scrollToPageTrigger?: { page: number; nonce: number } | null;
}

export default function PDFViewer({
  session,
  onHighlightsChange,
  onExtract,
  onReExtract,
  onApplyToAllPdfs,
  onStartPageChange,
  extracting,
  scrollToPageTrigger,
}: PDFViewerProps) {
  const [currentPage, setCurrentPage]   = useState(session.startPage || 1);
  const [zoom, setZoom]                 = useState<number | null>(null);
  const [fineRotation, setFineRotation] = useState(0);
  const [tool, setTool]                 = useState<ViewerTool>('cursor');
  const [drawingPage, setDrawingPage]   = useState<number | null>(null);
  const [drawing, setDrawing]           = useState<{
    startX: number; startY: number;
    x: number; y: number; w: number; h: number;
  } | null>(null);
  const [pickerPos, setPickerPos]       = useState<{
    x: number; y: number;
    rect: { x: number; y: number; w: number; h: number };
    page: number;
  } | null>(null);

  // Custom field names added by the user during this session
  const [customFields, setCustomFields] = useState<string[]>([]);

  // Rubber-band selection + multi-select
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionBox, setSelectionBox] = useState<{
    page: number;
    startX: number; startY: number;
    x: number; y: number; w: number; h: number;
  } | null>(null);

  const [showFirstHint, setShowFirstHint] = useState(true);
  const [numPages, setNumPages]         = useState<number | null>(null);
  const [fileUrl, setFileUrl]           = useState<string | null>(null);
  const [pdfPageWidth, setPdfPageWidth] = useState<number | null>(null);
  const [searchOpen, setSearchOpen]     = useState(false);
  const [searchQuery, setSearchQuery]   = useState('');
  const [searchResults, setSearchResults] = useState<Record<number, { x: number; y: number; width: number; height: number }[]>>({});
  const [pdfLoaded, setPdfLoaded]       = useState(false);

  const pageRefs  = useRef<Record<number, HTMLDivElement | null>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  // Highlight clipboard — stores the templates of copied highlights
  const clipboardRef = useRef<Highlight[] | null>(null);
  // Always-fresh ref for the current page (for paste-anywhere)
  const currentPageRef = useRef<number>(session.startPage || 1);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfDocRef = useRef<any>(null);

  const totalPages = numPages ?? session.total_pages;

  const pageHighlights = useMemo(
    () => session.highlights[currentPage] ?? [],
    [session.highlights, currentPage],
  );

  const allHighlights = useMemo(
    () => Object.values(session.highlights).flat(),
    [session.highlights],
  );

  const currentPageInfo = useMemo(
    () => Array.isArray(session.pages)
      ? session.pages.find(p => p.page_number === currentPage)
      : undefined,
    [session.pages, currentPage],
  );

  // Stable object URL from the File
  useEffect(() => {
    if (!session.file) return;
    const url = URL.createObjectURL(session.file);
    setFileUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [session.file]);

  // Compute fit-width zoom
  useEffect(() => {
    if (pdfPageWidth && scrollRef.current && zoom === null) {
      const available = scrollRef.current.clientWidth - 24 - 48 - 24;
      const fitZoom = Math.max(0.3, Math.min(1.75, available / pdfPageWidth));
      setZoom(parseFloat(fitZoom.toFixed(2)));
    }
  }, [pdfPageWidth, zoom]);

  // Scroll to startPage after PDF renders
  useEffect(() => {
    if (!pdfLoaded) return;
    const sp = session.startPage || 1;
    if (sp > 1) {
      const t = setTimeout(() => {
        const el = pageRefs.current[sp];
        if (el) el.scrollIntoView({ behavior: 'auto', block: 'start' });
      }, 200);
      return () => clearTimeout(t);
    }
  }, [pdfLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track current page via scroll position
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !pdfLoaded) return;

    const handleScroll = () => {
      const containerRect = container.getBoundingClientRect();
      const containerMid  = containerRect.top + containerRect.height / 2;
      let closest = currentPage;
      let closestDist = Infinity;

      for (const [pStr, el] of Object.entries(pageRefs.current)) {
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        const dist = Math.abs(mid - containerMid);
        if (dist < closestDist) {
          closestDist = dist;
          closest = Number(pStr);
        }
      }
      if (closest !== currentPage) {
        setCurrentPage(closest);
        currentPageRef.current = closest;
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [pdfLoaded, currentPage]);

  // Keep ref in sync if currentPage changes via other means
  useEffect(() => { currentPageRef.current = currentPage; }, [currentPage]);

  // Global mouseUp fallback
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (drawing) { setDrawing(null); setDrawingPage(null); }
    };
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
  }, [drawing]);

  const updateHighlights = useCallback(
    (pageNum: number, hl: Highlight[]) => {
      const next = { ...session.highlights, [pageNum]: hl };
      onHighlightsChange(session.id, next);
    },
    [session, onHighlightsChange],
  );

  // -----------------------------------------------------------------------
  // Mouse drawing handlers — page-aware
  // -----------------------------------------------------------------------
  const getRelativePos = useCallback((clientX: number, clientY: number, pageEl: HTMLDivElement) => {
    const canvas = pageEl.querySelector('canvas');
    const target = canvas ?? pageEl;
    const rect   = target.getBoundingClientRect();

    if (fineRotation !== 0) {
      const cx = rect.left + rect.width / 2;
      const cy = rect.top  + rect.height / 2;
      const dx = clientX - cx;
      const dy = clientY - cy;
      const rad = (-fineRotation * Math.PI) / 180;
      const cosA = Math.cos(rad);
      const sinA = Math.sin(rad);
      const localX = dx * cosA - dy * sinA;
      const localY = dx * sinA + dy * cosA;
      const uw = target.clientWidth  || rect.width;
      const uh = target.clientHeight || rect.height;
      return { x: (localX + uw / 2) / uw, y: (localY + uh / 2) / uh, px: localX + uw / 2, py: localY + uh / 2 };
    }

    return {
      x:  (clientX - rect.left) / rect.width,
      y:  (clientY - rect.top)  / rect.height,
      px: clientX - rect.left,
      py: clientY - rect.top,
    };
  }, [fineRotation]);

  const handlePageMouseDown = useCallback((e: React.MouseEvent, pageNum: number) => {
    const el = pageRefs.current[pageNum];
    if (!el) return;
    const pos = getRelativePos(e.clientX, e.clientY, el);
    if (!pos) return;

    if (tool === 'highlight') {
      e.preventDefault();
      setDrawingPage(pageNum);
      setDrawing({ startX: pos.x, startY: pos.y, x: pos.x, y: pos.y, w: 0, h: 0 });
      setPickerPos(null);
      return;
    }

    // Cursor mode — start rubber-band selection on empty space.
    // Clicks on highlight boxes are stopped by HighlightOverlay, so this only
    // fires when clicking empty PDF area.
    if (tool === 'cursor') {
      e.preventDefault();
      // Clear prior selection unless user holds shift/ctrl
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey) setSelectedIds(new Set());
      setSelectionBox({
        page: pageNum,
        startX: pos.x, startY: pos.y,
        x: pos.x, y: pos.y, w: 0, h: 0,
      });
    }
  }, [tool, getRelativePos]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    // Highlight drawing
    if (drawing && drawingPage !== null) {
      const el = pageRefs.current[drawingPage];
      if (!el) return;
      const pos = getRelativePos(e.clientX, e.clientY, el);
      if (!pos) return;
      setDrawing({
        ...drawing,
        x: Math.min(drawing.startX, pos.x),
        y: Math.min(drawing.startY, pos.y),
        w: Math.abs(pos.x - drawing.startX),
        h: Math.abs(pos.y - drawing.startY),
      });
      return;
    }

    // Rubber-band selection
    if (selectionBox) {
      const el = pageRefs.current[selectionBox.page];
      if (!el) return;
      const pos = getRelativePos(e.clientX, e.clientY, el);
      if (!pos) return;
      setSelectionBox({
        ...selectionBox,
        x: Math.min(selectionBox.startX, pos.x),
        y: Math.min(selectionBox.startY, pos.y),
        w: Math.abs(pos.x - selectionBox.startX),
        h: Math.abs(pos.y - selectionBox.startY),
      });
    }
  }, [drawing, drawingPage, selectionBox, getRelativePos]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    // Finish highlight drawing
    if (drawing && drawingPage !== null) {
      if (drawing.w < 0.01 || drawing.h < 0.005) {
        setDrawing(null); setDrawingPage(null);
        return;
      }
      const el = pageRefs.current[drawingPage];
      if (!el) { setDrawing(null); setDrawingPage(null); return; }
      const pos = getRelativePos(e.clientX, e.clientY, el);
      const px  = pos?.px ?? e.clientX;
      const py  = pos?.py ?? e.clientY;
      setPickerPos({
        x:    Math.min(px, (el.offsetWidth  ?? 600) - 160),
        y:    Math.min(py, (el.offsetHeight ?? 800) - 200),
        rect: { x: drawing.x, y: drawing.y, w: drawing.w, h: drawing.h },
        page: drawingPage,
      });
      setDrawing(null);
      setDrawingPage(null);
      return;
    }

    // Finish rubber-band selection — find intersecting highlights
    if (selectionBox) {
      const tooSmall = selectionBox.w < 0.005 && selectionBox.h < 0.005;
      if (!tooSmall) {
        const pageHls = session.highlights[selectionBox.page] ?? [];
        const sx1 = selectionBox.x;
        const sy1 = selectionBox.y;
        const sx2 = selectionBox.x + selectionBox.w;
        const sy2 = selectionBox.y + selectionBox.h;
        const hit = pageHls.filter(h => {
          const hx1 = h.x, hy1 = h.y;
          const hx2 = h.x + h.width, hy2 = h.y + h.height;
          // Intersection test
          return hx1 < sx2 && hx2 > sx1 && hy1 < sy2 && hy2 > sy1;
        }).map(h => h.id);

        setSelectedIds(prev => {
          const next = new Set(prev);
          for (const id of hit) next.add(id);
          return next;
        });
      }
      setSelectionBox(null);
    }
  }, [drawing, drawingPage, selectionBox, session.highlights, getRelativePos]);

  // -----------------------------------------------------------------------
  // Label selection — uses pickerPos.page
  // -----------------------------------------------------------------------
  const handleLabelSelect = useCallback(
    (field: FieldLabel, customLabel?: string) => {
      if (!pickerPos) return;
      const pg = pickerPos.page;
      const hl: Highlight = {
        id:     `hl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        page:   pg,
        field:  customLabel ?? field,
        x:      pickerPos.rect.x,
        y:      pickerPos.rect.y,
        width:  pickerPos.rect.w,
        height: pickerPos.rect.h,
      };
      const existing = session.highlights[pg] ?? [];
      updateHighlights(pg, [...existing, hl]);
      // Remember user-added custom field name so it appears in subsequent pickers
      if (customLabel && customLabel.trim()) {
        setCustomFields(prev => prev.includes(customLabel) ? prev : [...prev, customLabel]);
      }
      setPickerPos(null);
      setShowFirstHint(false);
    },
    [pickerPos, session.highlights, updateHighlights],
  );

  // -----------------------------------------------------------------------
  // Toolbar actions
  // -----------------------------------------------------------------------
  const handleMoveHighlight = useCallback(
    (id: string, pageNum: number, newX: number, newY: number) => {
      const hls = session.highlights[pageNum] ?? [];
      const dragged = hls.find(h => h.id === id);
      if (!dragged) return;
      const deltaX = newX - dragged.x;
      const deltaY = newY - dragged.y;

      // If multiple highlights are selected and the dragged one is among them,
      // move the whole group by the same delta.
      const movingGroup = selectedIds.size > 1 && selectedIds.has(id);

      const updated = hls.map(h => {
        if (movingGroup && selectedIds.has(h.id)) {
          return {
            ...h,
            x: Math.max(0, Math.min(1 - h.width,  h.x + deltaX)),
            y: Math.max(0, Math.min(1 - h.height, h.y + deltaY)),
            extractedValue: undefined, confidence: undefined, wasOcr: undefined,
          };
        }
        if (h.id === id) {
          return {
            ...h, x: newX, y: newY,
            extractedValue: undefined, confidence: undefined, wasOcr: undefined,
          };
        }
        return h;
      });
      updateHighlights(pageNum, updated);
    },
    [session.highlights, updateHighlights, selectedIds],
  );

  const handleDeleteHighlight = useCallback(
    (id: string, pageNum: number) => {
      const hls = session.highlights[pageNum] ?? [];
      updateHighlights(pageNum, hls.filter(h => h.id !== id));
    },
    [session.highlights, updateHighlights],
  );

  const handleEraseAll = useCallback(
    () => updateHighlights(currentPage, []),
    [currentPage, updateHighlights],
  );

  const handleToolChange = useCallback(
    (t: ViewerTool) => {
      if (t === 'eraser') {
        handleEraseAll();
        setTool('cursor');
      } else {
        setTool(t);
      }
      setPickerPos(null);
      setSelectedIds(new Set());
      setSelectionBox(null);
    },
    [handleEraseAll],
  );

  // -----------------------------------------------------------------------
  // Bulk highlight actions
  // -----------------------------------------------------------------------
  const handleApplyToAllPages = useCallback(() => {
    if (pageHighlights.length === 0) return;
    const next = { ...session.highlights };
    for (let p = 1; p <= totalPages; p++) {
      if (p === currentPage) continue;
      next[p] = pageHighlights.map(h => ({
        ...h,
        id: `hl-${Date.now()}-${p}-${Math.random().toString(36).slice(2, 6)}`,
        page: p,
        extractedValue: undefined,
        confidence: undefined,
      }));
    }
    onHighlightsChange(session.id, next);
  }, [pageHighlights, session, totalPages, currentPage, onHighlightsChange]);

  const handleApplyToPageRange = useCallback((pages: number[]) => {
    if (pageHighlights.length === 0 || pages.length === 0) return;
    const next = { ...session.highlights };
    const stamp = Date.now();
    for (const p of pages) {
      if (p === currentPage) continue;
      next[p] = pageHighlights.map(h => ({
        ...h,
        id: `hl-${stamp}-${p}-${Math.random().toString(36).slice(2, 6)}`,
        page: p,
        extractedValue: undefined,
        confidence: undefined,
      }));
    }
    onHighlightsChange(session.id, next);
  }, [pageHighlights, session, currentPage, onHighlightsChange]);

  const handleEraseAllPages = useCallback(() => {
    onHighlightsChange(session.id, {});
  }, [session.id, onHighlightsChange]);

  const handleApplyToAllPdfs = useCallback(() => {
    if (allHighlights.length === 0) return;
    onApplyToAllPdfs(session.highlights);
  }, [allHighlights, session.highlights, onApplyToAllPdfs]);

  // Toolbar page nav → scroll to page
  const scrollToPage = useCallback((p: number) => {
    const clamped = Math.max(1, Math.min(p, totalPages));
    const el = pageRefs.current[clamped];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [totalPages]);

  // External trigger (e.g. Excel panel row click) → jump to page
  useEffect(() => {
    if (!scrollToPageTrigger || !pdfLoaded) return;
    setCurrentPage(scrollToPageTrigger.page);
    scrollToPage(scrollToPageTrigger.page);
  }, [scrollToPageTrigger, pdfLoaded, scrollToPage]);

  // -----------------------------------------------------------------------
  // Text search
  // -----------------------------------------------------------------------
  const handleSearch = useCallback(async (query: string) => {
    setSearchQuery(query);
    if (!query.trim() || !pdfDocRef.current) {
      setSearchResults({});
      return;
    }
    try {
      const queryLower = query.toLowerCase();
      const allHits: Record<number, { x: number; y: number; width: number; height: number }[]> = {};
      for (let p = 1; p <= totalPages; p++) {
        const page = await pdfDocRef.current.getPage(p);
        const content = await page.getTextContent();
        const vp = page.getViewport({ scale: 1 });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const items = content.items as any[];
        const hits: { x: number; y: number; width: number; height: number }[] = [];
        for (const item of items) {
          if (!item.str || !item.transform) continue;
          if (!item.str.toLowerCase().includes(queryLower)) continue;
          const x = item.transform[4];
          const itemTop = vp.height - item.transform[5];
          const itemH = item.height || Math.abs(item.transform[3]) || 12;
          const itemW = item.width || item.str.length * 6;
          hits.push({ x: x / vp.width, y: itemTop / vp.height, width: itemW / vp.width, height: itemH / vp.height });
        }
        if (hits.length > 0) allHits[p] = hits;
      }
      setSearchResults(allHits);
    } catch { setSearchResults({}); }
  }, [totalPages]);

  // Close picker / search on Escape, toggle search with Ctrl+F, delete selected highlights
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input
      const target = e.target as HTMLElement | null;
      const isEditing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      if (e.key === 'Escape') {
        if (searchOpen) { setSearchOpen(false); setSearchQuery(''); setSearchResults({}); }
        else if (selectedIds.size > 0) setSelectedIds(new Set());
        else setPickerPos(null);
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !isEditing && selectedIds.size > 0) {
        e.preventDefault();
        // Delete all selected highlights across all pages
        const nextHighlights: Record<number, Highlight[]> = {};
        for (const [pageStr, hls] of Object.entries(session.highlights)) {
          const kept = hls.filter(h => !selectedIds.has(h.id));
          if (kept.length > 0) nextHighlights[Number(pageStr)] = kept;
        }
        onHighlightsChange(session.id, nextHighlights);
        setSelectedIds(new Set());
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setSearchOpen(o => !o);
      }
      // Ctrl+A → select all highlights on current page
      if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !isEditing) {
        e.preventDefault();
        const ids = (session.highlights[currentPage] ?? []).map(h => h.id);
        setSelectedIds(new Set(ids));
      }
      // Ctrl+C → copy selected highlights to in-memory clipboard
      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && !isEditing && selectedIds.size > 0) {
        e.preventDefault();
        const allHls = Object.values(session.highlights).flat();
        const copied = allHls
          .filter(h => selectedIds.has(h.id))
          .map(h => ({ ...h }));
        clipboardRef.current = copied;
      }
      // Ctrl+V → paste highlights onto the currently visible page
      if ((e.ctrlKey || e.metaKey) && e.key === 'v' && !isEditing && clipboardRef.current && clipboardRef.current.length > 0) {
        e.preventDefault();
        const targetPage = currentPageRef.current;
        const offset = 0.02;
        const stamp = Date.now();
        const newHls: Highlight[] = clipboardRef.current.map((h, i) => ({
          ...h,
          id: `hl-${stamp}-${i}-${Math.random().toString(36).slice(2, 6)}`,
          page: targetPage,
          x: Math.min(1 - h.width,  Math.max(0, h.x + offset)),
          y: Math.min(1 - h.height, Math.max(0, h.y + offset)),
          extractedValue: undefined,
          confidence: undefined,
          wasOcr: undefined,
        }));

        const existing = session.highlights[targetPage] ?? [];
        const next = { ...session.highlights, [targetPage]: [...existing, ...newHls] };
        onHighlightsChange(session.id, next);
        setSelectedIds(new Set(newHls.map(h => h.id)));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [searchOpen, selectedIds, session.highlights, session.id, onHighlightsChange, currentPage]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  if (!fileUrl) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Loading PDF...
      </div>
    );
  }

  const startPg = session.startPage || 1;

  return (
    <div className="flex flex-col h-full">
      <ViewerToolbar
        currentPage={currentPage}
        totalPages={totalPages}
        startPage={startPg}
        zoom={zoom ?? 1}
        tool={tool}
        isOcr={currentPageInfo?.is_ocr ?? false}
        hasHighlightsOnPage={pageHighlights.length > 0}
        onPageChange={scrollToPage}
        onZoomChange={setZoom}
        onToolChange={handleToolChange}
        onExtract={onExtract}
        extracting={extracting}
        hasHighlights={allHighlights.length > 0}
        onApplyToAllPages={handleApplyToAllPages}
        onApplyToAllPdfs={handleApplyToAllPdfs}
        onEraseAllPages={handleEraseAllPages}
        onApplyToPageRange={handleApplyToPageRange}
        searchOpen={searchOpen}
        onSearchToggle={() => {
          setSearchOpen(o => !o);
          if (searchOpen) { setSearchQuery(''); setSearchResults({}); }
        }}
        fineRotation={fineRotation}
        onFineRotationChange={setFineRotation}
        onStartPageChange={(sp) => onStartPageChange(session.id, sp)}
      />

      {/* Search bar */}
      {searchOpen && (
        <div className="bg-card border-b border-border px-3 py-1.5 flex items-center gap-2 shrink-0">
          <input
            className="flex-1 h-7 text-xs bg-muted rounded px-2 border-none outline-none focus:ring-1 focus:ring-primary text-foreground"
            placeholder="Search text on this page..."
            autoFocus
            value={searchQuery}
            onChange={e => handleSearch(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { setSearchOpen(false); setSearchQuery(''); setSearchResults({}); }
            }}
          />
          {searchQuery && (
            <span className="text-[11px] text-muted-foreground shrink-0">
              {(() => { const total = Object.values(searchResults).reduce((s, h) => s + h.length, 0); return `${total} match${total !== 1 ? 'es' : ''}`; })()}
            </span>
          )}
          <button
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-all duration-200"
            onClick={() => { setSearchOpen(false); setSearchQuery(''); setSearchResults({}); }}
          >
            <span className="text-xs">Esc</span>
          </button>
        </div>
      )}

      {/* Scrollable container — all pages like Acrobat */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto bg-viewer relative custom-scrollbar pr-6"
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
        {/* First-use hint overlay */}
        {showFirstHint && tool === 'highlight' && allHighlights.length === 0 && (
          <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
            <div className="bg-black/70 text-white px-4 py-2 rounded-lg text-sm font-medium backdrop-blur-sm">
              Draw boxes over the values you want to extract
            </div>
          </div>
        )}

        <Document
          file={fileUrl}
          onLoadSuccess={async (pdf) => {
            setNumPages(pdf.numPages);
            pdfDocRef.current = pdf;
            setPdfLoaded(true);
            if (!pdfPageWidth) {
              try {
                const p = await pdf.getPage(1);
                const vp = p.getViewport({ scale: 1 });
                setPdfPageWidth(vp.width);
              } catch { /* ignore */ }
            }
          }}
          loading={
            <div className="flex justify-center p-6">
              <div className="w-[600px] h-[800px] bg-white/10 animate-pulse rounded" />
            </div>
          }
          error={
            <div className="flex justify-center p-6">
              <div className="w-[600px] h-[400px] flex items-center justify-center text-red-400 text-sm bg-white rounded">
                Failed to load PDF
              </div>
            </div>
          }
        >
          {/* Pages stacked vertically */}
          <div className="flex flex-col items-center gap-6 p-6 pr-12">
            {Array.from({ length: totalPages }, (_, i) => i + 1).map(pageNum => {
              const pgHls   = session.highlights[pageNum] ?? [];
              const contentP = pageNum - startPg + 1;
              const isCover  = startPg > 1 && pageNum < startPg;

              return (
                <div
                  key={pageNum}
                  ref={el => { pageRefs.current[pageNum] = el; }}
                  className="relative shadow-2xl select-none"
                  style={{
                    display:    'inline-block',
                    lineHeight: 0,
                    cursor:     tool === 'highlight' ? 'crosshair' : 'default',
                    userSelect: tool === 'highlight' ? 'none' : 'auto',
                    transform:  fineRotation !== 0 ? `rotate(${fineRotation}deg)` : undefined,
                    transition: 'transform 0.3s ease',
                    opacity:    isCover ? 0.5 : 1,
                  }}
                  onMouseDown={e => handlePageMouseDown(e, pageNum)}
                >
                  <Page
                    pageNumber={pageNum}
                    scale={zoom ?? 1}
                    renderTextLayer={false}
                    renderAnnotationLayer={false}
                    loading={
                      <div className="w-[600px] h-[800px] bg-white/5 animate-pulse rounded" />
                    }
                  />

                  {/* Highlights for this page */}
                  <HighlightOverlay
                    highlights={pgHls}
                    drawing={drawingPage === pageNum && drawing
                      ? { x: drawing.x, y: drawing.y, w: drawing.w, h: drawing.h }
                      : null}
                    selectionBox={selectionBox && selectionBox.page === pageNum
                      ? { x: selectionBox.x, y: selectionBox.y, w: selectionBox.w, h: selectionBox.h }
                      : null}
                    selectedIds={selectedIds}
                    onDelete={id => handleDeleteHighlight(id, pageNum)}
                    onReExtract={onReExtract}
                    onMove={(id, x, y) => handleMoveHighlight(id, pageNum, x, y)}
                    onSelectToggle={(id, additive) => {
                      setSelectedIds(prev => {
                        const next = new Set(prev);
                        if (additive) {
                          if (next.has(id)) next.delete(id); else next.add(id);
                        } else {
                          next.clear();
                          next.add(id);
                        }
                        return next;
                      });
                    }}
                    tool={tool}
                  />

                  {/* Search highlights (shown on current page) */}
                  {(searchResults[pageNum]?.length ?? 0) > 0 && (
                    <div className="absolute inset-0 pointer-events-none overflow-hidden">
                      {(searchResults[pageNum] ?? []).map((r, i) => (
                        <div
                          key={i}
                          className="absolute rounded-sm"
                          style={{
                            left:            `${r.x * 100}%`,
                            top:             `${r.y * 100}%`,
                            width:           `${r.width * 100}%`,
                            height:          `${r.height * 100}%`,
                            backgroundColor: 'rgba(250, 204, 21, 0.4)',
                            border:          '1px solid rgba(250, 204, 21, 0.8)',
                            zIndex:          5,
                          }}
                        />
                      ))}
                    </div>
                  )}

                  {/* Field label picker — on the page where drawing happened */}
                  {pickerPos && pickerPos.page === pageNum && (
                    <FieldLabelPicker
                      x={pickerPos.x}
                      y={pickerPos.y}
                      docType={session.docType}
                      customFields={customFields}
                      onSelect={handleLabelSelect}
                      onCancel={() => setPickerPos(null)}
                    />
                  )}

                  {/* Page number badge */}
                  <div
                    className="absolute top-2 right-2 z-20 text-[10px] font-medium px-2 py-0.5 rounded-md
                               bg-black/50 text-white/80 backdrop-blur-sm select-none pointer-events-none
                               transition-all duration-300"
                  >
                    {isCover ? 'Cover' : startPg > 1 ? `P${contentP}` : `${pageNum}`}
                    <span className="text-white/40 ml-1">/ {totalPages}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </Document>

        {allHighlights.length > 0 && (
          <HighlightLegend highlights={allHighlights} />
        )}
      </div>
    </div>
  );
}
