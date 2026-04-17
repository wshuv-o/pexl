import { useEffect, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { ChevronLeft, ChevronRight, Check, X, Pencil, Layers } from 'lucide-react';
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
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [editingHeader, setEditingHeader] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setFileUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Mappings whose confirmed/current box falls on this page.
  const mappingsOnPage = mappings.filter(m => {
    const b = m.chosenBox ?? m.match.box;
    return b && b.page === page;
  });

  // Auto-jump to the active header's page when it changes.
  useEffect(() => {
    if (!activeHeader) return;
    const m = mappings.find(x => x.mapping.excelHeader === activeHeader);
    const b = m?.chosenBox ?? m?.match.box;
    if (b && b.page !== page) setPage(b.page);
  }, [activeHeader, mappings, page]);

  return (
    <div className="flex flex-col h-full bg-viewer">
      {/* Toolbar */}
      <div className="bg-card border-b border-border px-3 py-1.5 flex items-center gap-2 shrink-0">
        <Button size="sm" variant="ghost" onClick={() => setPage(p => Math.max(1, p - 1))}>
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <span className="text-xs text-foreground/70 min-w-[60px] text-center">
          Page {page} / {numPages || '…'}
        </span>
        <Button size="sm" variant="ghost" onClick={() => setPage(p => Math.min(numPages, p + 1))}>
          <ChevronRight className="w-4 h-4" />
        </Button>
        <div className="w-px h-5 bg-border mx-1" />
        <Button size="sm" variant="ghost" onClick={() => setScale(s => Math.max(0.4, s - 0.1))}>−</Button>
        <span className="text-xs text-foreground/70 w-10 text-center">{Math.round(scale * 100)}%</span>
        <Button size="sm" variant="ghost" onClick={() => setScale(s => Math.min(2.5, s + 0.1))}>+</Button>

        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground mr-1">
            {mappingsOnPage.length} mapping{mappingsOnPage.length !== 1 ? 's' : ''} on this page
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            disabled={mappingsOnPage.length === 0}
            onClick={() => onApplyToPageAll(page, 'confirmed')}
          >
            <Layers className="w-3.5 h-3.5" /> Confirm all on page
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            disabled={mappingsOnPage.length === 0}
            onClick={() => onApplyToPageAll(page, 'rejected')}
          >
            <X className="w-3.5 h-3.5" /> Reject all on page
          </Button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-auto custom-scrollbar p-6">
        {fileUrl && (
          <div className="flex justify-center">
            <div className="relative inline-block shadow-2xl" style={{ lineHeight: 0 }}>
              <Document file={fileUrl} onLoadSuccess={p => setNumPages(p.numPages)}>
                <Page
                  pageNumber={page}
                  scale={scale}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                />
              </Document>

              {/* Overlay the highlight boxes for every mapping on this page */}
              {mappingsOnPage.map(m => {
                const b = (m.chosenBox ?? m.match.box)!;
                const isActive = m.mapping.excelHeader === activeHeader;
                const colorByStatus =
                  m.status === 'confirmed' ? 'rgba(34,197,94,0.25)'
                  : m.status === 'rejected'  ? 'rgba(239,68,68,0.18)'
                  : 'rgba(250,204,21,0.32)';
                const borderByStatus =
                  m.status === 'confirmed' ? 'rgba(22,163,74,0.9)'
                  : m.status === 'rejected'  ? 'rgba(185,28,28,0.7)'
                  : 'rgba(202,138,4,0.95)';
                return (
                  <div key={m.mapping.excelHeader}>
                    <div
                      className="absolute pointer-events-none rounded-sm"
                      style={{
                        left:   `${b.x * 100}%`,
                        top:    `${b.y * 100}%`,
                        width:  `${b.width * 100}%`,
                        height: `${b.height * 100}%`,
                        background: colorByStatus,
                        border: `${isActive ? 2 : 1}px solid ${borderByStatus}`,
                        zIndex: isActive ? 6 : 4,
                      }}
                    />
                    <div
                      className="absolute text-[10px] px-1.5 py-0.5 rounded-md shadow bg-card text-foreground whitespace-nowrap"
                      style={{
                        left:  `${b.x * 100}%`,
                        top:   `calc(${b.y * 100}% - 18px)`,
                        border: `1px solid ${borderByStatus}`,
                        zIndex: 7,
                      }}
                    >
                      {m.mapping.excelHeader}{m.mapping.fieldLabel && m.mapping.fieldLabel !== m.mapping.excelHeader ? ` · ${m.mapping.fieldLabel}` : ''}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Per-header confirm bar — shown when a header is active */}
      {activeHeader && (() => {
        const m = mappings.find(x => x.mapping.excelHeader === activeHeader);
        if (!m) return null;
        const b = m.chosenBox ?? m.match.box;
        const value = m.override ?? b?.value ?? '';
        const isEditing = editingHeader === activeHeader;
        return (
          <div className="bg-card border-t border-border px-4 py-2 flex items-center gap-3 shrink-0">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{activeHeader}</p>
              {isEditing ? (
                <input
                  className="w-full bg-muted rounded px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-primary text-foreground"
                  autoFocus
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      onEditHeader(activeHeader, editValue);
                      setEditingHeader(null);
                    } else if (e.key === 'Escape') {
                      setEditingHeader(null);
                    }
                  }}
                />
              ) : (
                <p className="text-sm text-foreground truncate">
                  {value || <span className="text-muted-foreground italic">no candidate — use Edit to type a value</span>}
                </p>
              )}
              {m.match.alternatives.length > 0 && !isEditing && (
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {m.match.alternatives.length} alternative{m.match.alternatives.length !== 1 ? 's' : ''}
                </p>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1"
              onClick={() => {
                setEditValue(value);
                setEditingHeader(isEditing ? null : activeHeader);
              }}
            >
              <Pencil className="w-3.5 h-3.5" /> {isEditing ? 'Cancel' : 'Edit'}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="h-8 gap-1"
              onClick={() => onRejectHeader(activeHeader)}
            >
              <X className="w-3.5 h-3.5" /> Reject
            </Button>
            <Button
              size="sm"
              className="h-8 gap-1 bg-green-600 hover:bg-green-700"
              onClick={() => {
                if (isEditing) {
                  onEditHeader(activeHeader, editValue);
                  setEditingHeader(null);
                }
                onConfirmHeader(activeHeader, isEditing ? editValue : undefined);
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
