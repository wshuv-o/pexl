import { useState, useRef, useEffect, useMemo } from 'react';
import {
  ChevronLeft, ChevronRight, ZoomIn, ZoomOut,
  MousePointer2, Eraser, Loader2, TextCursor,
  FileDown, FileInput, FileStack, Trash2, ListChecks, ChevronDown,
  SlidersHorizontal, Download, MousePointerClick, Filter, Check, Table2, ScanLine, RotateCw, RotateCcw,
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
  // Rotation
  fineRotation: number;
  onFineRotationChange: (deg: number) => void;
  // Start page
  onStartPageChange: (startPage: number) => void;
  // OCR download
  onDownloadOcr: () => void;
  downloadingOcr: boolean;
  // Force Re-OCR
  onForceOcr: () => void;
  forcingOcr: boolean;
  forceOcrActive: boolean;
  // Rotate all pages 90° CW; backend bakes rotation so OCR/highlight
  // coordinates stay correct.
  onRotateAll: () => void;
  rotatingAll: boolean;
  // Same but 90° CCW.
  onRotateAllCcw?: () => void;
  rotatingAllCcw?: boolean;
  // Rotate every open PDF 90° CW (loops through all sessions). Optional —
  // only shown if the host page passes a handler.
  onRotateAllPdfs?: () => void;
  rotatingAllPdfs?: boolean;
  // Same but 90° CCW.
  onRotateAllPdfsCcw?: () => void;
  rotatingAllPdfsCcw?: boolean;
  // Rotate only the ctrl/cmd-selected PDFs (badge shows count). Undefined
  // handler hides the button; only shown when selectedPdfCount > 0.
  onRotateSelectedPdfs?: () => void;
  rotatingSelectedPdfs?: boolean;
  onRotateSelectedPdfsCcw?: () => void;
  rotatingSelectedPdfsCcw?: boolean;
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
  fineRotation, onFineRotationChange,
  onStartPageChange,
  onDownloadOcr, downloadingOcr,
  onForceOcr, forcingOcr, forceOcrActive,
  onRotateAll, rotatingAll,
  onRotateAllCcw, rotatingAllCcw = false,
  onRotateAllPdfs, rotatingAllPdfs = false,
  onRotateAllPdfsCcw, rotatingAllPdfsCcw = false,
  onRotateSelectedPdfs, rotatingSelectedPdfs = false,
  onRotateSelectedPdfsCcw, rotatingSelectedPdfsCcw = false,
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
  const toolBtn = (t: ViewerTool, icon: React.ReactNode, label: string) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={`relative p-1.5 rounded transition-all duration-200 ${
            tool === t
              ? 'bg-primary/15 text-primary after:absolute after:left-1.5 after:right-1.5 after:-bottom-[3px] after:h-[2px] after:bg-primary after:rounded-full'
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

      {/* Rotation — consolidated menu (was 6 icons + a slider popover) */}
      <RotateMenu
        onRotateThisCw={onRotateAll}
        rotatingThisCw={rotatingAll}
        onRotateThisCcw={onRotateAllCcw}
        rotatingThisCcw={rotatingAllCcw}
        onRotateAllCw={onRotateAllPdfs}
        rotatingAllCw={rotatingAllPdfs}
        onRotateAllCcw={onRotateAllPdfsCcw}
        rotatingAllCcw={rotatingAllPdfsCcw}
        onRotateSelectedCw={onRotateSelectedPdfs}
        rotatingSelectedCw={rotatingSelectedPdfs}
        onRotateSelectedCcw={onRotateSelectedPdfsCcw}
        rotatingSelectedCcw={rotatingSelectedPdfsCcw}
        selectedPdfCount={selectedPdfCount}
        fineRotation={fineRotation}
        onFineRotationChange={onFineRotationChange}
      />

      {/* Separator */}
      <div className="w-px h-5 bg-border shrink-0" />

      {/* Drawing tools */}
      <div className="flex items-center gap-0.5 shrink-0">
        {toolBtn('cursor',       <MousePointer2     className="w-4 h-4" />, 'Cursor — drag to draw extraction boxes, click to edit')}
        {toolBtn('select',       <MousePointerClick className="w-4 h-4" />, 'Select — click boxes or marquee-select, drag to move  (Ctrl+S)')}
        {toolBtn('text-select',  <TextCursor        className="w-4 h-4" />, 'Select text — copy from PDF  (Ctrl+T)')}
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
            ? `Copy ${selectedIds.size} selected highlight${selectedIds.size !== 1 ? 's' : ''} to all pages    (select with Ctrl+A, copy with Ctrl+C, paste on any page with Ctrl+V; Ctrl+X cuts)`
            : 'Copy highlights to all pages in this PDF    (select with Ctrl+A, copy with Ctrl+C, paste on any page with Ctrl+V; Ctrl+X cuts)',
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

      {/* Force Re-OCR */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={`p-1.5 rounded transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed ${
              forceOcrActive
                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-1 ring-amber-500/40'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
            onClick={onForceOcr}
            disabled={forcingOcr}
            aria-label="Force Re-OCR"
          >
            {forcingOcr
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <ScanLine className="w-4 h-4" />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[220px] text-xs">
          {forceOcrActive
            ? 'Force OCR active — all pages are being treated as scanned images'
            : 'Force Re-OCR — ignore existing text layer and re-scan all pages from scratch (use for badly OCR\'d PDFs)'}
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

// ─── Rotate menu ─────────────────────────────────────────────────────────
// One button + popover that consolidates six rotation actions (this / all /
// selected × CW / CCW) plus the fine-rotation straighten slider. The old
// row of six icons with tiny "ALL" / count badges was cryptic; grouping by
// scope with plain-English labels is much easier to scan.
function RotateMenu({
  onRotateThisCw, rotatingThisCw,
  onRotateThisCcw, rotatingThisCcw,
  onRotateAllCw, rotatingAllCw,
  onRotateAllCcw, rotatingAllCcw,
  onRotateSelectedCw, rotatingSelectedCw,
  onRotateSelectedCcw, rotatingSelectedCcw,
  selectedPdfCount,
  fineRotation, onFineRotationChange,
}: {
  onRotateThisCw: () => void;
  rotatingThisCw: boolean;
  onRotateThisCcw?: () => void;
  rotatingThisCcw?: boolean;
  onRotateAllCw?: () => void;
  rotatingAllCw?: boolean;
  onRotateAllCcw?: () => void;
  rotatingAllCcw?: boolean;
  onRotateSelectedCw?: () => void;
  rotatingSelectedCw?: boolean;
  onRotateSelectedCcw?: () => void;
  rotatingSelectedCcw?: boolean;
  selectedPdfCount: number;
  fineRotation: number;
  onFineRotationChange: (deg: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = fineRotation !== 0 || open;
  const anyBusy = !!(rotatingThisCw || rotatingThisCcw || rotatingAllCw || rotatingAllCcw || rotatingSelectedCw || rotatingSelectedCcw);

  const Row = ({
    icon, label, onClick, busy, disabled,
  }: {
    icon: React.ReactNode; label: string; onClick?: () => void; busy?: boolean; disabled?: boolean;
  }) => (
    <button
      className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-xs text-left transition-colors
                 hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
      disabled={disabled || busy || !onClick}
      onClick={() => { onClick?.(); }}
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> : <span className="shrink-0 text-muted-foreground">{icon}</span>}
      <span className="flex-1">{label}</span>
    </button>
  );

  const SectionLabel = ({ text }: { text: string }) => (
    <p className="text-[10px] uppercase font-semibold text-muted-foreground/80 tracking-wide px-2 pt-2 pb-0.5">
      {text}
    </p>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={`flex items-center gap-0.5 p-1.5 rounded transition-colors shrink-0
                ${active
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
              aria-label="Rotate…"
            >
              {anyBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCw className="w-4 h-4" />}
              <ChevronDown className="w-2.5 h-2.5" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          Rotate {fineRotation !== 0 && `(${fineRotation > 0 ? '+' : ''}${fineRotation}° straighten)`}
        </TooltipContent>
      </Tooltip>

      <PopoverContent align="start" className="w-64 p-1.5">
        <SectionLabel text="This PDF" />
        {onRotateThisCcw && (
          <Row icon={<RotateCcw className="w-3.5 h-3.5" />}
               label="Rotate 90° left" onClick={onRotateThisCcw} busy={rotatingThisCcw} />
        )}
        <Row icon={<RotateCw className="w-3.5 h-3.5" />}
             label="Rotate 90° right" onClick={onRotateThisCw} busy={rotatingThisCw} />

        {(onRotateAllCw || onRotateAllCcw) && (
          <>
            <SectionLabel text="All open PDFs" />
            {onRotateAllCcw && (
              <Row icon={<RotateCcw className="w-3.5 h-3.5" />}
                   label="Rotate all 90° left" onClick={onRotateAllCcw} busy={rotatingAllCcw} />
            )}
            {onRotateAllCw && (
              <Row icon={<RotateCw className="w-3.5 h-3.5" />}
                   label="Rotate all 90° right" onClick={onRotateAllCw} busy={rotatingAllCw} />
            )}
          </>
        )}

        {(onRotateSelectedCw || onRotateSelectedCcw) && selectedPdfCount > 0 && (
          <>
            <SectionLabel text={`Selected (${selectedPdfCount})`} />
            {onRotateSelectedCcw && (
              <Row icon={<RotateCcw className="w-3.5 h-3.5" />}
                   label={`Rotate ${selectedPdfCount} 90° left`}
                   onClick={onRotateSelectedCcw} busy={rotatingSelectedCcw} />
            )}
            {onRotateSelectedCw && (
              <Row icon={<RotateCw className="w-3.5 h-3.5" />}
                   label={`Rotate ${selectedPdfCount} 90° right`}
                   onClick={onRotateSelectedCw} busy={rotatingSelectedCw} />
            )}
          </>
        )}

        {/* Straighten — for skewed scans that a 90° rotate can't fix. */}
        <div className="border-t border-border mt-1 pt-1.5 px-2 pb-1">
          <p className="text-[11px] font-semibold text-foreground mb-1.5 flex items-center gap-1.5">
            <SlidersHorizontal className="w-3 h-3 text-muted-foreground" />
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
          <div className="flex items-center justify-between mt-1">
            <span className="text-[10px] text-muted-foreground">−15°</span>
            <span className="text-[11px] font-mono font-medium text-foreground">
              {fineRotation > 0 ? '+' : ''}{fineRotation}°
            </span>
            <span className="text-[10px] text-muted-foreground">+15°</span>
          </div>
          {fineRotation !== 0 && (
            <button
              className="w-full text-[10px] text-primary hover:underline mt-1"
              onClick={() => onFineRotationChange(0)}
            >
              Reset to 0°
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
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
