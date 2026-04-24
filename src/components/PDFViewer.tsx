import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/TextLayer.css';
import type { PDFSession, Highlight, FieldLabel, ViewerTool } from '@/types/utilscraper';
import ViewerToolbar from './ViewerToolbar';
import HighlightOverlay from './HighlightOverlay';
import FieldLabelPicker from './FieldLabelPicker';
import HighlightLegend from './HighlightLegend';
import { downloadOcrPdf, searchBackend, type SearchMode } from '@/lib/api';
import { autoSearchFieldValues } from '@/lib/pdf-extract';
import { getFieldLabelsForType } from '@/types/utilscraper';
import { toast } from 'sonner';

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface PDFViewerProps {
  session: PDFSession;
  onHighlightsChange: (sessionId: string, highlights: Record<number, Highlight[]>) => void;
  onExtract: () => void;
  onReExtract: (highlightId: string) => void;
  onApplyToAllPdfs: (sourceHighlights: Record<number, Highlight[]>) => void;
  // Mirror the active PDF's highlights to just the tabs the user
  // ctrl/cmd-clicked. Undefined when no tabs are multi-selected.
  onApplyToSelectedPdfs?: (sourceHighlights: Record<number, Highlight[]>) => void;
  // Count of multi-selected tabs (shown on the toolbar button).
  selectedPdfCount?: number;
  onStartPageChange: (sessionId: string, startPage: number) => void;
  extracting: boolean;
  scrollToPageTrigger?: { page: number; nonce: number } | null;
  customFields: string[];
  onCustomFieldAdd: (name: string) => void;
  onSelectionChange?: (ids: Set<string>) => void;
  onSessionRenewed?: (oldId: string, newId: string) => void;
}

