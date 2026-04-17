import { useEffect, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/TextLayer.css';
import { Check, X, Pencil, Layers, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { MappingState } from './MappingReview';

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface Props {
  file: File;
  mappings: MappingState[];
  activeHeader: string | null;
  onConfirmHeader: (header: string, value?: string) => void;
  onRejectHeader:  (header: string) => void;
  onEditHeader:    (header: string, value: string) => void;
  onApplyToPageAll:    (page: number, status: 'confirmed' | 'rejected') => void;
}

export default function AutoHighlightViewer({
  file, mappings, activeHeader,
  onConfirmHeader, onRejectHeader, onEditHeader, onApplyToPageAll,
}: Props) {
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [scale, setScale] = useState(1);
  const [pdfLoaded, setPdfLoaded] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [editingHeader, setEditingHeader] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs  = useRef<Record<number, HTMLDivElement | null>>({});
  // Bumped by each Page's onRenderTextLayerSuccess callback. Triggers the
  // effect below that colours the matched glyphs green.
  const [textLayerTick, setTextLayerTick] = useState(0);

  // Object URL for the uploaded file.
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setFileUrl(url);
    setPdfLoaded(false);
    setNumPages(0);
    setCurrentPage(1);
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
        <Button size="sm" variant="ghost" onClick={() => setScale(s => Math.max(0.4, s - 0.1))}>
          <ZoomOut className="w-4 h-4" />
        </Button>
        <span className="text-xs text-foreground/70 w-10 text-center">{Math.round(scale * 100)}%</span>
        <Button size="sm" variant="ghost" onClick={() => setScale(s => Math.min(2.5, s + 0.1))}>
          <ZoomIn className="w-4 h-4" />
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

      {/* Scrollable container — every page rendered, stacked vertically. */}
      <div ref={scrollRef} className="flex-1 overflow-auto custom-scrollbar p-6 bg-viewer">
        {fileUrl && (
          <Document
            file={fileUrl}
            onLoadSuccess={p => { setNumPages(p.numPages); setPdfLoaded(true); }}
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
                    style={{ display: 'inline-block', lineHeight: 0 }}
                  >
                    <Page
                      pageNumber={pageNum}
                      scale={scale}
                      renderTextLayer={true}
                      renderAnnotationLayer={false}
                      onRenderTextLayerSuccess={() => setTextLayerTick(t => t + 1)}
                      loading={<div className="w-[600px] h-[800px] bg-white/5 animate-pulse rounded" />}
                    />
                    {pageMappings.map(m => {
                      const b = (m.chosenBox ?? m.match.box)!;
                      const isActive = m.mapping.excelHeader === activeHeader;
                      const value = m.override ?? b.value;
                      const stroke =
                        m.status === 'confirmed' ? 'rgba(22,163,74,0.9)'
                        : m.status === 'rejected'  ? 'rgba(185,28,28,0.7)'
                        : 'rgba(22,163,74,0.9)';   // pending matches get the same green pill as confirmed
                      return (
                        <div key={m.mapping.excelHeader}>
                          {/* Subtle rectangle — kept for context, but no longer
                              the primary cue (the glyphs themselves go green
                              via CSS, and the value-pill below is prominent). */}
                          <div
                            className="absolute pointer-events-none rounded-sm"
                            style={{
                              left:   `${b.x * 100}%`,
                              top:    `${b.y * 100}%`,
                              width:  `${b.width * 100}%`,
                              height: `${b.height * 100}%`,
                              outline: `${isActive ? 2 : 1}px dashed ${stroke}`,
                              zIndex: isActive ? 6 : 4,
                            }}
                          />
                          {/* Value pill — green, shown right above the box.
                              This is the always-visible evidence that a value
                              was extracted, even if the box alignment is off. */}
                          <div
                            className="absolute text-[11px] font-semibold px-2 py-0.5 rounded-md shadow whitespace-nowrap pointer-events-none"
                            style={{
                              left:  `${b.x * 100}%`,
                              top:   `calc(${b.y * 100}% - 22px)`,
                              background: m.status === 'rejected' ? '#fee2e2' : '#dcfce7',
                              color:      m.status === 'rejected' ? '#991b1b' : '#14532d',
                              border:     `1px solid ${stroke}`,
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
