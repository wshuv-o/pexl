import { useState, useRef, useEffect, useMemo } from 'react';
import {
  ChevronLeft, ChevronRight, ZoomIn, ZoomOut,
  MousePointer2, Eraser, Loader2, TextCursor,
  FileDown, FileInput, FileStack, Trash2, ListChecks, ChevronDown, Search,
  SlidersHorizontal, Download, MousePointerClick, Wand2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import type { ViewerTool } from '@/types/utilscraper';

interface ViewerToolbarProps {
  currentPage: number;
  totalPages: number;
  startPage: number;
  zoom: number;
  tool: ViewerTool;
  isOcr: boolean;
  hasHighlightsOnPage: boolean;
  onPageChange: (p: number) => void;
  onZoomChange: (z: number) => void;
  onToolChange: (t: ViewerTool) => void;
  onExtract: () => void;
  extracting: boolean;
  hasHighlights: boolean;
  // Bulk actions
  onApplyToAllPages: () => void;
  onApplyToAllPdfs: () => void;
  // Mirror highlights only to the ctrl/cmd-selected tabs. Count drives the
  // button's badge; undefined handler hides the button entirely.
  onApplyToSelectedPdfs?: () => void;
  selectedPdfCount?: number;
  onEraseAllPages: () => void;
  onApplyToPageRange: (pages: number[]) => void;
  searchOpen: boolean;
  onSearchToggle: () => void;
  // Rotation
  fineRotation: number;
  onFineRotationChange: (deg: number) => void;
  // Start page
  onStartPageChange: (startPage: number) => void;
  // OCR download
  onDownloadOcr: () => void;
  downloadingOcr: boolean;
  // Auto-search: find field labels in the PDF and auto-create highlights
  // over their adjacent values. Available for all doc types.
  onAutoSearch: () => void;
  autoSearching: boolean;
}

const ZOOM_OPTIONS = [
  { label: '50%',      value: 0.5  },
  { label: '75%',      value: 0.75 },
  { label: '100%',     value: 1.0  },
  { label: '125%',     value: 1.25 },
  { label: '150%',     value: 1.5  },
  { label: '175%',     value: 1.75 },
  { label: '200%',     value: 2.0  },
  { label: '250%',     value: 2.5  },
  { label: '300%',     value: 3.0  },
  { label: '400%',     value: 4.0  },
  { label: '500%',     value: 5.0  },
  { label: 'Fit Page', value: 0.8  },
];

export default function ViewerToolbar({
  currentPage, totalPages, startPage, zoom, tool, isOcr, hasHighlightsOnPage,
  onPageChange, onZoomChange, onToolChange,
  onExtract, extracting, hasHighlights,
  onApplyToAllPages, onApplyToAllPdfs, onApplyToSelectedPdfs, selectedPdfCount = 0,
  onEraseAllPages, onApplyToPageRange,
  searchOpen, onSearchToggle,
  fineRotation, onFineRotationChange,
  onStartPageChange,
  onDownloadOcr, downloadingOcr,
  onAutoSearch, autoSearching,
}: ViewerToolbarProps) {
  // Relative page numbering when startPage > 1 (cover pages skipped)
  const hasOffset    = startPage > 1;
  const contentPage  = currentPage - startPage + 1;  // can be 0 or negative for cover pages
  const contentTotal = totalPages - startPage + 1;

  // Inline start-page editing (double-click the badge)
  const [editingStartPage, setEditingStartPage] = useState(false);
  const [startPageDraft, setStartPageDraft]     = useState(String(startPage));
  const startPageInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingStartPage && startPageInputRef.current) {
      startPageInputRef.current.focus();
      startPageInputRef.current.select();
    }
  }, [editingStartPage]);

  const commitStartPage = () => {
    const n = parseInt(startPageDraft);
    if (!isNaN(n) && n >= 1 && n <= totalPages) {
      onStartPageChange(n);
    }
    setEditingStartPage(false);
  };
  const [fineOpen, setFineOpen] = useState(false);
  const fineBtnRef = useRef<HTMLButtonElement>(null);
  const finePopRef = useRef<HTMLDivElement>(null);
  const [finePos, setFinePos] = useState<{ top: number; left: number } | null>(null);

  // Position the fine-rotation popover
  useEffect(() => {
    if (fineOpen && fineBtnRef.current) {
      const r = fineBtnRef.current.getBoundingClientRect();
      setFinePos({ top: r.bottom + 4, left: r.left - 40 });
    }
  }, [fineOpen]);

  // Close on outside click
  useEffect(() => {
    if (!fineOpen) return;
    const handler = (e: MouseEvent) => {
      if (finePopRef.current && !finePopRef.current.contains(e.target as Node) &&
          fineBtnRef.current && !fineBtnRef.current.contains(e.target as Node)) {
        setFineOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [fineOpen]);

  const toolBtn = (t: ViewerTool, icon: React.ReactNode, label: string) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={`p-1.5 rounded transition-all duration-200 ${
            tool === t
              ? 'bg-primary/15 text-primary'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted'
          }`}
          onClick={() => onToolChange(t)}
          aria-label={label}
          aria-pressed={tool === t}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );

  const bulkBtn = (
    icon: React.ReactNode,
    label: string,
    onClick: () => void,
    disabled = false,
  ) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted
                     disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-200"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[200px] text-xs">{label}</TooltipContent>
    </Tooltip>
  );

  return (
    <div className="h-10 bg-card border-b border-border flex items-center px-3 gap-2 shrink-0 overflow-x-auto">

      {/* Page navigation */}
      <div className="flex items-center gap-0.5 shrink-0">
        <button
          className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 transition-all duration-200"
          disabled={currentPage <= 1}
          onClick={() => onPageChange(currentPage - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        <input
          type="number"
          min={1}
          max={totalPages}
          className="w-10 h-7 text-center text-xs bg-muted rounded border-none text-foreground outline-none focus:ring-1 focus:ring-primary"
          value={currentPage}
          onChange={e => {
            const n = parseInt(e.target.value);
            if (!isNaN(n) && n >= 1 && n <= totalPages) onPageChange(n);
          }}
          aria-label="Current page"
        />

        <span className="text-xs text-muted-foreground px-1">/ {totalPages}</span>

        <button
          className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 transition-all duration-200"
          disabled={currentPage >= totalPages}
          onClick={() => onPageChange(currentPage + 1)}
          aria-label="Next page"
        >
          <ChevronRight className="w-4 h-4" />
        </button>

        {/* Start page badge — double-click to set which page is "page 1" */}
        {editingStartPage ? (
          <input
            ref={startPageInputRef}
            type="number"
            min={1}
            max={totalPages}
            value={startPageDraft}
            onChange={e => setStartPageDraft(e.target.value)}
            onBlur={commitStartPage}
            onKeyDown={e => {
              if (e.key === 'Enter') commitStartPage();
              if (e.key === 'Escape') setEditingStartPage(false);
            }}
            className="w-12 h-5 text-center text-[11px] bg-background rounded border border-primary
                       text-foreground outline-none ml-1"
          />
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={`text-[11px] px-1.5 py-0.5 rounded-full font-medium ml-1 cursor-pointer select-none ${
                  hasOffset
                    ? contentPage >= 1
                      ? 'bg-primary/15 text-primary'
                      : 'bg-amber-100 text-amber-700'
                    : 'bg-muted text-muted-foreground'
                }`}
                onDoubleClick={() => {
                  setStartPageDraft(String(startPage));
                  setEditingStartPage(true);
                }}
              >
                {hasOffset
                  ? contentPage >= 1 ? `P${contentPage}` : 'Cover'
                  : 'P1'}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs max-w-[200px]">
              {hasOffset
                ? contentPage >= 1
                  ? `Content page ${contentPage} of ${contentTotal} (start=${startPage})`
                  : `Cover page (before start page ${startPage})`
                : 'Double-click to set start page (skip covers)'}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Separator */}
      <div className="w-px h-5 bg-border shrink-0" />

      {/* Zoom controls */}
      <div className="flex items-center gap-0.5 shrink-0">
        <button
          className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-all duration-200"
          onClick={() => onZoomChange(Math.max(0.3, parseFloat((zoom - 0.25).toFixed(2))))}
          aria-label="Zoom out"
        >
          <ZoomOut className="w-4 h-4" />
        </button>

        <Select value={String(zoom)} onValueChange={v => onZoomChange(Number(v))}>
          <SelectTrigger className="w-20 h-7 text-xs bg-muted border-none text-foreground focus:ring-0">
            <SelectValue>{Math.round(zoom * 100)}%</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {ZOOM_OPTIONS.map(o => (
              <SelectItem key={o.label} value={String(o.value)}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <button
          className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-all duration-200"
          onClick={() => onZoomChange(Math.min(5.0, parseFloat((zoom + 0.25).toFixed(2))))}
          aria-label="Zoom in"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
      </div>

      {/* Separator */}
      <div className="w-px h-5 bg-border shrink-0" />

      {/* Rotation — fine straighten only */}
      <div className="flex items-center gap-0.5 shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              ref={fineBtnRef}
              className={`p-1.5 rounded transition-all duration-200 ${
                fineRotation !== 0 || fineOpen
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
              onClick={() => setFineOpen(o => !o)}
              aria-label="Fine rotation — straighten skewed scans"
            >
              <SlidersHorizontal className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            Straighten ({fineRotation !== 0 ? `${fineRotation > 0 ? '+' : ''}${fineRotation}°` : 'fine rotate'})
          </TooltipContent>
        </Tooltip>

        {fineOpen && finePos && (
          <div
            ref={finePopRef}
            className="fixed bg-card border border-border rounded-lg shadow-xl p-3 z-[100] w-56"
            style={{ top: finePos.top, left: finePos.left }}
          >
            <p className="text-xs font-semibold text-foreground mb-2">
              Straighten skewed scan
            </p>
            <input
              type="range"
              min={-15}
              max={15}
              step={0.5}
              value={fineRotation}
              onChange={e => onFineRotationChange(parseFloat(e.target.value))}
              className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
            />
            <div className="flex items-center justify-between mt-1.5">
              <span className="text-[11px] text-muted-foreground">-15°</span>
              <span className="text-xs font-mono font-medium text-foreground">
                {fineRotation > 0 ? '+' : ''}{fineRotation}°
              </span>
              <span className="text-[11px] text-muted-foreground">+15°</span>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="w-full h-7 text-xs mt-2"
              onClick={() => { onFineRotationChange(0); setFineOpen(false); }}
            >
              Reset to 0°
            </Button>
          </div>
        )}
      </div>

      {/* Separator */}
      <div className="w-px h-5 bg-border shrink-0" />

      {/* Drawing tools */}
      <div className="flex items-center gap-0.5 shrink-0">
        {toolBtn('cursor',      <MousePointer2     className="w-4 h-4" />, 'Cursor — drag to highlight, click boxes to edit')}
        {toolBtn('select',      <MousePointerClick className="w-4 h-4" />, 'Select — click boxes or marquee-select, drag to move')}
        {toolBtn('text-select', <TextCursor        className="w-4 h-4" />, 'Select text — copy from PDF')}
        {toolBtn('eraser',      <Eraser            className="w-4 h-4" />, 'Erase all on this page')}
      </div>

      {/* Separator */}
      <div className="w-px h-5 bg-border shrink-0" />

      {/* Bulk actions */}
      <div className="flex items-center gap-0.5 shrink-0">
        {bulkBtn(
          <FileDown className="w-4 h-4" />,
          'Copy highlights to all pages in this PDF',
          onApplyToAllPages,
          !hasHighlightsOnPage,
        )}
        {bulkBtn(
          <FileInput className="w-4 h-4" />,
          'Copy highlights to all open PDFs',
          onApplyToAllPdfs,
          !hasHighlightsOnPage,
        )}

        {/* Copy highlights to multi-selected PDFs — appears once the user has
            ctrl/cmd-clicked one or more tabs in the top tab bar. The badge
            shows how many tabs are currently selected. */}
        {onApplyToSelectedPdfs && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="relative p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted
                           disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0"
                onClick={onApplyToSelectedPdfs}
                disabled={!hasHighlightsOnPage || selectedPdfCount === 0}
                aria-label="Copy highlights to selected PDFs"
              >
                <FileStack className="w-4 h-4" />
                {selectedPdfCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-primary text-primary-foreground text-[9px] font-semibold flex items-center justify-center leading-none">
                    {selectedPdfCount}
                  </span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[240px] text-xs">
              {selectedPdfCount === 0
                ? 'Ctrl/Cmd+click tabs in the top bar to multi-select, then use this to copy highlights only to those PDFs.'
                : `Copy highlights to the ${selectedPdfCount} selected PDF${selectedPdfCount !== 1 ? 's' : ''}`}
            </TooltipContent>
          </Tooltip>
        )}

        {bulkBtn(
          <Trash2 className="w-4 h-4" />,
          'Erase highlights from all pages in this PDF',
          onEraseAllPages,
          !hasHighlights,
        )}
        <PageRangeButton
          disabled={!hasHighlightsOnPage}
          totalPages={totalPages}
          onApply={onApplyToPageRange}
        />
      </div>

      {/* Separator */}
      <div className="w-px h-5 bg-border shrink-0" />

      {/* Search */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className={`p-1.5 rounded transition-all duration-200 shrink-0 ${
              searchOpen
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
            onClick={onSearchToggle}
            aria-label="Search text (Ctrl+F)"
          >
            <Search className="w-4 h-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">Search text (Ctrl+F)</TooltipContent>
      </Tooltip>

      {/* Spacer */}
      <div className="flex-1" />

      {/* OCR badge */}
      {isOcr ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium cursor-default shrink-0">
              OCR Processed
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[200px] text-xs">
            Scanned page — text extracted via OCR
          </TooltipContent>
        </Tooltip>
      ) : (
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground cursor-default shrink-0">
          Native Text
        </span>
      )}

      {/* Auto-search: find each field's label in the PDF and create
          highlights over the adjacent value text. Users can then review /
          tweak before extracting. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className="p-1.5 rounded text-primary/70 hover:text-primary hover:bg-primary/10
                       disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0"
            onClick={onAutoSearch}
            disabled={autoSearching}
            aria-label="Auto-search field values"
          >
            {autoSearching
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Wand2 className="w-4 h-4" />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[240px] text-xs">
          Auto-search — find each field's label in the PDF and highlight the
          adjacent value. You can tweak or delete anything wrong before extracting.
        </TooltipContent>
      </Tooltip>

      {/* Download OCR'd PDF */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted
                       disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0"
            onClick={onDownloadOcr}
            disabled={downloadingOcr}
            aria-label="Download OCR'd PDF"
          >
            {downloadingOcr
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Download className="w-4 h-4" />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[200px] text-xs">
          Download OCR'd PDF
        </TooltipContent>
      </Tooltip>

      {/* Extract */}
      <Button
        size="sm"
        className="bg-primary text-primary-foreground hover:bg-primary/90 font-semibold text-xs h-7 px-4 shrink-0"
        disabled={!hasHighlights || extracting}
        onClick={onExtract}
      >
        {extracting && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />}
        Extract
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PageRangeButton — uses fixed positioning so it escapes overflow:auto
// ---------------------------------------------------------------------------
// Parse a page list string like "1,2,5,9-12" → [1, 2, 5, 9, 10, 11, 12]
function parsePageList(input: string, totalPages: number): number[] {
  const pages = new Set<number>();
  const parts = input.split(',').map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1], 10);
      const b = parseInt(rangeMatch[2], 10);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let p = lo; p <= hi; p++) {
        if (p >= 1 && p <= totalPages) pages.add(p);
      }
    } else {
      const n = parseInt(part, 10);
      if (!isNaN(n) && n >= 1 && n <= totalPages) pages.add(n);
    }
  }
  return Array.from(pages).sort((a, b) => a - b);
}

function PageRangeButton({
  disabled,
  totalPages,
  onApply,
}: {
  disabled: boolean;
  totalPages: number;
  onApply: (pages: number[]) => void;
}) {
  const [open, setOpen]           = useState(false);
  const [pageList, setPageList]   = useState('');
  const btnRef  = useRef<HTMLButtonElement>(null);
  const popRef  = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Live preview of parsed pages
  const parsedPreview = useMemo(
    () => pageList.trim() ? parsePageList(pageList, totalPages) : [],
    [pageList, totalPages],
  );

  useEffect(() => {
    if (open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node) &&
          btnRef.current && !btnRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleSubmit = () => {
    const pages = parsePageList(pageList, totalPages);
    if (pages.length === 0) return;
    onApply(pages);
    setOpen(false);
    setPageList('');
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            ref={btnRef}
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted
                       disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-200 flex items-center gap-0.5"
            onClick={() => setOpen(o => !o)}
            disabled={disabled}
            aria-label="Copy highlights to specific pages"
          >
            <ListChecks className="w-4 h-4" />
            <ChevronDown className="w-2.5 h-2.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">Copy highlights to specific pages</TooltipContent>
      </Tooltip>

      {open && pos && (
        <div
          ref={popRef}
          className="fixed bg-card border border-border rounded-lg shadow-xl p-3 z-[100] w-64"
          style={{ top: pos.top, left: pos.left }}
        >
          <p className="text-xs font-semibold text-foreground mb-1">Apply to pages</p>
          <p className="text-[10px] text-muted-foreground mb-2">
            e.g. <span className="font-mono">1,3,5</span> or <span className="font-mono">2-6,8,10-12</span>
          </p>
          <Input
            type="text"
            placeholder="1, 2, 5, 9-12"
            className="h-7 text-xs mb-2 font-mono"
            value={pageList}
            autoFocus
            onChange={e => setPageList(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }}
          />
          {parsedPreview.length > 0 && (
            <p className="text-[10px] text-muted-foreground mb-2">
              {parsedPreview.length} page{parsedPreview.length !== 1 ? 's' : ''}: {parsedPreview.slice(0, 8).join(', ')}{parsedPreview.length > 8 ? '…' : ''}
            </p>
          )}
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="flex-1 h-7 text-xs"
              onClick={() => setPageList(`1-${totalPages}`)}
            >
              All pages
            </Button>
            <Button
              size="sm"
              className="flex-1 h-7 text-xs bg-green-600 hover:bg-green-700 text-white"
              onClick={handleSubmit}
              disabled={parsedPreview.length === 0}
            >
              Apply
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
