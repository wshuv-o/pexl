import { useState, useRef, useEffect, useMemo } from 'react';
import {
  ChevronLeft, ChevronRight, ZoomIn, ZoomOut,
  MousePointer2, Eraser, Loader2, TextCursor,
  FileDown, FileInput, FileStack, Trash2, ListChecks, ChevronDown, Search,
  SlidersHorizontal, Download, MousePointerClick, Wand2, Filter, Check, FileSpreadsheet, Table2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import type { ViewerTool, Highlight } from '@/types/utilscraper';
import { getFieldConfig } from '@/types/utilscraper';

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
  // Bulk actions — `idsFilter` is the optional subset of highlight ids to
  // apply (driven by the Selected-fields popover). If absent / empty, the
  // existing "all" behavior is used.
  onApplyToAllPages: (idsFilter?: Set<string>) => void;
  onApplyToAllPdfs:  (idsFilter?: Set<string>) => void;
  // Mirror highlights only to the ctrl/cmd-selected tabs. Count drives the
  // button's badge; undefined handler hides the button entirely.
  onApplyToSelectedPdfs?: (idsFilter?: Set<string>) => void;
  selectedPdfCount?: number;
  // All highlights across the active PDF — drives the Selected-fields list.
  allHighlights?: import('@/types/utilscraper').Highlight[];
  // Ids of highlights the user has visually selected (cursor / select tool).
  // When non-empty the regular bulk-apply buttons filter to only those ids,
  // and the Selected-fields popover opens pre-checked with those ids.
  selectedIds?: Set<string>;
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
  // Excel table export
  onDownloadExcel: () => Promise<void>;
  onDownloadExcelSelected?: () => Promise<void>;
  onDownloadExcelRange: (range: string) => Promise<void>;
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
  allHighlights,
  selectedIds,
  onEraseAllPages, onApplyToPageRange,
  searchOpen, onSearchToggle,
  fineRotation, onFineRotationChange,
  onStartPageChange,
  onDownloadOcr, downloadingOcr,
  onDownloadExcel, onDownloadExcelSelected, onDownloadExcelRange,
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
        {toolBtn('cursor',       <MousePointer2     className="w-4 h-4" />, 'Cursor — drag to draw extraction boxes, click to edit')}
        {toolBtn('select',       <MousePointerClick className="w-4 h-4" />, 'Select — click boxes or marquee-select, drag to move')}
        {toolBtn('text-select',  <TextCursor        className="w-4 h-4" />, 'Select text — copy from PDF')}
        {toolBtn('table-select', <Table2            className="w-4 h-4" />, 'Table select — draw a box to extract a table region as Excel')}
        {toolBtn('eraser',       <Eraser            className="w-4 h-4" />, 'Erase all on this page')}
      </div>

      {/* Separator */}
      <div className="w-px h-5 bg-border shrink-0" />

      {/* Bulk actions */}
      <div className="flex items-center gap-0.5 shrink-0">
        {bulkBtn(
          <FileDown className="w-4 h-4" />,
          selectedIds && selectedIds.size > 0
            ? `Copy ${selectedIds.size} selected highlight${selectedIds.size !== 1 ? 's' : ''} to all pages`
            : 'Copy highlights to all pages in this PDF',
          () => onApplyToAllPages(selectedIds && selectedIds.size > 0 ? selectedIds : undefined),
          !hasHighlightsOnPage,
        )}
        {bulkBtn(
          <FileInput className="w-4 h-4" />,
          selectedIds && selectedIds.size > 0
            ? `Copy ${selectedIds.size} selected highlight${selectedIds.size !== 1 ? 's' : ''} to all open PDFs`
            : 'Copy highlights to all open PDFs',
          () => onApplyToAllPdfs(selectedIds && selectedIds.size > 0 ? selectedIds : undefined),
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
                onClick={() => onApplyToSelectedPdfs(selectedIds && selectedIds.size > 0 ? selectedIds : undefined)}
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

        {/* "Selected & Apply" popover — pick a subset of highlights and
            choose where to copy them (all pages, all PDFs, selected PDFs). */}
        <SelectedApplyPopover
          highlights={allHighlights ?? []}
          selectedPdfCount={selectedPdfCount}
          preSelectedIds={selectedIds}
          onApplyToAllPages={onApplyToAllPages}
          onApplyToAllPdfs={onApplyToAllPdfs}
          onApplyToSelectedPdfs={onApplyToSelectedPdfs}
        />

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

      {/* Download tables as Excel */}
      <ExcelDownloadPopover
        totalPages={totalPages}
        selectedPdfCount={selectedPdfCount}
        onDownloadCurrent={onDownloadExcel}
        onDownloadSelected={onDownloadExcelSelected}
        onDownloadRange={onDownloadExcelRange}
      />

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

// ─── Excel download popover ──────────────────────────────────────────────
function ExcelDownloadPopover({
  totalPages,
  selectedPdfCount = 0,
  onDownloadCurrent,
  onDownloadSelected,
  onDownloadRange,
}: {
  totalPages: number;
  selectedPdfCount?: number;
  onDownloadCurrent: () => Promise<void>;
  onDownloadSelected?: () => Promise<void>;
  onDownloadRange: (range: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'current' | 'selected' | 'range' | null>(null);
  const [rangeInput, setRangeInput] = useState('');
  const [rangeError, setRangeError] = useState('');

  const run = async (op: 'current' | 'selected' | 'range', fn: () => Promise<void>) => {
    setBusy(op);
    try { await fn(); } catch { /* toasts handled by caller */ }
    setBusy(null);
  };

  const handleRange = () => {
    const parsed = parsePageList(rangeInput, totalPages);
    if (parsed.length === 0) { setRangeError('No valid pages — try "1-5, 8"'); return; }
    setRangeError('');
    run('range', () => onDownloadRange(rangeInput));
  };

  const rowCls = (disabled: boolean) =>
    `flex items-center gap-2 w-full px-2 py-1.5 rounded text-xs text-left transition-colors
     ${disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-muted cursor-pointer'}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted
                     disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0"
          aria-label="Export tables as Excel"
        >
          {busy !== null
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : <FileSpreadsheet className="w-4 h-4" />}
        </button>
      </PopoverTrigger>

      <PopoverContent side="bottom" align="end" className="w-60 p-2">
        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide px-2 pb-1">
          Export as Excel
        </p>

        {/* This PDF */}
        <button
          className={rowCls(busy !== null)}
          disabled={busy !== null}
          onClick={() => { run('current', onDownloadCurrent); setOpen(false); }}
        >
          {busy === 'current'
            ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
            : <FileSpreadsheet className="w-3.5 h-3.5 shrink-0" />}
          This PDF
        </button>

        {/* Selected PDFs */}
        <button
          className={rowCls(busy !== null || !onDownloadSelected || selectedPdfCount === 0)}
          disabled={busy !== null || !onDownloadSelected || selectedPdfCount === 0}
          onClick={() => { if (onDownloadSelected) { run('selected', onDownloadSelected); setOpen(false); } }}
        >
          {busy === 'selected'
            ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
            : <FileSpreadsheet className="w-3.5 h-3.5 shrink-0" />}
          <span>
            Selected PDFs
            {selectedPdfCount > 0 && (
              <span className="ml-1 px-1 py-0.5 rounded bg-primary/15 text-primary text-[10px] font-semibold">
                {selectedPdfCount}
              </span>
            )}
          </span>
        </button>

        {/* Page range */}
        <div className="border-t border-border mt-1.5 pt-1.5 px-1">
          <p className="text-[11px] text-muted-foreground mb-1">Page range (this PDF)</p>
          <div className="flex gap-1">
            <Input
              value={rangeInput}
              onChange={e => { setRangeInput(e.target.value); setRangeError(''); }}
              onKeyDown={e => e.key === 'Enter' && handleRange()}
              placeholder={`e.g. 1-${Math.min(totalPages, 5)}, 8`}
              className="h-7 text-xs flex-1 min-w-0"
              disabled={busy !== null}
            />
            <button
              onClick={handleRange}
              disabled={busy !== null || !rangeInput.trim()}
              className="px-2 h-7 rounded bg-primary text-primary-foreground text-xs font-medium
                         hover:opacity-90 disabled:opacity-40 transition-opacity shrink-0"
            >
              {busy === 'range' ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Export'}
            </button>
          </div>
          {rangeError && <p className="text-[11px] text-destructive mt-0.5">{rangeError}</p>}
          {rangeInput.trim() && !rangeError && (() => {
            const pages = parsePageList(rangeInput, totalPages);
            return pages.length > 0
              ? <p className="text-[11px] text-muted-foreground mt-0.5">{pages.length} page{pages.length !== 1 ? 's' : ''}: {pages.slice(0, 6).join(', ')}{pages.length > 6 ? '…' : ''}</p>
              : <p className="text-[11px] text-destructive mt-0.5">No valid pages</p>;
          })()}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Selected fields → Apply popover ────────────────────────────────────
// Lists every highlight in the active PDF with a checkbox. The user can
// pick a subset and then apply only those to all pages / all open PDFs /
// the multi-tab-selected PDFs. If nothing is checked, all are used.
function SelectedApplyPopover({
  highlights,
  selectedPdfCount = 0,
  preSelectedIds,
  onApplyToAllPages,
  onApplyToAllPdfs,
  onApplyToSelectedPdfs,
}: {
  highlights: Highlight[];
  selectedPdfCount?: number;
  // Ids already selected via the cursor/select tool. When provided the
  // popover opens with those checkboxes pre-ticked.
  preSelectedIds?: Set<string>;
  onApplyToAllPages:    (idsFilter?: Set<string>) => void;
  onApplyToAllPdfs:     (idsFilter?: Set<string>) => void;
  onApplyToSelectedPdfs?: (idsFilter?: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // When the popover opens, seed checkboxes from the visual selection
  // (cursor/select tool). If nothing is visually selected, start empty.
  useEffect(() => {
    if (open) {
      setPicked(preSelectedIds && preSelectedIds.size > 0 ? new Set(preSelectedIds) : new Set());
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: string) =>
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectAll = () =>
    setPicked(new Set(highlights.map(h => h.id)));
  const clearAll = () => setPicked(new Set());

  const filter = picked.size > 0 ? picked : undefined;
  const ready  = highlights.length > 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              className="relative p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted
                         disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0"
              disabled={!ready}
              aria-label="Select fields, then apply"
            >
              <ListChecks className="w-4 h-4" />
              {picked.size > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-primary text-primary-foreground text-[9px] font-semibold flex items-center justify-center leading-none">
                  {picked.size}
                </span>
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[220px] text-xs">
          Pick specific highlights, then apply them to all pages, all PDFs,
          or the multi-selected PDFs.
        </TooltipContent>
      </Tooltip>

      <PopoverContent align="end" className="w-80 p-0">
        <div className="px-3 py-2 border-b border-border flex items-center gap-2 text-xs">
          <span className="font-semibold text-foreground">Apply selected fields</span>
          <span className="text-muted-foreground ml-auto">
            {picked.size} / {highlights.length} picked
          </span>
        </div>

        <div className="px-3 py-2 border-b border-border flex items-center gap-2 text-[11px]">
          <button
            onClick={selectAll}
            disabled={!ready}
            className="px-2 py-0.5 rounded bg-muted hover:bg-muted/80 transition-colors disabled:opacity-40"
          >Select all</button>
          <button
            onClick={clearAll}
            disabled={picked.size === 0}
            className="px-2 py-0.5 rounded bg-muted hover:bg-muted/80 transition-colors disabled:opacity-40"
          >Clear</button>
          <span className="ml-auto text-muted-foreground">
            {picked.size === 0 ? '(none → applies all)' : ''}
          </span>
        </div>

        <div className="max-h-72 overflow-y-auto px-2 py-1">
          {highlights.length === 0 ? (
            <div className="text-center text-xs text-muted-foreground py-6">
              No highlights yet — draw some first.
            </div>
          ) : (
            highlights
              .slice()
              .sort((a, b) => (a.page - b.page) || a.field.localeCompare(b.field))
              .map(h => {
                const cfg = getFieldConfig(h.field);
                const checked = picked.has(h.id);
                return (
                  <label
                    key={h.id}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs cursor-pointer transition-colors
                      ${checked ? 'bg-primary/10' : 'hover:bg-muted/60'}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(h.id)}
                      className="sr-only"
                    />
                    <span
                      className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0
                        ${checked ? 'bg-primary border-primary' : 'border-border'}`}
                    >
                      {checked && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
                    </span>
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: cfg.color }}
                    />
                    <span className="truncate flex-1">{cfg.label}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0">
                      p{h.page}
                    </span>
                  </label>
                );
              })
          )}
        </div>

        <div className="border-t border-border p-2 flex flex-col gap-1">
          <button
            onClick={() => { onApplyToAllPages(filter); setOpen(false); }}
            disabled={!ready}
            className="flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-muted disabled:opacity-40 transition-colors"
          >
            <FileDown className="w-3.5 h-3.5" />
            <span>Apply to all pages</span>
          </button>
          <button
            onClick={() => { onApplyToAllPdfs(filter); setOpen(false); }}
            disabled={!ready}
            className="flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-muted disabled:opacity-40 transition-colors"
          >
            <FileInput className="w-3.5 h-3.5" />
            <span>Apply to all open PDFs</span>
          </button>
          {onApplyToSelectedPdfs && (
            <button
              onClick={() => { onApplyToSelectedPdfs(filter); setOpen(false); }}
              disabled={!ready || selectedPdfCount === 0}
              className="flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-muted disabled:opacity-40 transition-colors"
            >
              <FileStack className="w-3.5 h-3.5" />
              <span>Apply to {selectedPdfCount} selected PDF{selectedPdfCount !== 1 ? 's' : ''}</span>
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// silence "unused" hint for the icon import-set if Filter/Check aren't pulled in
void Filter;

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