export default function PDFViewer({
  session,
  onHighlightsChange,
  onExtract,
  onReExtract,
  onApplyToAllPdfs,
  onApplyToSelectedPdfs,
  selectedPdfCount,
  onStartPageChange,
  extracting,
  scrollToPageTrigger,
  customFields,
  onCustomFieldAdd,
  onSelectionChange,
  onSessionRenewed,
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
    // Populated when the highlight was created from a browser text selection
    // (text-select tool). The picker still prompts for a field, but we
    // pre-fill the new highlight's extractedValue with this string so users
    // don't have to re-run extraction for native-text selections.
    selectedText?: string;
  } | null>(null);

  // Multi-select (click + shift/ctrl on boxes)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Report selection upward so the parent (Index) can use it for Ctrl+X cut etc.
  useEffect(() => {
    onSelectionChange?.(selectedIds);
  }, [selectedIds, onSelectionChange]);

  const [showFirstHint, setShowFirstHint] = useState(true);
  const [numPages, setNumPages]         = useState<number | null>(null);
  const [fileUrl, setFileUrl]           = useState<string | null>(null);
  const [pdfPageWidth, setPdfPageWidth] = useState<number | null>(null);
  const [searchOpen, setSearchOpen]     = useState(false);
  const [searchQuery, setSearchQuery]   = useState('');
  const [searchResults, setSearchResults] = useState<Record<number, { x: number; y: number; width: number; height: number }[]>>({});
  // -1 means "no match focused yet"; Enter in the search box advances this.
  const [activeMatchIdx, setActiveMatchIdx] = useState<number>(-1);
  const [pdfLoaded, setPdfLoaded]       = useState(false);
  const [downloadingOcr, setDownloadingOcr] = useState(false);
  const [autoSearching,  setAutoSearching]  = useState(false);

  const handleAutoSearch = useCallback(async () => {
    if (!session.file) { toast.error('PDF file not loaded'); return; }
    setAutoSearching(true);
    try {
      const labels = getFieldLabelsForType(session.docType)
        .filter(f => f.value !== 'custom')
        .map(f => ({ fieldKey: f.value as string, label: f.label }));

      const found = await autoSearchFieldValues(session.file, labels);
      let addedCount = 0;

      const merged: Record<number, Highlight[]> = { ...session.highlights };
      for (const [pageStr, pageHls] of Object.entries(found)) {
        const page = Number(pageStr);
        const existing = merged[page] ?? [];
        const existingFields = new Set(existing.map(h => h.field));
        const fresh = pageHls.filter(h => !existingFields.has(h.field));
        if (fresh.length === 0) continue;
        merged[page] = [...existing, ...fresh];
        addedCount += fresh.length;
      }

      if (addedCount === 0) {
        toast('No new fields found to auto-highlight.', { icon: 'ℹ️' });
      } else {
        onHighlightsChange(session.id, merged);
        toast.success(`Auto-highlighted ${addedCount} field${addedCount !== 1 ? 's' : ''}. Extracting…`);
        // Defer so React commits the highlights update before Extract reads
        // the session highlight list from its closure. Extract then behaves
        // identically to when the user clicks "Extract" after drawing boxes
        // manually — same backend extraction, same extracted-data panel.
        setTimeout(() => { onExtract(); }, 50);
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Auto-search failed');
    }
    setAutoSearching(false);
  }, [session.file, session.docType, session.id, session.highlights, onHighlightsChange, onExtract]);

  const handleDownloadOcr = useCallback(async () => {
    setDownloadingOcr(true);
    try {
      const { newSessionId } = await downloadOcrPdf(session.id, session.filename, session.file);
      if (newSessionId && newSessionId !== session.id) {
        onSessionRenewed?.(session.id, newSessionId);
      }
      toast.success('OCR\'d PDF downloaded');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Download failed';
      toast.error(msg);
    }
    setDownloadingOcr(false);
  }, [session.id, session.filename, session.file, onSessionRenewed]);

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

    // In text-select mode we let the browser handle native character-level
    // selection. The completed selection is picked up in a global mouseup
    // handler below and turned into a highlight with the field-label picker.
    if (tool === 'text-select') {
      setPickerPos(null);
      return;
    }

    if (tool === 'cursor' || tool === 'select') {
      e.preventDefault();
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey) setSelectedIds(new Set());
      setDrawingPage(pageNum);
      setDrawing({ startX: pos.x, startY: pos.y, x: pos.x, y: pos.y, w: 0, h: 0 });
      setPickerPos(null);
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
    }
  }, [drawing, drawingPage, getRelativePos]);

  const handleMouseUp = useCallback(async (e: React.MouseEvent) => {
    // Select mode: finish marquee — select all highlights whose center lies inside
    if (drawing && drawingPage !== null && tool === 'select') {
      const r = { x: drawing.x, y: drawing.y, w: drawing.w, h: drawing.h };
      if (r.w > 0.002 && r.h > 0.002) {
        const pageHls = session.highlights[drawingPage] ?? [];
        const hitIds = new Set<string>();
        for (const h of pageHls) {
          const cx = h.x + h.width  / 2;
          const cy = h.y + h.height / 2;
          if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) {
            hitIds.add(h.id);
          }
        }
        setSelectedIds(prev => {
          if (e.shiftKey || e.ctrlKey || e.metaKey) {
            const next = new Set(prev);
            hitIds.forEach(id => next.add(id));
            return next;
          }
          return hitIds;
        });
      }
      setDrawing(null); setDrawingPage(null);
      return;
    }

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

      const rect = { x: drawing.x, y: drawing.y, w: drawing.w, h: drawing.h };

      setPickerPos({
        x:    Math.min(px, (el.offsetWidth  ?? 600) - 160),
        y:    Math.min(py, (el.offsetHeight ?? 800) - 200),
        rect,
        page: drawingPage,
      });
      setDrawing(null);
      setDrawingPage(null);
    }
  }, [drawing, drawingPage, tool, session.highlights, getRelativePos]);

  // -----------------------------------------------------------------------
  // Text-select tool: when the browser finishes a character-level selection
  // (mouseup with an active Selection), compute the bounding box and open
  // the field-label picker with the selected text pre-filled. Works exactly
  // like dragging across text in Adobe Acrobat.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (tool !== 'text-select') return;

    const onMouseUp = () => {
      // Defer one tick so the selection is finalized before we read it.
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const selectedText = sel.toString().trim();
        if (!selectedText) return;

        const range = sel.getRangeAt(0);
        const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
        if (rects.length === 0) return;

        // For each rect, find which page it lives on (click-through to the
        // pageRef with the largest overlap).
        const byPage = new Map<number, DOMRect[]>();
        for (const rect of rects) {
          const cx = (rect.left + rect.right) / 2;
          const cy = (rect.top + rect.bottom) / 2;
          for (const [pageStr, el] of Object.entries(pageRefs.current)) {
            if (!el) continue;
            const pageRect = el.getBoundingClientRect();
            if (cx >= pageRect.left && cx <= pageRect.right
             && cy >= pageRect.top  && cy <= pageRect.bottom) {
              const page = Number(pageStr);
              if (!byPage.has(page)) byPage.set(page, []);
              byPage.get(page)!.push(rect);
              break;
            }
          }
        }
        if (byPage.size === 0) return;

        // If the selection spans multiple pages, take the first one the
        // selection started on (typical for a single drag).
        const firstPage = Math.min(...byPage.keys());
        const pageRects = byPage.get(firstPage)!;
        const pageEl = pageRefs.current[firstPage];
        if (!pageEl) return;
        const pageBB = pageEl.getBoundingClientRect();

        // Union of all rects on this page → the highlight's bounding box.
        const minX = Math.min(...pageRects.map(r => r.left))  - pageBB.left;
        const minY = Math.min(...pageRects.map(r => r.top))   - pageBB.top;
        const maxX = Math.max(...pageRects.map(r => r.right)) - pageBB.left;
        const maxY = Math.max(...pageRects.map(r => r.bottom))- pageBB.top;

        // Normalize to 0-1 so it matches every other highlight in the store.
        const rect = {
          x: minX / pageBB.width,
          y: minY / pageBB.height,
          w: (maxX - minX) / pageBB.width,
          h: (maxY - minY) / pageBB.height,
        };

        // Position the picker just below-right of the selection end, clamped
        // inside the page div so it doesn't overflow.
        const pickerX = Math.min(maxX, pageEl.offsetWidth  - 160);
        const pickerY = Math.min(maxY, pageEl.offsetHeight - 200);

        setPickerPos({ x: pickerX, y: pickerY, rect, page: firstPage, selectedText });

        // Clear the browser's visual selection so it doesn't stay behind
        // the highlight box.
        sel.removeAllRanges();
      }, 0);
    };

    document.addEventListener('mouseup', onMouseUp);
    return () => document.removeEventListener('mouseup', onMouseUp);
  }, [tool]);

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
        // If the box came from a native text selection, trust the browser's
        // text as the extracted value — saves a round-trip through extract.
        ...(pickerPos.selectedText
          ? { extractedValue: pickerPos.selectedText, confidence: 'high' as const, wasOcr: false }
          : {}),
      };
      const existing = session.highlights[pg] ?? [];
      updateHighlights(pg, [...existing, hl]);
      // Remember user-added custom field name so it appears in subsequent pickers
      // across every PDF in the session (state lives in the parent).
      if (customLabel && customLabel.trim()) {
        onCustomFieldAdd(customLabel.trim());
      }
      setPickerPos(null);
      setShowFirstHint(false);
    },
    [pickerPos, session.highlights, updateHighlights, onCustomFieldAdd],
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

  const handleResizeHighlight = useCallback(
    (id: string, pageNum: number, bounds: { x: number; y: number; width: number; height: number }) => {
      const hls = session.highlights[pageNum] ?? [];
      const updated = hls.map(h =>
        h.id === id
          ? {
              ...h,
              x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
              extractedValue: undefined, confidence: undefined, wasOcr: undefined,
            }
          : h,
      );
      updateHighlights(pageNum, updated);
      // Kick off a single-highlight re-extract via the existing flow.
      onReExtract(id);
    },
    [session.highlights, updateHighlights, onReExtract],
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

  const handleApplyToSelectedPdfs = useCallback(() => {
    if (allHighlights.length === 0 || !onApplyToSelectedPdfs) return;
    onApplyToSelectedPdfs(session.highlights);
  }, [allHighlights, session.highlights, onApplyToSelectedPdfs]);

  // Toolbar page nav → scroll to page
  const scrollToPage = useCallback((p: number) => {
    const clamped = Math.max(1, Math.min(p, totalPages));
    const el = pageRefs.current[clamped];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [totalPages]);

  // Flat, ordered list of every search hit (by page, then by occurrence)
  // so Enter/Shift+Enter in the search box can cycle through them linearly.
  const flatMatches = useMemo(() => {
    const out: { page: number; boxIndex: number; box: { x: number; y: number; width: number; height: number } }[] = [];
    const pages = Object.keys(searchResults).map(Number).sort((a, b) => a - b);
    for (const p of pages) {
      const hits = searchResults[p];
      for (let i = 0; i < hits.length; i++) out.push({ page: p, boxIndex: i, box: hits[i] });
    }
    return out;
  }, [searchResults]);

  useEffect(() => { setActiveMatchIdx(-1); }, [searchResults]);

  // Scroll so the i-th match is visible, ~1/3 of the way down the viewport.
  const gotoMatch = useCallback((idx: number) => {
    if (flatMatches.length === 0) return;
    const wrapped = ((idx % flatMatches.length) + flatMatches.length) % flatMatches.length;
    setActiveMatchIdx(wrapped);
    const target = flatMatches[wrapped];
    setCurrentPage(target.page);

    const pageEl = pageRefs.current[target.page];
    const container = scrollRef.current;
    if (!pageEl || !container) return;

    // pageEl.offsetTop is relative to its offsetParent — walk up until we
    // find one inside the scroll container for a correct absolute offset.
    let offsetTop = 0;
    let node: HTMLElement | null = pageEl;
    while (node && node !== container) {
      offsetTop += node.offsetTop;
      node = node.offsetParent as HTMLElement | null;
    }
    const matchY = target.box.y * pageEl.clientHeight;
    const targetScroll = offsetTop + matchY - container.clientHeight / 3;
    container.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
  }, [flatMatches]);

  useEffect(() => {
    if (!scrollToPageTrigger || !pdfLoaded) return;
    const { page } = scrollToPageTrigger;
    setCurrentPage(page);

    const jumpTo = (behavior: ScrollBehavior) => {
      const clamped = Math.max(1, Math.min(page, totalPages));
      const el = pageRefs.current[clamped];
      if (el) el.scrollIntoView({ behavior, block: 'start' });
    };

    jumpTo('smooth');

    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const delay of [250, 550, 1000, 1700]) {
      timers.push(setTimeout(() => { if (!cancelled) jumpTo('auto'); }, delay));
    }
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [scrollToPageTrigger, pdfLoaded, totalPages]);

  const handleSearch = useCallback(async (query: string) => {
    setSearchQuery(query);

    const normalize = (s: string) => s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')  // strip combining diacritics
      .replace(/\s+/g, ' ');             // collapse whitespace runs

    const q = normalize(query).trim();
    if (!q || !pdfDocRef.current) {
      setSearchResults({});
      return;
    }

    try {
      const modes: SearchMode[] = ['exact', 'partial', 'fuzzy'];
      for (const mode of modes) {
        const resp = await searchBackend(session.id, query, mode);
        if (!resp || resp.results.length === 0) continue;

        const byPage: Record<number, { x: number; y: number; width: number; height: number }[]> = {};
        for (const m of resp.results) {
          const dims = resp.page_sizes[String(m.page)] ?? resp.page_sizes[m.page as unknown as string];
          if (!dims || !dims.width || !dims.height) continue;
          const arr = byPage[m.page] ?? (byPage[m.page] = []);
          for (const [x1, y1, x2, y2] of m.boxes) {
            arr.push({
              x:      x1 / dims.width,
              y:      y1 / dims.height,
              width:  (x2 - x1) / dims.width,
              height: (y2 - y1) / dims.height,
            });
          }
        }
        if (Object.keys(byPage).length > 0) {
          setSearchResults(byPage);
          return;
        }
      }
    } catch { /* fall through to pdfjs */ }

    try {
      const allHits: Record<number, { x: number; y: number; width: number; height: number }[]> = {};
      for (let p = 1; p <= totalPages; p++) {
        const page = await pdfDocRef.current.getPage(p);
        const content = await page.getTextContent();
        const vp = page.getViewport({ scale: 1 });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const items = content.items as any[];

        type Slot = {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          item: any;
          itemW: number;     // original width in PDF units
          start: number;     // offset in pageText
          end: number;       // exclusive
          normLen: number;   // end - start, cached
        };
        const slots: Slot[] = [];
        let pageText = '';
        for (const item of items) {
          if (!item.str || !item.transform) continue;
          const nText = normalize(item.str);
          if (!nText) continue;

          if (pageText.length > 0 && !pageText.endsWith(' ')) pageText += ' ';

          const start = pageText.length;
          pageText += nText;
          const end = pageText.length;
          const itemW = item.width || item.str.length * 6;
          slots.push({ item, itemW, start, end, normLen: end - start });
        }

        const hits: { x: number; y: number; width: number; height: number }[] = [];
        let searchFrom = 0;
        while (searchFrom <= pageText.length) {
          const matchIdx = pageText.indexOf(q, searchFrom);
          if (matchIdx === -1) break;
          const matchEnd = matchIdx + q.length;

          for (const slot of slots) {
            const overlapStart = Math.max(slot.start, matchIdx);
            const overlapEnd   = Math.min(slot.end,   matchEnd);
            if (overlapStart >= overlapEnd) continue;

            const pStart = (overlapStart - slot.start) / slot.normLen;
            const pEnd   = (overlapEnd   - slot.start) / slot.normLen;

            const item   = slot.item;
            const itemX  = item.transform[4];
            const itemH  = item.height || Math.abs(item.transform[3]) || 12;
            const itemTop = vp.height - item.transform[5] - itemH;

            hits.push({
              x:      (itemX + pStart * slot.itemW) / vp.width,
              y:      itemTop / vp.height,
              width:  Math.max(1, (pEnd - pStart) * slot.itemW) / vp.width,
              height: itemH / vp.height,
            });
          }

          searchFrom = matchEnd; // non-overlapping, Chrome-Ctrl+F-style
        }

        if (hits.length > 0) allHits[p] = hits;
      }
      setSearchResults(allHits);
    } catch { setSearchResults({}); }
  }, [totalPages, session.id]);

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
      // Ctrl+S → activate the "select" tool (click/drag highlight boxes)
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && !isEditing) {
        e.preventDefault();          // block browser's "save page" dialog
        setTool('select');
      }
      // Ctrl+T → activate the "text-select" tool (copy text from PDF)
      if ((e.ctrlKey || e.metaKey) && e.key === 't' && !isEditing) {
        e.preventDefault();          // block browser's "new tab"
        setTool('text-select');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [searchOpen, selectedIds, session.highlights, session.id, onHighlightsChange, currentPage]);

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
        onApplyToSelectedPdfs={handleApplyToSelectedPdfs}
        selectedPdfCount={selectedPdfCount ?? 0}
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
        onDownloadOcr={handleDownloadOcr}
        downloadingOcr={downloadingOcr}
        onAutoSearch={handleAutoSearch}
        autoSearching={autoSearching}
      />

      {/* Search bar */}
      {searchOpen && (
        <div className="bg-card border-b border-border px-3 py-1.5 flex items-center gap-2 shrink-0">
          <input
            className="flex-1 h-7 text-xs bg-muted rounded px-2 border-none outline-none focus:ring-1 focus:ring-primary text-foreground"
            placeholder="Search (Enter: next · Shift+Enter: previous)"
            autoFocus
            value={searchQuery}
            onChange={e => handleSearch(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                setSearchOpen(false); setSearchQuery(''); setSearchResults({});
                return;
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                if (flatMatches.length === 0) return;
                if (e.shiftKey) gotoMatch(activeMatchIdx - 1);
                else            gotoMatch(activeMatchIdx + 1);
              }
            }}
          />
          {searchQuery && (
            <span className="text-[11px] text-muted-foreground shrink-0">
              {flatMatches.length === 0
                ? 'No matches'
                : activeMatchIdx >= 0
                  ? `${activeMatchIdx + 1} of ${flatMatches.length}`
                  : `${flatMatches.length} match${flatMatches.length !== 1 ? 'es' : ''}`}
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
        onMouseDown={e => {
          if (tool !== 'text-select') return;
          const t = e.target as HTMLElement | null;
          const isOnTextSpan = !!(t && t.tagName === 'SPAN' && t.closest('.textLayer'));
          if (!isOnTextSpan) window.getSelection()?.removeAllRanges();
        }}
      >
        {/* First-use hint overlay */}
        {showFirstHint && tool === 'cursor' && allHighlights.length === 0 && (
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
                  // Always `select-none` on the wrapper — selection is
                  // re-enabled inside .textLayer only (see index.css).
                  className="relative shadow-2xl select-none"
                  style={{
                    display:    'inline-block',
                    lineHeight: 0,
                    cursor:     tool === 'cursor' ? 'crosshair' : tool === 'text-select' ? 'text' : 'default',
                    transform:  fineRotation !== 0 ? `rotate(${fineRotation}deg)` : undefined,
                    transition: 'transform 0.3s ease',
                    opacity:    isCover ? 0.5 : 1,
                  }}
                  onMouseDown={e => handlePageMouseDown(e, pageNum)}
                >
                  <Page
                    pageNumber={pageNum}
                    scale={zoom ?? 1}
                    renderTextLayer={tool === 'text-select'}
                    renderAnnotationLayer={false}
                    loading={
                      <div className="w-[600px] h-[800px] bg-white/5 animate-pulse rounded" />
                    }
                  />

                  {/* Highlights for this page */}
                  <HighlightOverlay
                    highlights={pgHls}
                    drawing={drawingPage === pageNum && drawing && tool !== 'select'
                      ? { x: drawing.x, y: drawing.y, w: drawing.w, h: drawing.h }
                      : null}
                    selectionBox={drawingPage === pageNum && drawing && tool === 'select'
                      ? { x: drawing.x, y: drawing.y, w: drawing.w, h: drawing.h }
                      : null}
                    selectedIds={selectedIds}
                    onDelete={id => handleDeleteHighlight(id, pageNum)}
                    onReExtract={onReExtract}
                    onMove={(id, x, y) => handleMoveHighlight(id, pageNum, x, y)}
                    onResize={(id, bounds) => handleResizeHighlight(id, pageNum, bounds)}
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

                  {/* Search highlights (active match gets brighter orange). */}
                  {(searchResults[pageNum]?.length ?? 0) > 0 && (
                    <div className="absolute inset-0 pointer-events-none overflow-hidden">
                      {(searchResults[pageNum] ?? []).map((r, i) => {
                        const isActive =
                          activeMatchIdx >= 0 &&
                          flatMatches[activeMatchIdx]?.page === pageNum &&
                          flatMatches[activeMatchIdx]?.boxIndex === i;
                        return (
                          <div
                            key={i}
                            className="absolute rounded-sm"
                            style={{
                              left:            `${r.x * 100}%`,
                              top:             `${r.y * 100}%`,
                              width:           `${r.width * 100}%`,
                              height:          `${r.height * 100}%`,
                              backgroundColor: isActive ? 'rgba(251, 146, 60, 0.65)' : 'rgba(250, 204, 21, 0.4)',
                              border:          isActive ? '1.5px solid rgba(234, 88, 12, 0.95)' : '1px solid rgba(250, 204, 21, 0.8)',
                              zIndex:          isActive ? 6 : 5,
                            }}
                          />
                        );
                      })}
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
