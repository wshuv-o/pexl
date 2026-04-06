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
  extracting: boolean;
}

export default function PDFViewer({
  session,
  onHighlightsChange,
  onExtract,
  onReExtract,
  onApplyToAllPdfs,
  extracting,
}: PDFViewerProps) {
  const [currentPage, setCurrentPage]   = useState(session.startPage || 1);
  const [zoom, setZoom]                 = useState<number | null>(null); // null = not yet computed
  const [rotation, setRotation]         = useState(0);     // coarse: 0, 90, 180, 270
  const [fineRotation, setFineRotation] = useState(0);     // fine: -15 … +15 degrees
  const [tool, setTool]                 = useState<ViewerTool>('cursor');
  const [drawing, setDrawing]           = useState<{
    startX: number; startY: number;
    x: number; y: number; w: number; h: number;
  } | null>(null);
  const [pickerPos, setPickerPos]       = useState<{
    x: number; y: number;
    rect: { x: number; y: number; w: number; h: number };
  } | null>(null);
  const [showFirstHint, setShowFirstHint] = useState(true);
  const [numPages, setNumPages]         = useState<number | null>(null);
  const [fileUrl, setFileUrl]           = useState<string | null>(null);
  const [pdfPageWidth, setPdfPageWidth] = useState<number | null>(null);
  const [searchOpen, setSearchOpen]     = useState(false);
  const [searchQuery, setSearchQuery]   = useState('');
  const [searchResults, setSearchResults] = useState<{ x: number; y: number; width: number; height: number }[]>([]);

  const pageRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfDocRef = useRef<any>(null);

  const totalPages = numPages ?? session.total_pages;

  // Memoised so useCallback deps don't change on every render
  const pageHighlights = useMemo(
    () => session.highlights[currentPage] ?? [],
    [session.highlights, currentPage],
  );

  const allHighlights = useMemo(
    () => Object.values(session.highlights).flat(),
    [session.highlights],
  );

  // Guard: pages array may be empty during upload/processing
  const currentPageInfo = useMemo(
    () => Array.isArray(session.pages)
      ? session.pages.find(p => p.page_number === currentPage)
      : undefined,
    [session.pages, currentPage],
  );

  // Stable object URL from the File — revoked on unmount or file change
  useEffect(() => {
    if (!session.file) return;
    const url = URL.createObjectURL(session.file);
    setFileUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [session.file]);

  // Compute fit-width zoom once we know the PDF's intrinsic page width
  // and the scroll container width
  useEffect(() => {
    if (pdfPageWidth && scrollRef.current && zoom === null) {
      // Subtract padding (p-6 = 24px each side) + pr-12 (48px right) + pr-6 (24px scrollbar)
      const available = scrollRef.current.clientWidth - 24 - 48 - 24;
      const fitZoom = Math.max(0.3, Math.min(2.5, available / pdfPageWidth));
      setZoom(parseFloat(fitZoom.toFixed(2)));
    }
  }, [pdfPageWidth, zoom]);

  // Clear drawing + picker when page changes
  useEffect(() => {
    setDrawing(null);
    setPickerPos(null);
  }, [currentPage]);

  // Global mouseUp fallback — fires if user drags outside the page div
  // Without this, releasing the mouse outside leaves drawing stuck forever
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (drawing) setDrawing(null);
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
  // Mouse drawing handlers
  // -----------------------------------------------------------------------
  const getRelativePos = useCallback((clientX: number, clientY: number) => {
    if (!pageRef.current) return null;

    // Use the actual PDF canvas bounding rect, not the wrapper div.
    // react-pdf renders a <canvas> inside the wrapper �� if it has any
    // margin/padding the wrapper rect would cause an offset shift.
    const canvas = pageRef.current.querySelector('canvas');
    const target = canvas ?? pageRef.current;
    const rect   = target.getBoundingClientRect();

    // When fine rotation is applied via CSS transform, getBoundingClientRect()
    // returns the axis-aligned bounding box of the rotated element.
    // We need to inverse-rotate the click point around the element center
    // to get the correct position in the un-rotated element's local space.
    if (fineRotation !== 0) {
      const cx = rect.left + rect.width / 2;
      const cy = rect.top  + rect.height / 2;
      const dx = clientX - cx;
      const dy = clientY - cy;
      const rad = (-fineRotation * Math.PI) / 180;   // inverse rotation
      const cosA = Math.cos(rad);
      const sinA = Math.sin(rad);
      const localX = dx * cosA - dy * sinA;
      const localY = dx * sinA + dy * cosA;
      // The un-rotated element dimensions are the canvas's actual size
      const uw = target.clientWidth  || rect.width;
      const uh = target.clientHeight || rect.height;
      const x  = (localX + uw / 2) / uw;
      const y  = (localY + uh / 2) / uh;
      const px = localX + uw / 2;
      const py = localY + uh / 2;
      return { x, y, px, py };
    }

    return {
      x:  (clientX - rect.left) / rect.width,
      y:  (clientY - rect.top)  / rect.height,
      // Pixel offset relative to the canvas (for picker positioning)
      px: clientX - rect.left,
      py: clientY - rect.top,
    };
  }, [fineRotation]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (tool !== 'highlight') return;
    const pos = getRelativePos(e.clientX, e.clientY);
    if (!pos) return;
    e.preventDefault();
    setDrawing({ startX: pos.x, startY: pos.y, x: pos.x, y: pos.y, w: 0, h: 0 });
    setPickerPos(null);
  }, [tool, getRelativePos]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!drawing) return;
    const pos = getRelativePos(e.clientX, e.clientY);
    if (!pos) return;
    setDrawing({
      ...drawing,
      x: Math.min(drawing.startX, pos.x),
      y: Math.min(drawing.startY, pos.y),
      w: Math.abs(pos.x - drawing.startX),
      h: Math.abs(pos.y - drawing.startY),
    });
  }, [drawing, getRelativePos]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (!drawing) return;

    // Ignore tiny accidental clicks (< 1% of page in either dimension)
    if (drawing.w < 0.01 || drawing.h < 0.005) {
      setDrawing(null);
      return;
    }

    const pos = getRelativePos(e.clientX, e.clientY);
    const px  = pos?.px ?? e.clientX;
    const py  = pos?.py ?? e.clientY;

    // Clamp picker to stay inside the page div
    setPickerPos({
      x:    Math.min(px, (pageRef.current?.offsetWidth  ?? 600) - 160),
      y:    Math.min(py, (pageRef.current?.offsetHeight ?? 800) - 200),
      rect: { x: drawing.x, y: drawing.y, w: drawing.w, h: drawing.h },
    });
    setDrawing(null);
  }, [drawing, getRelativePos]);

  // -----------------------------------------------------------------------
  // Label selection
  // -----------------------------------------------------------------------
  const handleLabelSelect = useCallback(
    (field: FieldLabel, customLabel?: string) => {
      if (!pickerPos) return;
      const hl: Highlight = {
        id:     `hl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        page:   currentPage,
        // Use customLabel as field value when provided (Custom... option)
        field:  customLabel ?? field,
        x:      pickerPos.rect.x,
        y:      pickerPos.rect.y,
        width:  pickerPos.rect.w,
        height: pickerPos.rect.h,
      };
      updateHighlights(currentPage, [...pageHighlights, hl]);
      setPickerPos(null);
      setShowFirstHint(false);
    },
    [pickerPos, currentPage, pageHighlights, updateHighlights],
  );

  // -----------------------------------------------------------------------
  // Toolbar actions
  // -----------------------------------------------------------------------
  const handleDeleteHighlight = useCallback(
    (id: string) => updateHighlights(currentPage, pageHighlights.filter(h => h.id !== id)),
    [currentPage, pageHighlights, updateHighlights],
  );

  const handleEraseAll = useCallback(
    () => updateHighlights(currentPage, []),
    [currentPage, updateHighlights],
  );

  const handleToolChange = useCallback(
    (t: ViewerTool) => {
      if (t === 'eraser') {
        // Erase is a one-shot action — clear highlights then revert to cursor
        handleEraseAll();
        setTool('cursor');
      } else {
        setTool(t);
      }
      // Always close picker when switching tools
      setPickerPos(null);
    },
    [handleEraseAll],
  );

  // -----------------------------------------------------------------------
  // Bulk highlight actions
  // -----------------------------------------------------------------------
  // Clone current page's highlights to every page in this PDF
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

  // Clone current page's highlights to a specific page range
  const handleApplyToPageRange = useCallback((from: number, to: number) => {
    if (pageHighlights.length === 0) return;
    const next = { ...session.highlights };
    for (let p = from; p <= to; p++) {
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
  }, [pageHighlights, session, currentPage, onHighlightsChange]);

  // Erase highlights from ALL pages in this PDF
  const handleEraseAllPages = useCallback(() => {
    onHighlightsChange(session.id, {});
  }, [session.id, onHighlightsChange]);

  // Send the full highlights map to Index for cross-PDF mirroring (page-for-page)
  const handleApplyToAllPdfs = useCallback(() => {
    if (allHighlights.length === 0) return;
    onApplyToAllPdfs(session.highlights);
  }, [allHighlights, session.highlights, onApplyToAllPdfs]);

  // -----------------------------------------------------------------------
  // Text search
  // -----------------------------------------------------------------------
  const handleSearch = useCallback(async (query: string) => {
    setSearchQuery(query);
    if (!query.trim() || !pdfDocRef.current) {
      setSearchResults([]);
      return;
    }
    try {
      const page = await pdfDocRef.current.getPage(currentPage);
      const content = await page.getTextContent();
      const vp = page.getViewport({ scale: 1 });
      const items = content.items as { str: string; transform: number[]; width?: number; height?: number }[];
      const queryLower = query.toLowerCase();
      const hits: { x: number; y: number; width: number; height: number }[] = [];

      for (const item of items) {
        if (!item.str || !item.transform) continue;
        if (!item.str.toLowerCase().includes(queryLower)) continue;
        const x = item.transform[4];
        const itemTop = vp.height - item.transform[5];
        const itemH = item.height || Math.abs(item.transform[3]) || 12;
        const itemW = item.width || item.str.length * 6;
        hits.push({
          x: x / vp.width,
          y: itemTop / vp.height,
          width: itemW / vp.width,
          height: itemH / vp.height,
        });
      }
      setSearchResults(hits);
    } catch { setSearchResults([]); }
  }, [currentPage]);

  // Re-run search when page changes
  useEffect(() => {
    if (searchOpen && searchQuery) handleSearch(searchQuery);
    else setSearchResults([]);
  }, [currentPage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close picker / search on Escape, toggle search with Ctrl+F
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (searchOpen) { setSearchOpen(false); setSearchQuery(''); setSearchResults([]); }
        else setPickerPos(null);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setSearchOpen(o => !o);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [searchOpen]);

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

  return (
    <div className="flex flex-col h-full">
      <ViewerToolbar
        currentPage={currentPage}
        totalPages={totalPages}
        startPage={session.startPage || 1}
        zoom={zoom ?? 1}
        tool={tool}
        isOcr={currentPageInfo?.is_ocr ?? false}
        hasHighlightsOnPage={pageHighlights.length > 0}
        onPageChange={(p) => {
          setCurrentPage(Math.max(1, Math.min(p, totalPages)));
        }}
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
          if (searchOpen) { setSearchQuery(''); setSearchResults([]); }
        }}
        rotation={rotation}
        fineRotation={fineRotation}
        onRotate={(dir) => setRotation((rotation + (dir === 'cw' ? 90 : 270)) % 360)}
        onFineRotationChange={setFineRotation}
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
              if (e.key === 'Escape') { setSearchOpen(false); setSearchQuery(''); setSearchResults([]); }
            }}
          />
          {searchQuery && (
            <span className="text-[11px] text-muted-foreground shrink-0">
              {searchResults.length} match{searchResults.length !== 1 ? 'es' : ''}
            </span>
          )}
          <button
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            onClick={() => { setSearchOpen(false); setSearchQuery(''); setSearchResults([]); }}
          >
            <span className="text-xs">Esc</span>
          </button>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-auto bg-viewer relative custom-scrollbar pr-6">
        {/* First-use hint overlay */}
        {showFirstHint && tool === 'highlight' && allHighlights.length === 0 && (
          <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
            <div className="bg-black/70 text-white px-4 py-2 rounded-lg text-sm font-medium backdrop-blur-sm">
              Draw boxes over the values you want to extract
            </div>
          </div>
        )}

        <div className="flex justify-center p-6 pr-12">
          {/* pageRef shrink-wraps the canvas via inline-block so HighlightOverlay
              (absolute inset-0) aligns pixel-perfectly with the rendered PDF */}
          <div
            ref={pageRef}
            className="relative shadow-2xl select-none"
            style={{
              display:    'inline-block',
              lineHeight: 0,
              cursor:     tool === 'highlight' ? 'crosshair' : 'default',
              userSelect: tool === 'highlight' ? 'none' : 'auto',
              transform:  fineRotation !== 0 ? `rotate(${fineRotation}deg)` : undefined,
              transition: 'transform 0.15s ease',
            }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
          >
            <Document
              file={fileUrl}
              onLoadSuccess={async (pdf) => {
                setNumPages(pdf.numPages);
                pdfDocRef.current = pdf;
                // Read intrinsic width of page 1 to compute fit-width zoom
                if (!pdfPageWidth) {
                  try {
                    const page = await pdf.getPage(1);
                    const vp = page.getViewport({ scale: 1 });
                    setPdfPageWidth(vp.width);
                  } catch { /* ignore */ }
                }
              }}
              loading={
                <div className="w-[600px] h-[800px] bg-white/10 animate-pulse rounded" />
              }
              error={
                <div className="w-[600px] h-[400px] flex items-center justify-center text-red-400 text-sm bg-white rounded">
                  Failed to load PDF
                </div>
              }
            >
              <Page
                pageNumber={currentPage}
                scale={zoom ?? 1}
                rotate={rotation}
                renderTextLayer={false}
                renderAnnotationLayer={false}
              />
            </Document>

            <HighlightOverlay
              highlights={pageHighlights}
              drawing={drawing ? { x: drawing.x, y: drawing.y, w: drawing.w, h: drawing.h } : null}
              onDelete={handleDeleteHighlight}
              onReExtract={onReExtract}
              tool={tool}
            />

            {/* Search result highlights */}
            {searchResults.length > 0 && (
              <div className="absolute inset-0 pointer-events-none overflow-hidden">
                {searchResults.map((r, i) => (
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

            {pickerPos && (
              <FieldLabelPicker
                x={pickerPos.x}
                y={pickerPos.y}
                docType={session.docType}
                onSelect={handleLabelSelect}
                onCancel={() => setPickerPos(null)}
              />
            )}
          </div>
        </div>

        {allHighlights.length > 0 && (
          <HighlightLegend highlights={allHighlights} />
        )}
      </div>
    </div>
  );
}