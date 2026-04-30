/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/TextLayer.css';
import { Check, X, Pencil, Layers, ZoomIn, ZoomOut, Search, RotateCw, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getFieldConfig } from '@/types/utilscraper';
import type { MappingState } from './MappingReview';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export interface ResizedBox { page: number; x: number; y: number; width: number; height: number }

interface Props {
  file: File;
  mappings: MappingState[];
  activeHeader: string | null;
  onConfirmHeader: (header: string, value?: string) => void;
  onRejectHeader:  (header: string) => void;
  onEditHeader:    (header: string, value: string) => void;
  onApplyToPageAll:    (page: number, status: 'confirmed' | 'rejected') => void;
  // Word/Paint-style resize: user released a corner/edge handle after
  // dragging — parent should call extract-regions with the new box and
  // update the mapping's value.
  onResizeBox?: (excelHeader: string, newBox: ResizedBox) => void;
}

// 8 resize-handle edges for a highlight rectangle.
type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const EDGE_CURSOR: Record<Edge, string> = {
  n:  'ns-resize',
  s:  'ns-resize',
  e:  'ew-resize',
  w:  'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

export default function AutoHighlightViewer({
  file, mappings, activeHeader,
  onConfirmHeader, onRejectHeader, onEditHeader, onApplyToPageAll,
  onResizeBox,
}: Props) {
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [scale, setScale] = useState<number | null>(null);     // null = fit-width pending
  const [pdfPageWidth, setPdfPageWidth] = useState<number | null>(null);
  const [pdfLoaded, setPdfLoaded] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [editingHeader, setEditingHeader] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs  = useRef<Record<number, HTMLDivElement | null>>({});
  const pdfDocRef = useRef<any>(null);
  // Bumped by each Page's onRenderTextLayerSuccess callback. Triggers the
  // effect below that colours the matched glyphs green.
  const [textLayerTick, setTextLayerTick] = useState(0);

  // In-PDF text search (Ctrl+F).
  const [searchOpen, setSearchOpen]       = useState(false);
  const [searchQuery, setSearchQuery]     = useState('');
  const [searchHits, setSearchHits]       = useState<Record<number, { x: number; y: number; width: number; height: number }[]>>({});
  const [activeHitIdx, setActiveHitIdx]   = useState(-1);
  // Fine rotation — matches the main viewer's feature for nudging pages.
  const [rotation, setRotation]           = useState(0);  // degrees

  // Word/Paint-style resize state. While the user drags a handle we keep
  // the preview box in local state; on mouseup we commit via onResizeBox
  // so the parent can re-extract and update the mapping.
  const [resize, setResize] = useState<{
    excelHeader: string;
    page: number;
    edge: Edge;
    box: { x: number; y: number; width: number; height: number };     // current (fractions)
    startBox: { x: number; y: number; width: number; height: number }; // before drag
    startMouse: { x: number; y: number };                              // page-local fractions
  } | null>(null);
  // Ref-mirror of `resize` so the mousemove/mouseup listeners — which are
  // bound ONCE per drag (not re-bound on every setResize) — can read the
  // latest state without stale-closure bugs.
  const resizeRef = useRef(resize);
  useEffect(() => { resizeRef.current = resize; }, [resize]);

  // Compute fit-width zoom on first page load so 66-column landscape PDFs
  // aren't tiny or overflowing.
  useEffect(() => {
    if (pdfPageWidth && scrollRef.current && scale === null) {
      const available = scrollRef.current.clientWidth - 48;   // viewer padding
      const fitZoom = Math.max(0.3, Math.min(1.75, available / pdfPageWidth));
      setScale(parseFloat(fitZoom.toFixed(2)));
    }
  }, [pdfPageWidth, scale]);
  const effectiveScale = scale ?? 1;

  // Object URL for the uploaded file.
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setFileUrl(url);
    setPdfLoaded(false);
    setNumPages(0);
    setCurrentPage(1);
    setScale(null);               // recompute fit-width for the new file
    setPdfPageWidth(null);
    setSearchOpen(false);
    setSearchQuery('');
    setSearchHits({});
    setActiveHitIdx(-1);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Scroll to the active header's matched page. Retry a few times while
  // react-pdf canvases settle — otherwise we land at the stale Y for
  // later pages (exactly the same bug the main viewer has, same fix).
  useEffect(() => {
    if (!activeHeader || !pdfLoaded) return;
    const m = mappings.find(x => x.mapping.excelHeader === activeHeader);
    const box = m?.chosenBox ?? m?.match.box;
    if (!box) return;
    const target = Math.max(1, Math.min(box.page, numPages));
    setCurrentPage(target);

    const jump = (behavior: ScrollBehavior) => {
      const el = pageRefs.current[target];
      if (el) el.scrollIntoView({ behavior, block: 'start' });
    };
    jump('smooth');
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const d of [250, 550, 1000, 1700]) {
      timers.push(setTimeout(() => { if (!cancelled) jump('auto'); }, d));
    }
    return () => { cancelled = true; timers.forEach(clearTimeout); };
  }, [activeHeader, pdfLoaded, numPages, mappings]);

  // ── Colour the actual PDF glyphs that fall inside a match box ──────────
  // Fallback for when the rectangle overlay isn't visually convincing: we
  // enable react-pdf's text layer and tag every <span> that sits inside a
  // match's bbox with `am-hit` (green + bold via global CSS). Re-runs on
  // mapping change, re-render, or when a page's text layer finishes loading.
  useEffect(() => {
    if (!pdfLoaded) return;
    let cancelled = false;
    const annotate = () => {
      if (cancelled) return;
      for (const [pageStr, pageEl] of Object.entries(pageRefs.current)) {
        if (!pageEl) continue;
        const pageNum = Number(pageStr);
        const layer = pageEl.querySelector<HTMLDivElement>('.textLayer');
        if (!layer) continue;
        const pageMappings = mappings.filter(m => {
          const b = m.chosenBox ?? m.match.box;
          return b && b.page === pageNum && m.status !== 'rejected';
        });
        const pw = pageEl.clientWidth || 1;
        const ph = pageEl.clientHeight || 1;
        const spans = layer.querySelectorAll<HTMLElement>('span');
        spans.forEach(span => {
          span.classList.remove('am-hit', 'am-hit-active');
          const sl = span.offsetLeft;
          const st = span.offsetTop;
          const sw = span.offsetWidth;
          const sh = span.offsetHeight;
          if (!sw || !sh) return;
          const sx = sl / pw, sy = st / ph;
          const sx2 = (sl + sw) / pw, sy2 = (st + sh) / ph;
          for (const m of pageMappings) {
            const b = (m.chosenBox ?? m.match.box)!;
            // AABB overlap (any pixel inside the box counts)
            if (sx2 > b.x && sx < b.x + b.width && sy2 > b.y && sy < b.y + b.height) {
              span.classList.add('am-hit');
              if (m.mapping.excelHeader === activeHeader) span.classList.add('am-hit-active');
              break;
            }
          }
        });
      }
    };
    annotate();
    // Text layer spans may still be streaming in — re-try a couple of times.
    const timers = [120, 420, 900].map(d => setTimeout(annotate, d));
    return () => { cancelled = true; timers.forEach(clearTimeout); };
  }, [mappings, pdfLoaded, numPages, scale, textLayerTick, activeHeader]);

  // ── Resize drag tracking ──────────────────────────────────────────────
  // Listeners bind ONCE per drag (when `resize` goes null → non-null) and
  // read live state through `resizeRef` so we don't tear down + re-bind on
  // every mousemove (which was eating events on some browsers).
  const dragActive = resize !== null;
  useEffect(() => {
    if (!dragActive) return;

    const onMove = (e: MouseEvent) => {
      const curr = resizeRef.current;
      if (!curr) return;
      const pageEl = pageRefs.current[curr.page];
      if (!pageEl) return;
      const rect = pageEl.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width;
      const my = (e.clientY - rect.top)  / rect.height;

      setResize(prev => {
        if (!prev) return prev;
        const s = prev.startBox;
        let { x, y, width, height } = s;

        if (prev.edge.includes('w')) {
          const newX = Math.max(0, Math.min(mx, s.x + s.width - 0.002));
          width = s.x + s.width - newX;
          x = newX;
        }
        if (prev.edge.includes('e')) {
          width = Math.max(0.002, Math.min(1 - s.x, mx - s.x));
        }
        if (prev.edge.includes('n')) {
          const newY = Math.max(0, Math.min(my, s.y + s.height - 0.002));
          height = s.y + s.height - newY;
          y = newY;
        }
        if (prev.edge.includes('s')) {
          height = Math.max(0.002, Math.min(1 - s.y, my - s.y));
        }
        return { ...prev, box: { x, y, width, height } };
      });
    };

    const onUp = () => {
      const curr = resizeRef.current;
      setResize(null);                // end the drag
      if (!curr) return;
      const s = curr.startBox;
      const b = curr.box;
      const moved =
        Math.abs(s.x - b.x) > 0.001 ||
        Math.abs(s.y - b.y) > 0.001 ||
        Math.abs(s.width  - b.width)  > 0.001 ||
        Math.abs(s.height - b.height) > 0.001;
      if (moved && onResizeBox) {
        onResizeBox(curr.excelHeader, { page: curr.page, ...b });
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragActive, onResizeBox]);

  // Helper to start a resize drag from a handle's mousedown.
  const beginResize = useCallback((
    e: React.MouseEvent,
    excelHeader: string,
    page: number,
    edge: Edge,
    box: { x: number; y: number; width: number; height: number },
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const pageEl = pageRefs.current[page];
    if (!pageEl) return;
    const rect = pageEl.getBoundingClientRect();
    setResize({
      excelHeader,
      page,
      edge,
      box: { ...box },
      startBox: { ...box },
      startMouse: {
        x: (e.clientX - rect.left) / rect.width,
        y: (e.clientY - rect.top)  / rect.height,
      },
    });
  }, []);

  // Track the currently visible page so the per-page Confirm/Reject bulk
  // buttons target whichever page the user is looking at.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !pdfLoaded) return;
    const onScroll = () => {
      const cTop = container.scrollTop;
      const cMid = cTop + container.clientHeight * 0.3;
      let best = 1;
      let bestDist = Infinity;
      for (const [p, el] of Object.entries(pageRefs.current)) {
        if (!el) continue;
        const top = el.offsetTop;
        const dist = Math.abs(top - cMid);
        if (dist < bestDist) { bestDist = dist; best = Number(p); }
      }
      setCurrentPage(best);
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [pdfLoaded, numPages]);

  const mappingsOnPage = mappings.filter(m => {
    const b = m.chosenBox ?? m.match.box;
    return b && b.page === currentPage;
  });

  // ── In-PDF search ─────────────────────────────────────────────────────
  // Same accuracy-upgraded matcher the main viewer uses: Unicode normalise
  // + whitespace collapse + concatenated page text so matches that straddle
  // pdfjs item boundaries are still found; proportional hit boxes; text
  // baseline → top correction. Lets the user copy the exact phrase.
  const handleSearch = useCallback(async (q: string) => {
    setSearchQuery(q);
    const normalize = (s: string) => s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ');
    const needle = normalize(q).trim();
    if (!needle || !pdfDocRef.current) { setSearchHits({}); return; }
    try {
      const results: Record<number, { x: number; y: number; width: number; height: number }[]> = {};
      for (let p = 1; p <= numPages; p++) {
        const page = await pdfDocRef.current.getPage(p);
        const content = await page.getTextContent();
        const vp = page.getViewport({ scale: 1 });
        const items = content.items as any[];
        type Slot = { item: any; itemW: number; start: number; end: number; normLen: number };
        const slots: Slot[] = [];
        let pageText = '';
        for (const it of items) {
          if (!it.str || !it.transform) continue;
          const nT = normalize(it.str);
          if (!nT) continue;
          if (pageText.length > 0 && !pageText.endsWith(' ')) pageText += ' ';
          const start = pageText.length;
          pageText += nT;
          slots.push({
            item: it,
            itemW: it.width || it.str.length * 6,
            start, end: pageText.length, normLen: pageText.length - start,
          });
        }
        const hits: { x: number; y: number; width: number; height: number }[] = [];
        let from = 0;
        while (from <= pageText.length) {
          const idx = pageText.indexOf(needle, from);
          if (idx === -1) break;
          const end = idx + needle.length;
          for (const slot of slots) {
            const a = Math.max(slot.start, idx);
            const b = Math.min(slot.end,   end);
            if (a >= b) continue;
            const pS = (a - slot.start) / slot.normLen;
            const pE = (b - slot.start) / slot.normLen;
            const item = slot.item;
            const itemX = item.transform[4];
            const itemH = item.height || Math.abs(item.transform[3]) || 12;
            const itemTop = vp.height - item.transform[5] - itemH;
            hits.push({
              x:     (itemX + pS * slot.itemW) / vp.width,
              y:     itemTop / vp.height,
              width: Math.max(1, (pE - pS) * slot.itemW) / vp.width,
              height: itemH / vp.height,
            });
          }
          from = end;
        }
        if (hits.length > 0) results[p] = hits;
      }
      setSearchHits(results);
      setActiveHitIdx(-1);
    } catch { setSearchHits({}); }
  }, [numPages]);

  // Flatten hits so Enter/Shift+Enter cycle through in document order.
  const flatHits = useMemo(() => {
    const out: { page: number; boxIdx: number; box: { x: number; y: number; width: number; height: number } }[] = [];
    for (const p of Object.keys(searchHits).map(Number).sort((a, b) => a - b)) {
      searchHits[p].forEach((box, i) => out.push({ page: p, boxIdx: i, box }));
    }
    return out;
  }, [searchHits]);

  const gotoHit = useCallback((idx: number) => {
    if (flatHits.length === 0) return;
    const wrapped = ((idx % flatHits.length) + flatHits.length) % flatHits.length;
    setActiveHitIdx(wrapped);
    const target = flatHits[wrapped];
    setCurrentPage(target.page);
    const pageEl = pageRefs.current[target.page];
    const container = scrollRef.current;
    if (!pageEl || !container) return;
    let offsetTop = 0;
    let n: HTMLElement | null = pageEl;
    while (n && n !== container) { offsetTop += n.offsetTop; n = n.offsetParent as HTMLElement | null; }
    const targetY = offsetTop + target.box.y * pageEl.clientHeight - container.clientHeight / 3;
    container.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
  }, [flatHits]);

  useEffect(() => { setActiveHitIdx(-1); }, [searchHits]);

  // Keyboard shortcuts: Ctrl+F open search, PageUp/Down/Home/End navigate.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const editing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault(); setSearchOpen(o => !o);
        return;
      }
      if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false); setSearchQuery(''); setSearchHits({});
        return;
      }
      if (editing) return;
      const scrollBy = (px: number) => scrollRef.current?.scrollBy({ top: px, behavior: 'smooth' });
      if (e.key === 'PageDown') { e.preventDefault(); scrollBy((scrollRef.current?.clientHeight ?? 600) * 0.9); }
      if (e.key === 'PageUp')   { e.preventDefault(); scrollBy(-(scrollRef.current?.clientHeight ?? 600) * 0.9); }
      if (e.key === 'Home')     { e.preventDefault(); scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); }
      if (e.key === 'End')      { e.preventDefault(); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searchOpen]);

  const activeMapping = activeHeader
    ? mappings.find(x => x.mapping.excelHeader === activeHeader) ?? null
    : null;

  return (
    <div className="flex flex-col h-full bg-viewer">
      {/* Toolbar */}
      <div className="bg-card border-b border-border px-3 py-1.5 flex items-center gap-2 shrink-0">
        <span className="text-xs text-foreground/70 min-w-[80px]">
          Page {currentPage} / {numPages || '…'}
        </span>
        <Button size="sm" variant="ghost" onClick={() => setScale(s => Math.max(0.4, (s ?? 1) - 0.1))}>
          <ZoomOut className="w-4 h-4" />
        </Button>
        <span className="text-xs text-foreground/70 w-10 text-center">{Math.round(effectiveScale * 100)}%</span>
        <Button size="sm" variant="ghost" onClick={() => setScale(s => Math.min(2.5, (s ?? 1) + 0.1))}>
          <ZoomIn className="w-4 h-4" />
        </Button>
        <div className="w-px h-5 bg-border mx-1" />
        <Button size="sm" variant="ghost" title="Rotate -90°" onClick={() => setRotation(r => (r - 90 + 360) % 360)}>
          <RotateCcw className="w-4 h-4" />
        </Button>
        <Button size="sm" variant="ghost" title="Rotate +90°" onClick={() => setRotation(r => (r + 90) % 360)}>
          <RotateCw className="w-4 h-4" />
        </Button>
        <Button
          size="sm"
          variant={searchOpen ? 'default' : 'ghost'}
          onClick={() => setSearchOpen(o => !o)}
          title="Find in document (Ctrl+F)"
        >
          <Search className="w-4 h-4" />
        </Button>

        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground mr-1">
            {mappingsOnPage.length} mapping{mappingsOnPage.length !== 1 ? 's' : ''} on this page
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            disabled={mappingsOnPage.length === 0}
            onClick={() => onApplyToPageAll(currentPage, 'confirmed')}
          >
            <Layers className="w-3.5 h-3.5" /> Confirm all on page
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            disabled={mappingsOnPage.length === 0}
            onClick={() => onApplyToPageAll(currentPage, 'rejected')}
          >
            <X className="w-3.5 h-3.5" /> Reject all on page
          </Button>
        </div>
      </div>

      {/* Search bar — Ctrl+F */}
      {searchOpen && (
        <div className="bg-card border-b border-border px-3 py-1.5 flex items-center gap-2 shrink-0">
          <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <input
            className="flex-1 h-7 text-xs bg-muted rounded px-2 border-none outline-none focus:ring-1 focus:ring-primary text-foreground"
            placeholder="Find in document (Enter: next · Shift+Enter: previous)"
            autoFocus
            value={searchQuery}
            onChange={e => handleSearch(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                setSearchOpen(false); setSearchQuery(''); setSearchHits({});
                return;
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                if (flatHits.length === 0) return;
                gotoHit(e.shiftKey ? activeHitIdx - 1 : activeHitIdx + 1);
              }
            }}
          />
          {searchQuery && (
            <span className="text-[11px] text-muted-foreground shrink-0">
              {flatHits.length === 0
                ? 'No matches'
                : activeHitIdx >= 0
                  ? `${activeHitIdx + 1} of ${flatHits.length}`
                  : `${flatHits.length} match${flatHits.length !== 1 ? 'es' : ''}`}
            </span>
          )}
          <button
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
            onClick={() => { setSearchOpen(false); setSearchQuery(''); setSearchHits({}); }}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Scrollable container — every page rendered, stacked vertically. */}
      <div ref={scrollRef} className="flex-1 overflow-auto custom-scrollbar p-6 bg-viewer">
        {fileUrl && (
          <Document
            file={fileUrl}
            onLoadSuccess={async (pdf: any) => {
              pdfDocRef.current = pdf;
              setNumPages(pdf.numPages);
              setPdfLoaded(true);
              if (!pdfPageWidth) {
                try {
                  const p = await pdf.getPage(1);
                  const vp = p.getViewport({ scale: 1 });
                  setPdfPageWidth(vp.width);
                } catch { /* ignore */ }
              }
            }}
          >
            <div className="flex flex-col items-center gap-6">
              {Array.from({ length: numPages }, (_, i) => i + 1).map(pageNum => {
                const pageMappings = mappings.filter(m => {
                  const b = m.chosenBox ?? m.match.box;
                  return b && b.page === pageNum;
                });
                return (
                  <div
                    key={pageNum}
                    ref={el => { pageRefs.current[pageNum] = el; }}
                    className="relative shadow-2xl select-none"
                    style={{
                      display: 'inline-block',
                      lineHeight: 0,
                      transform: rotation !== 0 ? `rotate(${rotation}deg)` : undefined,
                      transition: 'transform 0.2s ease',
                    }}
                  >
                    <Page
                      pageNumber={pageNum}
                      scale={effectiveScale}
                      renderTextLayer={true}
                      renderAnnotationLayer={false}
                      onRenderTextLayerSuccess={() => setTextLayerTick(t => t + 1)}
                      loading={<div className="w-[600px] h-[800px] bg-white/5 animate-pulse rounded" />}
                    />
                    {pageMappings.map(m => {
                      const original = (m.chosenBox ?? m.match.box)!;
                      const isActive = m.mapping.excelHeader === activeHeader;
                      // While the user drags a handle, prefer the live
                      // preview box so the rectangle follows the mouse.
                      const isResizing = resize?.excelHeader === m.mapping.excelHeader;
                      const b = isResizing && resize
                        ? { ...original, ...resize.box }
                        : original;
                      const value = m.override ?? original.value;

                      // Match the main viewer's highlight style: field-
                      // specific color from FIELD_LABELS when the mapping
                      // has a canonical field; else fall back to status
                      // colors (red for rejected, neutral green otherwise).
                      const cfg = m.mapping.fieldKey ? getFieldConfig(m.mapping.fieldKey) : null;
                      const rect = m.status === 'rejected'
                        ? { bg: 'rgba(239,68,68,0.18)', border: 'rgba(185,28,28,0.85)' }
                        : cfg
                          ? { bg: cfg.bgColor, border: cfg.color }
                          : { bg: 'rgba(34,197,94,0.22)', border: 'rgba(22,163,74,0.9)' };
                      const pillFg = m.status === 'rejected' ? '#991b1b' : '#14532d';
                      const pillBg = m.status === 'rejected' ? '#fee2e2' : '#dcfce7';

                      return (
                        <div key={m.mapping.excelHeader}>
                          {/* Solid field-colored rectangle — same style the
                              main PDF viewer uses in HighlightOverlay. No
                              transition on size so resize drags track the
                              mouse without CSS lag. */}
                          <div
                            className="absolute pointer-events-none rounded-sm"
                            style={{
                              left:   `${b.x * 100}%`,
                              top:    `${b.y * 100}%`,
                              width:  `${b.width * 100}%`,
                              height: `${b.height * 100}%`,
                              background: rect.bg,
                              border:     `${isActive ? 2.5 : 2}px solid ${rect.border}`,
                              borderRadius: 3,
                              boxShadow:  isActive ? `0 0 0 2px ${rect.border}40, 0 4px 12px rgba(0,0,0,0.15)` : undefined,
                              zIndex:     isActive ? 6 : 4,
                            }}
                          />
                          {/* Status / confidence dot in the top-right corner,
                              matching the main viewer's confidence indicator. */}
                          <div
                            className="absolute pointer-events-none rounded-full"
                            style={{
                              left:   `calc(${b.x * 100}% + ${b.width * 100}% - 6px)`,
                              top:    `calc(${b.y * 100}% - 4px)`,
                              width:  8,
                              height: 8,
                              background:
                                m.status === 'confirmed' ? '#22c55e'
                                : m.status === 'rejected'  ? '#ef4444'
                                : '#f59e0b',
                              boxShadow: '0 0 0 1px white',
                              zIndex: 9,
                            }}
                          />
                          {/* Resize — full-edge strips + corner squares.
                              Hovering anywhere on an edge gives the two-
                              sided resize arrow; corners allow diagonal
                              resize. zIndex 50 + explicit pointer-events
                              beat the text layer's span-based selection. */}
                          {isActive && onResizeBox && (() => {
                            const cornerSize = 12;                           // px
                            const edgeThick  = 10;                           // px — hit-strip thickness
                            const commonStyle: React.CSSProperties = {
                              zIndex: 50,
                              pointerEvents: 'auto',
                              userSelect: 'none',
                              touchAction: 'none',
                            };
                            const onDown = (edge: Edge) => (ev: React.MouseEvent) => {
                              ev.stopPropagation();
                              beginResize(ev, m.mapping.excelHeader, pageNum, edge, original);
                            };

                            // Full-edge interactive strips. Thin, semi-
                            // transparent overlay centred on each edge —
                            // invisible on the box itself but catches the
                            // hover/drag anywhere along the edge.
                            const edgeStrips: Array<{ edge: Edge; style: React.CSSProperties }> = [
                              // Top edge
                              { edge: 'n', style: {
                                left:   `${b.x * 100}%`,
                                width:  `${b.width * 100}%`,
                                top:    `calc(${b.y * 100}% - ${edgeThick / 2}px)`,
                                height: edgeThick,
                              } },
                              // Bottom edge
                              { edge: 's', style: {
                                left:   `${b.x * 100}%`,
                                width:  `${b.width * 100}%`,
                                top:    `calc(${(b.y + b.height) * 100}% - ${edgeThick / 2}px)`,
                                height: edgeThick,
                              } },
                              // Left edge
                              { edge: 'w', style: {
                                top:    `${b.y * 100}%`,
                                height: `${b.height * 100}%`,
                                left:   `calc(${b.x * 100}% - ${edgeThick / 2}px)`,
                                width:  edgeThick,
                              } },
                              // Right edge
                              { edge: 'e', style: {
                                top:    `${b.y * 100}%`,
                                height: `${b.height * 100}%`,
                                left:   `calc(${(b.x + b.width) * 100}% - ${edgeThick / 2}px)`,
                                width:  edgeThick,
                              } },
                            ];

                            // Corner squares — small visible grabs for
                            // diagonal resize.
                            const corners: Array<{ edge: Edge; left: string; top: string }> = [
                              { edge: 'nw', left: `${b.x * 100}%`,             top: `${b.y * 100}%` },
                              { edge: 'ne', left: `${(b.x + b.width) * 100}%`, top: `${b.y * 100}%` },
                              { edge: 'se', left: `${(b.x + b.width) * 100}%`, top: `${(b.y + b.height) * 100}%` },
                              { edge: 'sw', left: `${b.x * 100}%`,             top: `${(b.y + b.height) * 100}%` },
                            ];

                            return (
                              <>
                                {/* Edge hit-strips — invisible to the eye
                                    but carry the two-sided arrow cursor
                                    along the entire length of the edge. */}
                                {edgeStrips.map(s => (
                                  <div
                                    key={s.edge}
                                    className="absolute"
                                    style={{
                                      ...s.style,
                                      cursor: EDGE_CURSOR[s.edge],
                                      ...commonStyle,
                                      // Debug-able: switch to a faint tint
                                      // by changing background below.
                                      background: 'transparent',
                                    }}
                                    onMouseDown={onDown(s.edge)}
                                  />
                                ))}
                                {/* Corner squares — small, visible, white
                                    with field-coloured border. Diagonal
                                    resize on click+drag. */}
                                {corners.map(c => (
                                  <div
                                    key={c.edge}
                                    className="absolute rounded-sm bg-white shadow-md hover:scale-125 transition-transform"
                                    style={{
                                      left: c.left,
                                      top:  c.top,
                                      width:  cornerSize,
                                      height: cornerSize,
                                      transform: 'translate(-50%, -50%)',
                                      border: `2px solid ${rect.border}`,
                                      cursor: EDGE_CURSOR[c.edge],
                                      ...commonStyle,
                                    }}
                                    onMouseDown={onDown(c.edge)}
                                  />
                                ))}
                              </>
                            );
                          })()}

                          {/* Value pill above the box — label + extracted text. */}
                          <div
                            className="absolute text-[11px] font-semibold px-2 py-0.5 rounded-md shadow whitespace-nowrap pointer-events-none"
                            style={{
                              left:  `${b.x * 100}%`,
                              top:   `calc(${b.y * 100}% - 22px)`,
                              background: pillBg,
                              color:      pillFg,
                              border:     `1px solid ${rect.border}`,
                              zIndex: 8,
                              maxWidth: '60%',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                            title={`${m.mapping.excelHeader}${m.mapping.fieldLabel ? ' · ' + m.mapping.fieldLabel : ''}: ${value}`}
                          >
                            {value || m.mapping.excelHeader}
                          </div>
                        </div>
                      );
                    })}
                    {/* Search hits */}
                    {(searchHits[pageNum]?.length ?? 0) > 0 && (
                      <div className="absolute inset-0 pointer-events-none overflow-hidden">
                        {(searchHits[pageNum] ?? []).map((h, i) => {
                          const isHitActive =
                            activeHitIdx >= 0 &&
                            flatHits[activeHitIdx]?.page === pageNum &&
                            flatHits[activeHitIdx]?.boxIdx === i;
                          return (
                            <div
                              key={i}
                              className="absolute rounded-sm"
                              style={{
                                left:   `${h.x * 100}%`,
                                top:    `${h.y * 100}%`,
                                width:  `${h.width * 100}%`,
                                height: `${h.height * 100}%`,
                                background: isHitActive ? 'rgba(251,146,60,0.65)' : 'rgba(250,204,21,0.4)',
                                border: isHitActive
                                  ? '1.5px solid rgba(234,88,12,0.95)'
                                  : '1px solid rgba(250,204,21,0.8)',
                                zIndex: isHitActive ? 9 : 8,
                              }}
                            />
                          );
                        })}
                      </div>
                    )}

                    {/* Page number badge */}
                    <div className="absolute top-2 right-2 z-20 text-[10px] font-medium px-2 py-0.5 rounded-md bg-black/50 text-white/80 backdrop-blur-sm pointer-events-none">
                      {pageNum} / {numPages}
                    </div>
                  </div>
                );
              })}
            </div>
          </Document>
        )}
      </div>

      {/* Per-header confirm bar */}
      {activeMapping && (() => {
        const m = activeMapping;
        const b = m.chosenBox ?? m.match.box;
        const value = m.override ?? b?.value ?? '';
        const isEditing = editingHeader === m.mapping.excelHeader;
        return (
          <div className="bg-card border-t border-border px-4 py-2 flex items-center gap-3 shrink-0">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {m.mapping.excelHeader}
                {m.mapping.fieldLabel && <span className="ml-1 text-primary">· {m.mapping.fieldLabel}</span>}
              </p>
              {isEditing ? (
                <input
                  className="w-full bg-muted rounded px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-primary text-foreground"
                  autoFocus
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      onEditHeader(m.mapping.excelHeader, editValue);
                      setEditingHeader(null);
                    } else if (e.key === 'Escape') {
                      setEditingHeader(null);
                    }
                  }}
                />
              ) : (
                <p className="text-sm text-foreground truncate">
                  {value || <span className="text-muted-foreground italic">
                    {m.mapping.searchText
                      ? 'no value found — try editing the search phrase or confirm manually'
                      : 'type a search phrase in the left panel to find this field in the PDF'}
                  </span>}
                </p>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1"
              onClick={() => {
                setEditValue(value);
                setEditingHeader(isEditing ? null : m.mapping.excelHeader);
              }}
            >
              <Pencil className="w-3.5 h-3.5" /> {isEditing ? 'Cancel' : 'Edit'}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="h-8 gap-1"
              onClick={() => onRejectHeader(m.mapping.excelHeader)}
            >
              <X className="w-3.5 h-3.5" /> Reject
            </Button>
            <Button
              size="sm"
              className="h-8 gap-1 bg-green-600 hover:bg-green-700"
              onClick={() => {
                if (isEditing) {
                  onEditHeader(m.mapping.excelHeader, editValue);
                  setEditingHeader(null);
                }
                onConfirmHeader(m.mapping.excelHeader, isEditing ? editValue : undefined);
              }}
            >
              <Check className="w-3.5 h-3.5" /> Confirm
            </Button>
          </div>
        );
      })()}
    </div>
  );
}
