import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/TextLayer.css';
import type { PDFSession, Highlight, FieldLabel, ViewerTool } from '@/types/utilscraper';
import ViewerToolbar from './ViewerToolbar';
import HighlightOverlay from './HighlightOverlay';
import FieldLabelPicker from './FieldLabelPicker';
import HighlightLegend from './HighlightLegend';
import { downloadOcrPdf, downloadExcel, fetchTableRegions, extractRegions, searchBackend, extractTableRegion, downloadTableRegionExcel, type SearchMode } from '@/lib/api';
import TableSanitizeDialog from './TableSanitizeDialog';
import { findAllTextPositionsInPdfPage, detectTableRegionsInPdfPage, getTextAtRect } from '@/lib/pdf-extract';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

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
  // Replace the PDF file backing the current session — used after the OCR
  // download finishes so the in-viewer document switches to the searchable
  // copy. The parent owns the session list; this callback hands it the new
  // File so it can update `session.file`.
  onPdfReplaced?: (newFile: File) => void;
  // Apply key-anchored auto-extract pairs to every other open PDF. Index
  // owns the session list so it iterates and calls onHighlightsChange per
  // session itself.
  // Remove all highlights with the given field from every other open PDF /
  // only the selected PDFs. The caller (Index) iterates sessions.
  onRemoveFieldFromAllPdfs?: (field: string) => void;
  onRemoveFieldFromSelectedPdfs?: (field: string) => void;
  // Excel export for the selected (ctrl/cmd-clicked) PDFs — handled by Index.
  onDownloadExcelSelected?: () => Promise<void>;
  // Force Re-OCR
  onForceOcr?: () => void;
  forcingOcr?: boolean;
  // Rotate all pages 90° CW (handled by Index — re-fetches PDF after)
  onRotateAll?: () => void;
  rotatingAll?: boolean;

  onAutoApplyAllPdfs?: (
    pairs: ReadonlyArray<{
      field: string;
      fieldLabel: string;
      sourcePage: number;
      keyText: string;
      offsetX: number;
      offsetY: number;
      valueWidth: number;
      valueHeight: number;
      sourceKeyX: number;
      sourceKeyY: number;
      // When key text couldn't be read, skip the search and place the value
      // box at these absolute normalized coordinates on every target page.
      useAbsoluteCoords?: boolean;
      absoluteValueX?: number;
      absoluteValueY?: number;
    }>,
    tableOnly: boolean,
  ) => void | Promise<void>;
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
  onPdfReplaced,
  onAutoApplyAllPdfs,
  onRemoveFieldFromAllPdfs,
  onRemoveFieldFromSelectedPdfs,
  onDownloadExcelSelected,
  onForceOcr,
  forcingOcr = false,
  onRotateAll,
  rotatingAll = false,
}: PDFViewerProps) {
  // Usage trackers for OCR PDF download + table extraction. Errors are
  // swallowed so a failed telemetry POST never blocks a user action.
  const { trackOcrDownload, trackTableExtract } = useAuth();
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

  // ── Table region selection ────────────────────────────────────────────────
  type TableCell = {
    row: number;
    col: number;
    rowspan: number;
    colspan: number;
    text: string;
  };
  type TablePreview = {
    rows: string[][];
    ncols: number;
    page: number;
    region: { x: number; y: number; width: number; height: number };
    cells?: TableCell[];
    source?: string;
  };
  const [tablePreview, setTablePreview] = useState<TablePreview | null>(null);
  const [tableSelectLoading, setTableSelectLoading] = useState(false);
  // Position + minimize state for the floating preview panel. Initialised
  // to a sensible centre on first open via the useEffect below.
  const [tablePanelPos, setTablePanelPos] = useState<{ x: number; y: number } | null>(null);
  const [tablePanelMinimized, setTablePanelMinimized] = useState(false);
  const tablePanelDragRef = useRef<{ offsetX: number; offsetY: number } | null>(null);
  const [sanitizeOpen, setSanitizeOpen] = useState(false);

  // ── Auto-extract setup mode (replaces the old guided auto-search) ─────
  // Click the magic-wand button to enter setup. The user draws value
  // highlights on the first PDF, then a corresponding KEY (label) box for
  // each. On Apply, the keys are searched on every other page / PDF and
  // the value highlight is propagated to those locations using the
  // captured key-to-value offset.
  const [autoSetupActive, setAutoSetupActive] = useState(false);
  // Controls bar visibility independently of whether setup has been started.
  // The bar can be hidden/shown by clicking the wand icon while pairs exist.
  const [autoBarVisible, setAutoBarVisible] = useState(false);
  // Pairs being collected. Each entry has a value highlight (already
  // labeled with a field) and an optional key highlight that the user
  // draws right after.
  type AutoPair = {
    field: string;
    fieldLabel: string;
    page: number;
    value: { x: number; y: number; width: number; height: number };
    key?:  { x: number; y: number; width: number; height: number };
    keyText?: string;
  };
  const [autoPairs, setAutoPairs] = useState<AutoPair[]>([]);
  // 'value' = next drawn box becomes a new pair's value (label picker shows).
  // 'key'   = next drawn box becomes the key for the most-recent pair w/o a key.
  const [autoNextStep, setAutoNextStep] = useState<'value' | 'key'>('value');

  // When true, only place highlights whose key match falls inside a detected
  // table region — skip keys found in prose / free text areas.
  const [tableOnly, setTableOnly] = useState(false);

  // null = idle; 'pages' = applying to pages; 'pdfs' = applying to all PDFs
  const [applyingTarget, setApplyingTarget] = useState<'pages' | 'pdfs' | null>(null);
  const applyingAuto = applyingTarget !== null;

  // Resolve key text + offset for each pair from the source PDF, then return
  // an "enriched" array. Pairs whose key text is empty / unreadable are
  // dropped so the apply step doesn't waste search calls.
  const resolveAutoPairs = useCallback(async () => {
    if (!session.file) return [];
    console.group('[AutoSearch] resolveAutoPairs — building key→value pairs');
    console.log('pairs to resolve:', autoPairs.length, autoPairs.map(p => p.fieldLabel));
    const out: {
      field: string;
      fieldLabel: string;
      sourcePage: number;
      keyText: string;
      offsetX: number;
      offsetY: number;
      valueWidth: number;
      valueHeight: number;
      sourceKeyX: number;
      sourceKeyY: number;
      useAbsoluteCoords?: boolean;
      absoluteValueX?: number;
      absoluteValueY?: number;
    }[] = [];
    let dropped = 0;
    for (const p of autoPairs) {
      if (!p.key) { console.warn(`  [${p.fieldLabel}] no key box drawn — skipping`); continue; }
      console.group(`  [${p.fieldLabel}] page=${p.page}`);
      console.log('  drawn key box :', p.key);
      console.log('  drawn value box:', p.value);
      let trimmed = '';
      try {
        const text = await getTextAtRect(session.file, p.page, p.key);
        trimmed = (text ?? '').trim();
        console.log('  pdfjs key text :', JSON.stringify(trimmed));
      } catch (err) {
        console.warn('  pdfjs read failed:', err);
      }
      if (!trimmed || trimmed.length < 2) {
        console.log('  pdfjs empty — trying backend OCR...');
        try {
          const ocr = await extractRegions(
            sessionIdRef.current,
            [{
              id: `__autokey_${Date.now()}`,
              page:   p.page,
              field:  '__autokey__',
              x: p.key.x, y: p.key.y, width: p.key.width, height: p.key.height,
            }],
            session.file,
            {
              strict: true,
              onSessionRenewed: (oldId, newId) => {
                sessionIdRef.current = newId;
                onSessionRenewed?.(oldId, newId);
              },
            },
          );
          trimmed = ((ocr[0]?.value ?? '') as string).trim();
          // OCR sometimes renders layered text twice with no separator
          // e.g. "Beginning BalanceBeginning Balance" → "Beginning Balance"
          if (trimmed.length >= 4 && trimmed.length % 2 === 0) {
            const half = trimmed.length / 2;
            if (trimmed.slice(0, half) === trimmed.slice(half)) trimmed = trimmed.slice(0, half).trim();
          }
          console.log('  backend OCR key text:', JSON.stringify(trimmed));
        } catch (err) {
          console.warn('  backend OCR fallback failed:', err);
        }
      }
      if (!trimmed || trimmed.length < 2) {
        // Key text unreadable — keep the pair but flag it for absolute-coordinate
        // placement so the value box still lands on every target page/PDF.
        console.warn('  key unreadable — falling back to absolute coordinates');
        console.groupEnd();
        dropped++;
        out.push({
          field:       p.field,
          fieldLabel:  p.fieldLabel,
          sourcePage:  p.page,
          keyText:     '',
          offsetX:     0,
          offsetY:     0,
          valueWidth:  p.value.width,
          valueHeight: p.value.height,
          sourceKeyX:  p.key.x,
          sourceKeyY:  p.key.y,
          useAbsoluteCoords: true,
          absoluteValueX:    p.value.x,
          absoluteValueY:    p.value.y,
        });
        continue;
      }
      const words = trimmed.split(/\s+/).filter(Boolean);
      // Skip leading purely-numeric tokens (e.g. "75 Debit(s) This Period" → skip "75")
      // so the anchor stays stable across pages where that count changes.
      let anchorStart = 0;
      while (anchorStart < words.length && /^\d+[.,]?\d*$/.test(words[anchorStart])) anchorStart++;
      const anchorWords = words.slice(anchorStart, anchorStart + 4);
      const anchor = (anchorWords.length > 0 ? anchorWords : words.slice(0, 4)).join(' ');
      console.log('  anchor (first 4 words):', JSON.stringify(anchor));

      let keyTextX = p.key.x;
      let keyTextY = p.key.y;
      try {
        const srcMatches = await findAllTextPositionsInPdfPage(session.file, p.page, anchor);
        console.log(`  tight search on source page → ${srcMatches.length} hit(s):`, srcMatches);
        if (srcMatches.length > 0) {
          const boxCx = p.key.x + p.key.width  / 2;
          const boxCy = p.key.y + p.key.height / 2;
          let best = srcMatches[0];
          let bestD = (best.x + best.width / 2 - boxCx) ** 2 + (best.y + best.height / 2 - boxCy) ** 2;
          for (const m of srcMatches) {
            const d = (m.x + m.width / 2 - boxCx) ** 2 + (m.y + m.height / 2 - boxCy) ** 2;
            if (d < bestD) { bestD = d; best = m; }
          }
          keyTextX = best.x;
          keyTextY = best.y;
          console.log('  tight key bbox (closest to drawn box):', best);
        } else {
          console.warn('  tight search found nothing — using drawn box coords for offset');
        }
      } catch (err) {
        console.warn('  tight key position lookup failed:', err);
      }

      const entry = {
        field:       p.field,
        fieldLabel:  p.fieldLabel,
        sourcePage:  p.page,
        keyText:     anchor,
        offsetX:     p.value.x - keyTextX,
        offsetY:     p.value.y - keyTextY,
        valueWidth:  p.value.width,
        valueHeight: p.value.height,
        sourceKeyX:  keyTextX,
        sourceKeyY:  keyTextY,
      };
      console.log('  resolved pair:', entry);
      console.log(`  layout: offsetX=${entry.offsetX.toFixed(3)} offsetY=${entry.offsetY.toFixed(3)}`,
        Math.abs(entry.offsetX) > Math.abs(entry.offsetY) * 2 ? '→ HORIZONTAL' :
        Math.abs(entry.offsetY) > Math.abs(entry.offsetX) * 2 ? '→ VERTICAL'   : '→ DIAGONAL');
      console.groupEnd();
      out.push(entry);
    }
    console.log('resolved pairs:', out.length, '| dropped:', dropped);
    console.groupEnd();
    if (dropped > 0) {
      toast(
        `${dropped} key${dropped !== 1 ? 's' : ''} couldn't be read — placing those fields at original coordinates.`,
        { icon: '⚠️' },
      );
    }
    return out;
  }, [autoPairs, session.file, onSessionRenewed]);

  const exitAutoSetup = useCallback(() => {
    setAutoSetupActive(false);
    setAutoBarVisible(false);
    setAutoPairs([]);
    setAutoNextStep('value');
  }, []);

  // Apply to all pages of THIS PDF — for each pair, find the key text on
  // each page and place the value highlight at the captured offset.
  const handleAutoApplyAllPages = useCallback(async () => {
    if (!session.file) return;
    if (autoPairs.length === 0) {
      toast('Add at least one field first.', { icon: 'ℹ️' });
      return;
    }
    if (autoPairs.some(p => !p.key)) {
      toast('Finish drawing a key for the last field first.', { icon: '⚠️' });
      return;
    }

    setApplyingTarget('pages');
    try {
      const resolved = await resolveAutoPairs();
      if (resolved.length === 0) {
        toast.error('Could not read any key text — try larger key boxes.');
        return;
      }

      const file = session.file;
      const merged: Record<number, Highlight[]> = { ...session.highlights };
      let added = 0;
      let pagesScanned = 0;
      const lastPage = numPages ?? session.total_pages;

      // Pre-cache backend search results per (keyText) so we don't refetch
      // for every page. Each entry is a Map<page, bbox-list> in 0-1 coords.
      const backendByKey = new Map<string, Map<number, { x: number; y: number; width: number; height: number }[]>>();
      const fetchBackendKey = async (q: string) => {
        if (backendByKey.has(q)) return backendByKey.get(q)!;
        const map = new Map<number, { x: number; y: number; width: number; height: number }[]>();
        for (const mode of ['exact', 'partial', 'fuzzy'] as const) {
          // Use sessionIdRef so we pick up any id renewed during resolveAutoPairs.
          // Cap wait at 20 s — a freshly-renewed session won't have its OCR index
          // ready yet; the source-page fallback handles it and the index is cached
          // for the next run.
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 5_000);
          let r: Awaited<ReturnType<typeof searchBackend>>;
          try {
            r = await searchBackend(sessionIdRef.current, q, mode, { signal: ctrl.signal });
          } catch { r = null; } finally { clearTimeout(timer); }
          if (!r || r.results.length === 0) continue;
          for (const m of r.results) {
            const dims = r.page_sizes[String(m.page)];
            if (!dims) continue;
            const arr = map.get(m.page) ?? [];
            for (const [x1, y1, x2, y2] of m.boxes) {
              arr.push({
                x: x1 / dims.width,
                y: y1 / dims.height,
                width:  (x2 - x1) / dims.width,
                height: (y2 - y1) / dims.height,
              });
            }
            map.set(m.page, arr);
          }
          if (map.size > 0) break;
        }
        backendByKey.set(q, map);
        return map;
      };

      // Skip every page that was a source for any pair, not just the first.
      const sourcePages = new Set(resolved.map(r => r.sourcePage));

      // Prefetch all backend keys in parallel before the page loop so we don't
      // block each page on a sequential network round-trip.
      await Promise.all(resolved.filter(r => !r.useAbsoluteCoords).map(r => fetchBackendKey(r.keyText)));

      // Per-page table region cache — detect once per page, reuse across pairs.
      // When tableOnly is on, pre-seed from camelot backend (more accurate than
      // pdfjs text-clustering). Pages absent from the backend response fall back
      // to pdfjs detectTableRegionsInPdfPage.
      const tableCache = new Map<number, Array<{ x: number; y: number; width: number; height: number }>>();
      if (tableOnly) {
        try {
          const backendRegions = await fetchTableRegions(sessionIdRef.current);
          for (const [pg, boxes] of Object.entries(backendRegions)) {
            tableCache.set(Number(pg), boxes);
          }
        } catch {
          // backend unavailable — pdfjs fallback below
        }
      }
      const getTables = async (pg: number) => {
        if (tableCache.has(pg)) return tableCache.get(pg)!;
        const t = await detectTableRegionsInPdfPage(file, pg);
        tableCache.set(pg, t);
        return t;
      };
      const preferInTable = async (
        cands: Array<{ x: number; y: number; width: number; height: number }>,
        pg: number,
      ) => {
        if (cands.length === 0) return null;
        // Skip table detection when there is only one candidate and we are not
        // in table-only mode — no disambiguation needed, saves two worker calls.
        if (cands.length === 1 && !tableOnly) return cands[0];
        const tables = await getTables(pg);
        if (tables.length > 0) {
          const inTable = cands.filter(c =>
            tables.some(t =>
              c.x + c.width  / 2 >= t.x && c.x + c.width  / 2 <= t.x + t.width &&
              c.y + c.height / 2 >= t.y && c.y + c.height / 2 <= t.y + t.height,
            ),
          );
          if (inTable.length > 0) return inTable[0];
        }
        if (tableOnly) return null;
        return cands[0];
      };

      for (let pg = 1; pg <= lastPage; pg++) {
        if (pg % 5 === 0) await new Promise(r => setTimeout(r, 0));
        if (sourcePages.has(pg)) continue;
        pagesScanned++;

        for (const r of resolved) {
          try {
            let x: number, y: number, w: number, h: number;

            if (r.useAbsoluteCoords) {
              if (pg !== r.sourcePage) continue;
              x = r.absoluteValueX!;
              y = r.absoluteValueY!;
              w = r.valueWidth;
              h = r.valueHeight;
            } else {
              // Constrain key search to the region where the key appeared on the
              // source page (±35% X, ±25% Y). Handles layout drift across pages
              // without grabbing a wrong same-named label elsewhere on the page.
              const inSearchRegion = (c: { x: number; y: number; width: number; height: number }) => {
                const cx = c.x + c.width / 2, cy = c.y + c.height / 2;
                return cx >= Math.max(0, r.sourceKeyX - 0.35) && cx <= Math.min(1, r.sourceKeyX + 0.35)
                    && cy >= Math.max(0, r.sourceKeyY - 0.25) && cy <= Math.min(1, r.sourceKeyY + 0.25);
              };
              let match: { x: number; y: number; width: number; height: number } | null = null;
              const map = await fetchBackendKey(r.keyText);
              const backendAll = map.get(pg) ?? [];
              const backendRegion = backendAll.filter(inSearchRegion);
              match = await preferInTable(backendRegion.length > 0 ? backendRegion : backendAll, pg);
              if (!match) {
                const allCands = await findAllTextPositionsInPdfPage(file, pg, r.keyText);
                const regionCands = allCands.filter(inSearchRegion);
                match = await preferInTable(regionCands.length > 0 ? regionCands : allCands, pg);
              }
              // No key found anywhere — place value at the source coordinates on every
              // page so layout drift is handled statically rather than skipping.
              if (!match) {
                x = clamp01(r.sourceKeyX + r.offsetX);
                y = clamp01(r.sourceKeyY + r.offsetY);
                w = r.valueWidth;
                h = r.valueHeight;
              } else {
                x = clamp01(match.x + r.offsetX);
                y = clamp01(match.y + r.offsetY);
                w = Math.min(r.valueWidth,  0.999 - x);
                h = Math.min(r.valueHeight, 0.999 - y);
              }
            }

            if (w <= 0 || h <= 0) continue;
            const hl: Highlight = {
              id: `auto-${Date.now()}-${pg}-${r.field}-${Math.random().toString(36).slice(2, 5)}`,
              page:  pg,
              field: r.field,
              x, y, width: w, height: h,
              isAutoExtracted: true,
            };
            merged[pg] = [...(merged[pg] ?? []), hl];
            added++;
          } catch (err) {
            console.warn('[applyAllPages] place failed:', err);
          }
        }
      }
      onHighlightsChange(session.id, merged);
      if (added > 0) {
        toast.success(`Placed ${added} highlight${added !== 1 ? 's' : ''} across ${pagesScanned} page${pagesScanned !== 1 ? 's' : ''}.`);
      } else {
        toast('No key matches found on other pages.', { icon: 'ℹ️' });
      }
      // Keep banner open so user can also apply to all PDFs, or add more pairs.
    } catch (err) {
      toast.error('Apply failed: ' + (err instanceof Error ? err.message : 'unknown'));
    } finally {
      setApplyingTarget(null);
    }
  }, [
    autoPairs, tableOnly, session.file, session.highlights, session.id, session.total_pages,
    numPages, onHighlightsChange, resolveAutoPairs,
  ]);

  // Apply to all open PDFs — defer to a parent callback so Index.tsx can
  // iterate every other session's File. We pass the already-resolved
  // pairs (key text + offset + value size).
  const handleAutoApplyAllPdfs = useCallback(async () => {
    if (autoPairs.length === 0) {
      toast('Add at least one field first.', { icon: 'ℹ️' });
      return;
    }
    if (autoPairs.some(p => !p.key)) {
      toast('Finish drawing a key for the last field first.', { icon: '⚠️' });
      return;
    }
    if (!onAutoApplyAllPdfs) {
      toast.error('Apply-to-all-PDFs callback not wired up.');
      return;
    }

    setApplyingTarget('pdfs');
    try {
      const resolved = await resolveAutoPairs();
      if (resolved.length === 0) {
        toast.error('Could not read any key text — try larger key boxes.');
        return;
      }
      await onAutoApplyAllPdfs(resolved, tableOnly);
      // Keep banner open — user may still want to Apply to all pages too.
    } catch (err) {
      toast.error('Apply failed: ' + (err instanceof Error ? err.message : 'unknown'));
    } finally {
      setApplyingTarget(null);
    }
  }, [autoPairs, tableOnly, resolveAutoPairs, onAutoApplyAllPdfs]);

  // Magic-wand button — entering setup mode. While setup is active a second
  // click is a no-op; use the Cancel button in the banner to exit.
  const handleAutoSearch = useCallback(() => {
    if (!session.file) { toast.error('PDF file not loaded'); return; }
    if (autoSetupActive) {
      // Already active — toggle the bar's visibility without losing pairs.
      setAutoBarVisible(v => !v);
      return;
    }
    // Fresh start.
    setAutoSetupActive(true);
    setAutoBarVisible(true);
    setAutoPairs([]);
    setAutoNextStep('value');
    setTool('highlight');
    toast(
      'Auto-extract setup: draw a VALUE box, label it, then draw its KEY box.',
      { icon: '✨', duration: 4000 },
    );
  }, [autoSetupActive, session.file]);

  const handleDownloadOcr = useCallback(async () => {
    setDownloadingOcr(true);
    try {
      const { newSessionId, blob, filename } = await downloadOcrPdf(
        session.id, session.filename, session.file,
      );
      if (newSessionId && newSessionId !== session.id) {
        onSessionRenewed?.(session.id, newSessionId);
      }
      // Swap the in-viewer document to the freshly OCR'd copy so that
      // text-select works on the new searchable layer without requiring
      // the user to re-upload.
      if (onPdfReplaced) {
        const ocrFile = new File([blob], filename, { type: 'application/pdf' });
        onPdfReplaced(ocrFile);
      }
      toast.success('OCR\'d PDF downloaded');
      // Bump the per-user OCR-download counter (Odin /pexl/usage).
      // Pass session.uploadedAt + now so the backend records the time
      // span; Errors are swallowed so telemetry never blocks the UX.
      trackOcrDownload(session.uploadedAt, Date.now()).catch(() => {});
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Download failed';
      toast.error(msg);
    }
    setDownloadingOcr(false);
  }, [session.id, session.filename, session.file, session.uploadedAt, onSessionRenewed, onPdfReplaced, trackOcrDownload]);

  const handleDownloadExcel = useCallback(async (pages?: string): Promise<void> => {
    try {
      await downloadExcel(session.id, session.filename, pages);
      toast.success('Excel tables downloaded');
      // "Convert to Table" flow → counts as a table extract.
      trackTableExtract(session.uploadedAt, Date.now()).catch(() => {});
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Excel export failed';
      toast.error(msg);
    }
  }, [session.id, session.filename, session.uploadedAt, trackTableExtract]);

  const pageRefs  = useRef<Record<number, HTMLDivElement | null>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  // Highlight clipboard — stores the templates of copied highlights
  const clipboardRef = useRef<Highlight[] | null>(null);
  // Always-fresh ref for the current page (for paste-anywhere)
  const currentPageRef = useRef<number>(session.startPage || 1);
  // Always-fresh ref for the current backend session_id. Updated immediately
  // when extractRegions detects a stale session and re-uploads the file, so
  // subsequent search calls in the same async flow see the renewed id.
  const sessionIdRef = useRef<string>(session.id);
  useEffect(() => { sessionIdRef.current = session.id; }, [session.id]);
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
      const fitZoom = Math.max(0.3, Math.min(5.0, available / pdfPageWidth));
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

    if (tool === 'cursor' || tool === 'highlight' || tool === 'select' || tool === 'table-select') {
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
    // Table-select mode: extract region as structured table
    if (drawing && drawingPage !== null && tool === 'table-select') {
      const r = { x: drawing.x, y: drawing.y, width: drawing.w, height: drawing.h };
      setDrawing(null); setDrawingPage(null);
      if (r.width > 0.005 && r.height > 0.005) {
        setTableSelectLoading(true);
        try {
          const result = await extractTableRegion(session.id, drawingPage, r.x, r.y, r.width, r.height);
          setTablePreview({ ...result, page: drawingPage, region: r });
          // Open the panel near top-right by default. The user can drag
          // anywhere afterwards; the position persists across re-renders
          // until the panel closes.
          setTablePanelPos({
            x: Math.max(20, window.innerWidth - 720),
            y: 80,
          });
          setTablePanelMinimized(false);
        } catch (err: unknown) {
          toast.error(err instanceof Error ? err.message : 'Table extraction failed');
        } finally {
          setTableSelectLoading(false);
        }
      }
      return;
    }

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

      // Auto-extract setup: when the user is drawing the KEY for the most
      // recent pair, skip the field-label picker entirely. The drawn rect
      // is attached to the latest pair-without-a-key in autoPairs.
      if (autoSetupActive && autoNextStep === 'key') {
        setAutoPairs(prev => {
          for (let i = prev.length - 1; i >= 0; i--) {
            if (!prev[i].key) {
              const next = [...prev];
              next[i] = {
                ...next[i],
                key: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
              };
              return next;
            }
          }
          return prev;
        });
        setAutoNextStep('value');
        setDrawing(null);
        setDrawingPage(null);
        toast('Key captured. Draw the next VALUE box, or click Apply.', { icon: '🔑' });
        return;
      }

      setPickerPos({
        x:    Math.min(px, (el.offsetWidth  ?? 600) - 160),
        y:    Math.min(py, (el.offsetHeight ?? 800) - 200),
        rect,
        page: drawingPage,
      });
      setDrawing(null);
      setDrawingPage(null);
    }
  }, [drawing, drawingPage, tool, session.highlights, session.id, getRelativePos, autoSetupActive, autoNextStep]);

  // -----------------------------------------------------------------------
  // Text-select tool: pure native browser selection.
  //
  // The tool just enables ``renderTextLayer`` on the active page so the
  // transparent glyph spans become hit-testable. Everything else — drag to
  // select, double-click to select a word, triple-click for a line,
  // Ctrl+C to copy to the system clipboard, click elsewhere to deselect —
  // is handled by the browser's built-in selection. No highlight is
  // created, the selection is not cleared on mouseup, and the user can
  // paste the copied text into any other application.
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Label selection — uses pickerPos.page
  // -----------------------------------------------------------------------
  const handleLabelSelect = useCallback(
    (field: FieldLabel, customLabel?: string) => {
      if (!pickerPos) return;
      const pg = pickerPos.page;
      const fieldKey = customLabel ?? field;
      const hl: Highlight = {
        id:     `hl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        page:   pg,
        field:  fieldKey,
        x:      pickerPos.rect.x,
        y:      pickerPos.rect.y,
        width:  pickerPos.rect.w,
        height: pickerPos.rect.h,
        ...(pickerPos.selectedText
          ? { extractedValue: pickerPos.selectedText, confidence: 'high' as const, wasOcr: false }
          : {}),
      };
      const existing = session.highlights[pg] ?? [];
      updateHighlights(pg, [...existing, hl]);
      if (customLabel && customLabel.trim()) {
        onCustomFieldAdd(customLabel.trim());
      }

      // Auto-extract setup: this just-created highlight is the VALUE for
      // a new pair. Record it and prompt the user to draw the KEY box.
      if (autoSetupActive && autoNextStep === 'value') {
        setAutoPairs(prev => [...prev, {
          field: fieldKey,
          fieldLabel: customLabel ?? field,
          page:  pg,
          value: { x: pickerPos.rect.x, y: pickerPos.rect.y,
                   width: pickerPos.rect.w, height: pickerPos.rect.h },
        }]);
        setAutoNextStep('key');
        toast(`Now draw the KEY box (label) for ${customLabel ?? field}`,
              { icon: '🏷️' });
      }

      setPickerPos(null);
      setShowFirstHint(false);
    },
    [pickerPos, session.highlights, updateHighlights, onCustomFieldAdd,
     autoSetupActive, autoNextStep],
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
  const handleApplyToAllPages = useCallback((idsFilter?: Set<string>) => {
    // Always pull from the full session-wide highlight list so highlights
    // drawn on any page (not just the current one) are included in the template.
    const source = idsFilter
      ? allHighlights.filter(h => idsFilter.has(h.id))
      : allHighlights;
    if (source.length === 0) return;
    const next = { ...session.highlights };
    // Skip every page that already contributes a highlight to the source
    // so we don't duplicate highlights on top of themselves.
    const skipPages = new Set<number>(source.map(h => h.page));
    for (let p = 1; p <= totalPages; p++) {
      if (skipPages.has(p)) continue;
      // Append, don't replace — selecting a subset shouldn't wipe other highlights.
      const existing = next[p] ?? [];
      const cloned = source.map(h => ({
        ...h,
        id: `hl-${Date.now()}-${p}-${Math.random().toString(36).slice(2, 6)}`,
        page: p,
        extractedValue: undefined,
        confidence: undefined,
      }));
      next[p] = idsFilter ? [...existing, ...cloned] : cloned;
    }
    onHighlightsChange(session.id, next);
  }, [allHighlights, session, totalPages, onHighlightsChange]);

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

  // Remove all highlights with the same field from every page of THIS PDF.
  const handleRemoveFromAllPages = useCallback((h: Highlight) => {
    const next: Record<number, Highlight[]> = {};
    for (const [pgStr, hls] of Object.entries(session.highlights)) {
      const kept = hls.filter(hl => hl.field !== h.field);
      if (kept.length) next[Number(pgStr)] = kept;
    }
    onHighlightsChange(session.id, next);
  }, [session.highlights, session.id, onHighlightsChange]);

  // Cross-PDF removal delegates up to Index.
  const handleRemoveFromAllPdfs = useCallback((h: Highlight) => {
    onRemoveFieldFromAllPdfs?.(h.field);
  }, [onRemoveFieldFromAllPdfs]);

  const handleRemoveFromSelectedPdfs = useCallback((h: Highlight) => {
    onRemoveFieldFromSelectedPdfs?.(h.field);
  }, [onRemoveFieldFromSelectedPdfs]);

  // Build a per-page subset of session.highlights restricted to ids in the
  // provided set. Used by the "Selected → Apply" popover so the user can
  // mirror only specific highlights to other PDFs.
  const filterHighlightsByIds = useCallback((idsFilter?: Set<string>) => {
    if (!idsFilter) return session.highlights;
    const out: Record<number, Highlight[]> = {};
    for (const [p, hls] of Object.entries(session.highlights)) {
      const kept = hls.filter(h => idsFilter.has(h.id));
      if (kept.length) out[Number(p)] = kept;
    }
    return out;
  }, [session.highlights]);

  const handleApplyToAllPdfs = useCallback((idsFilter?: Set<string>) => {
    const source = filterHighlightsByIds(idsFilter);
    if (Object.values(source).flat().length === 0) return;
    onApplyToAllPdfs(source);
  }, [filterHighlightsByIds, onApplyToAllPdfs]);

  const handleApplyToSelectedPdfs = useCallback((idsFilter?: Set<string>) => {
    if (!onApplyToSelectedPdfs) return;
    const source = filterHighlightsByIds(idsFilter);
    if (Object.values(source).flat().length === 0) return;
    onApplyToSelectedPdfs(source);
  }, [filterHighlightsByIds, onApplyToSelectedPdfs]);

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

  // PageUp / PageDown → previous / next PDF page. Skipped if focus is in
  // an input field so search-bar / label-picker typing isn't broken.
  // Ctrl+PageUp / Ctrl+PageDown is reserved for switching PDF *tabs*
  // (handled at the Index level), so we explicitly opt out when Ctrl is
  // held — otherwise the page scroll fires + preventDefault swallows the
  // event before the tab handler ever sees it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'PageDown' && e.key !== 'PageUp') return;
      // Alt-modified PageUp/PageDown is reserved for PDF *tab* switching
      // (handled at Index level). Ctrl/Meta is also skipped so future
      // shortcuts don't conflict with PDF page scrolling.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable) return;
      }
      e.preventDefault();
      if (e.key === 'PageDown') scrollToPage(currentPage + 1);
      else                       scrollToPage(currentPage - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentPage, scrollToPage]);

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

  // Ctrl+scroll → zoom in / out.
  // Listening on window (not scrollRef.current) so the handler is always
  // registered regardless of render timing. The ref is checked lazily inside
  // the handler so we only zoom when the pointer is over the PDF viewer.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      const container = scrollRef.current;
      if (!container || !container.contains(e.target as Node)) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setZoom(prev => parseFloat(Math.max(0.3, Math.min(5.0, (prev ?? 1) + delta)).toFixed(2)));
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);


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
        hasHighlightsOnPage={allHighlights.length > 0}
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
        allHighlights={allHighlights}
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
        onDownloadExcel={() => handleDownloadExcel()}
        onDownloadExcelSelected={onDownloadExcelSelected}
        onDownloadExcelRange={(range) => handleDownloadExcel(range)}
        onAutoSearch={handleAutoSearch}
        autoSearching={false}
        selectedIds={selectedIds}
        onForceOcr={onForceOcr ?? (() => {})}
        forcingOcr={forcingOcr}
        forceOcrActive={session.forceOcr ?? false}
        onRotateAll={onRotateAll ?? (() => {})}
        rotatingAll={rotatingAll}
      />

      {/* Auto-extract setup banner — visible while setup active AND bar not toggled off */}
      {autoSetupActive && autoBarVisible && (
        <div className="bg-primary/5 border-b border-primary/30 shrink-0 px-3 py-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-semibold text-primary">✨ Auto-extract setup</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-foreground">
              {autoNextStep === 'value'
                ? autoPairs.length === 0
                  ? 'Draw a VALUE box, then label the field.'
                  : 'Draw the next VALUE box, or apply.'
                : `Now draw the KEY (label) box for "${autoPairs[autoPairs.length - 1]?.fieldLabel ?? '…'}".`}
            </span>
            <span className="ml-auto" />
            <button
              onClick={() => setTableOnly(v => !v)}
              disabled={applyingAuto}
              title={tableOnly ? 'Table-only: highlights placed only inside tables' : 'Table-only: off — highlights placed anywhere'}
              className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs border transition-colors
                ${tableOnly
                  ? 'bg-primary/15 border-primary/40 text-primary font-semibold'
                  : 'bg-transparent border-border text-muted-foreground hover:bg-muted'}`}
            >
              ⊞ Tables only
            </button>
            <span className="text-border select-none">|</span>
            <button
              onClick={handleAutoApplyAllPages}
              disabled={autoPairs.length === 0 || applyingAuto}
              className="px-3 py-1 rounded-md bg-primary text-primary-foreground text-xs hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              {applyingTarget === 'pages' ? '⏳ Applying…' : 'Apply to all pages'}
            </button>
            <span className="text-border select-none">|</span>
            <button
              onClick={handleAutoApplyAllPdfs}
              disabled={autoPairs.length === 0 || applyingAuto}
              className="px-3 py-1 rounded-md bg-primary/80 text-primary-foreground text-xs hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              {applyingTarget === 'pdfs' ? '⏳ Applying…' : 'Apply to all PDFs'}
            </button>
            <button
              onClick={() => {
                exitAutoSetup();
                toast('Auto-extract setup cancelled', { icon: 'ℹ️' });
              }}
              disabled={applyingAuto}
              className="px-2 py-1 rounded-md text-xs text-muted-foreground hover:bg-muted transition-colors disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
          {autoPairs.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
              {autoPairs.map((p, i) => (
                <span
                  key={i}
                  className={`inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md border
                    ${p.key
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600'
                      : 'bg-amber-500/10 border-amber-500/30 text-amber-600'}`}
                >
                  {p.fieldLabel} {p.key ? '✓ value + key' : '✓ value · key…'}
                  <button
                    onClick={() => {
                      setAutoPairs(prev => {
                        const next = prev.filter((_, idx) => idx !== i);
                        return next;
                      });
                      // If we were waiting for this pair's key, step back to 'value'.
                      if (!p.key && autoNextStep === 'key') {
                        setAutoNextStep('value');
                      }
                    }}
                    title="Remove this pair"
                    className="ml-0.5 opacity-60 hover:opacity-100 leading-none"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Search bar (Ctrl+F) */}
      {searchOpen && (
        <div className="bg-card border-b border-border shrink-0">
          <div className="px-3 py-1.5 flex items-center gap-2">
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
              onClick={() => {
                setSearchOpen(false); setSearchQuery(''); setSearchResults({});
              }}
            >
              <span className="text-xs">Esc</span>
            </button>
          </div>
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
        {showFirstHint && (tool === 'cursor' || tool === 'highlight') && allHighlights.length === 0 && (
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
                    cursor:     (tool === 'cursor' || tool === 'highlight' || tool === 'table-select') ? 'crosshair' : tool === 'text-select' ? 'text' : 'default',
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
                    canvasBackground="white"
                    loading={
                      <div className="w-[600px] h-[800px] bg-white/5 animate-pulse rounded" />
                    }
                  />

                  {/* Highlights for this page */}
                  <HighlightOverlay
                    highlights={pgHls}
                    drawing={drawingPage === pageNum && drawing && tool !== 'select' && tool !== 'table-select'
                      ? { x: drawing.x, y: drawing.y, w: drawing.w, h: drawing.h }
                      : null}
                    selectionBox={drawingPage === pageNum && drawing && (tool === 'select' || tool === 'table-select')
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
                    onRemoveFromAllPages={handleRemoveFromAllPages}
                    onRemoveFromAllPdfs={onRemoveFieldFromAllPdfs ? handleRemoveFromAllPdfs : undefined}
                    onRemoveFromSelectedPdfs={onRemoveFieldFromSelectedPdfs ? handleRemoveFromSelectedPdfs : undefined}
                    selectedPdfCount={selectedPdfCount}
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

      {/* Table-select loading indicator */}
      {tableSelectLoading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-background rounded-lg px-6 py-4 flex items-center gap-3 shadow-lg text-sm">
            <svg className="w-4 h-4 animate-spin text-primary" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
            </svg>
            Extracting table…
          </div>
        </div>
      )}

      {/* Table region preview — floating, draggable, minimizable panel */}
      {tablePreview && tablePanelPos && (() => {
        const displayRows = tablePreview.rows;
        const displayCells = tablePreview.cells ?? null;
        // Build a (row,col) → cell lookup and a covered-slot set so we know
        // which `<td>`s to skip during rowSpan/colSpan rendering.
        let anchorMap: Map<string, TableCell> | null = null;
        let coveredSlots: Set<string> | null = null;
        let cellRows = 0;
        let cellCols = 0;
        if (displayCells) {
          anchorMap = new Map();
          coveredSlots = new Set();
          for (const c of displayCells) {
            anchorMap.set(`${c.row},${c.col}`, c);
            for (let dr = 0; dr < c.rowspan; dr++) {
              for (let dc = 0; dc < c.colspan; dc++) {
                if (dr !== 0 || dc !== 0) coveredSlots.add(`${c.row + dr},${c.col + dc}`);
              }
            }
            cellRows = Math.max(cellRows, c.row + c.rowspan);
            cellCols = Math.max(cellCols, c.col + c.colspan);
          }
        }

        // ── Drag handlers ───────────────────────────────────────────────
        const onHeaderMouseDown = (e: React.MouseEvent) => {
          // Ignore drags that started on a button inside the header
          if ((e.target as HTMLElement).closest('button')) return;
          tablePanelDragRef.current = {
            offsetX: e.clientX - tablePanelPos.x,
            offsetY: e.clientY - tablePanelPos.y,
          };
          const onMove = (ev: MouseEvent) => {
            if (!tablePanelDragRef.current) return;
            const x = ev.clientX - tablePanelDragRef.current.offsetX;
            const y = ev.clientY - tablePanelDragRef.current.offsetY;
            setTablePanelPos({
              x: Math.max(0, Math.min(window.innerWidth - 200, x)),
              y: Math.max(0, Math.min(window.innerHeight - 40,  y)),
            });
          };
          const onUp = () => {
            tablePanelDragRef.current = null;
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup',   onUp);
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup',   onUp);
        };

        // ── Build HTML + TSV strings for clipboard copy ────────────────
        const buildClipboardPayload = (): { html: string; tsv: string } => {
          const tsvRows: string[] = [];
          const htmlRows: string[] = [];
          if (displayCells && anchorMap && coveredSlots) {
            for (let ri = 0; ri < cellRows; ri++) {
              const tsvCells: string[] = [];
              const htmlCells: string[] = [];
              for (let ci = 0; ci < cellCols; ci++) {
                if (coveredSlots.has(`${ri},${ci}`)) continue;
                const cell = anchorMap.get(`${ri},${ci}`);
                const text = cell?.text ?? '';
                tsvCells.push(text.replace(/\t/g, ' ').replace(/\n/g, ' '));
                const rs = cell?.rowspan && cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : '';
                const cs = cell?.colspan && cell.colspan > 1 ? ` colspan="${cell.colspan}"` : '';
                htmlCells.push(`<td${rs}${cs}>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</td>`);
              }
              tsvRows.push(tsvCells.join('\t'));
              htmlRows.push(`<tr>${htmlCells.join('')}</tr>`);
            }
          } else {
            for (const row of displayRows) {
              tsvRows.push(row.map(c => String(c ?? '').replace(/\t/g, ' ').replace(/\n/g, ' ')).join('\t'));
              htmlRows.push('<tr>' + row.map(c => `<td>${String(c ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</td>`).join('') + '</tr>');
            }
          }
          return {
            tsv:  tsvRows.join('\n'),
            html: `<table border="1" cellspacing="0" cellpadding="2">${htmlRows.join('')}</table>`,
          };
        };

        const onCopy = async () => {
          const { html, tsv } = buildClipboardPayload();
          try {
            if (navigator.clipboard && 'write' in navigator.clipboard && typeof ClipboardItem !== 'undefined') {
              await navigator.clipboard.write([
                new ClipboardItem({
                  'text/html':  new Blob([html], { type: 'text/html' }),
                  'text/plain': new Blob([tsv],  { type: 'text/plain' }),
                }),
              ]);
            } else {
              await navigator.clipboard.writeText(tsv);
            }
            toast.success('Table copied — paste into Excel');
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Copy failed');
          }
        };

        return (
          <div
            className="fixed z-50 bg-background/90 backdrop-blur-sm rounded-xl shadow-2xl border flex flex-col"
            style={{
              left: tablePanelPos.x,
              top:  tablePanelPos.y,
              maxWidth:  '85vw',
              maxHeight: tablePanelMinimized ? undefined : '70vh',
              minWidth:  280,
              opacity:   0.95,
            }}
          >
            {/* Header — draggable; clicks on buttons inside are exempted */}
            <div
              onMouseDown={onHeaderMouseDown}
              className="flex items-center justify-between px-4 py-2 border-b gap-3 cursor-move select-none bg-muted/60 rounded-t-xl"
            >
              <span className="font-semibold text-sm shrink-0">
                Table — Page {tablePreview.page}
              </span>
              <div className="flex items-center gap-1.5 flex-wrap justify-end">
                <button
                  className="text-xs px-2 py-1 rounded-md font-medium border bg-background hover:bg-muted"
                  onClick={onCopy}
                  title="Copy the table to the clipboard (paste into Excel preserves the layout)"
                >
                  Copy
                </button>
                <button
                  className="text-xs px-2 py-1 rounded-md font-medium border bg-background hover:bg-muted"
                  onClick={() => setSanitizeOpen(true)}
                  title="Find similar / misspelled values and merge them"
                >
                  Sanitize
                </button>
                <button
                  className="text-xs bg-primary text-primary-foreground px-2.5 py-1 rounded-md font-medium hover:bg-primary/90"
                  onClick={async () => {
                    try {
                      // Build flat rows from cells (respects sanitized state) or use rows directly
                      const exportRows: string[][] = displayCells && anchorMap
                        ? Array.from({ length: cellRows }, (_, ri) =>
                            Array.from({ length: cellCols }, (_, ci) => {
                              if (coveredSlots!.has(`${ri},${ci}`)) return '';
                              return anchorMap!.get(`${ri},${ci}`)?.text ?? '';
                            })
                          )
                        : displayRows.map(r => r.map(c => String(c ?? '')));
                      await downloadTableRegionExcel(
                        session.id, tablePreview.page,
                        tablePreview.region.x, tablePreview.region.y,
                        tablePreview.region.width, tablePreview.region.height,
                        session.filename.replace(/\.[^.]+$/, '') + `_region_p${tablePreview.page}.xlsx`,
                        exportRows,
                      );
                      // Region Excel export counts as a table extract too.
                      trackTableExtract(session.uploadedAt, Date.now()).catch(() => {});
                    } catch (err: unknown) {
                      toast.error(err instanceof Error ? err.message : 'Export failed');
                    }
                  }}
                >
                  Export Excel
                </button>
                <button
                  className="text-xs px-2 py-1 rounded-md font-medium border bg-background hover:bg-muted"
                  onClick={() => setTablePanelMinimized(m => !m)}
                  title={tablePanelMinimized ? 'Restore panel' : 'Minimize panel (data preserved)'}
                >
                  {tablePanelMinimized ? '▢' : '–'}
                </button>
                <button
                  className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-md"
                  onClick={() => setTablePreview(null)}
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Body — hidden when minimized; data stays in state */}
            {!tablePanelMinimized && (
              <div className="overflow-auto p-3">
                <table className="text-xs border-collapse" style={{ tableLayout: 'auto' }}>
                  <tbody>
                    {displayCells && anchorMap && coveredSlots ? (
                      Array.from({ length: cellRows }, (_, ri) => {
                        const isHeaderRow = ri === 0;
                        const rowBg = isHeaderRow ? '' : ri % 2 === 1 ? 'bg-muted/30' : '';
                        return (
                          <tr key={ri} className={rowBg}>
                            {Array.from({ length: cellCols }, (_, ci) => {
                              if (coveredSlots!.has(`${ri},${ci}`)) return null;
                              const cell = anchorMap!.get(`${ri},${ci}`);
                              const text = cell?.text ?? '';
                              return (
                                <td
                                  key={ci}
                                  rowSpan={cell?.rowspan && cell.rowspan > 1 ? cell.rowspan : undefined}
                                  colSpan={cell?.colspan && cell.colspan > 1 ? cell.colspan : undefined}
                                  className={
                                    'border border-border px-2 py-1 align-top ' +
                                    (isHeaderRow ? 'bg-primary/10 font-semibold ' : '') +
                                    'whitespace-pre-wrap break-words'
                                  }
                                  style={{ minWidth: 60, maxWidth: 320 }}
                                >
                                  {text}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })
                    ) : (
                      displayRows.map((row, ri) => {
                        const isHeaderRow = ri === 0;
                        const rowBg = isHeaderRow
                          ? ''
                          : ri % 2 === 1
                            ? 'bg-muted/30'
                            : '';
                        return (
                          <tr key={ri} className={rowBg}>
                            {row.map((cell, ci) => (
                              <td
                                key={ci}
                                className={
                                  'border border-border px-2 py-1 align-top ' +
                                  (isHeaderRow ? 'bg-primary/10 font-semibold ' : '') +
                                  'whitespace-pre-wrap break-words'
                                }
                                style={{ minWidth: 60, maxWidth: 320 }}
                              >
                                {cell}
                              </td>
                            ))}
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })()}

      {/* Table sanitize dialog */}
      {sanitizeOpen && tablePreview && (
        <TableSanitizeDialog
          rows={
            tablePreview.cells
              ? (() => {
                  const maxRow = Math.max(...tablePreview.cells.map(c => c.row + c.rowspan));
                  const maxCol = Math.max(...tablePreview.cells.map(c => c.col + c.colspan));
                  const grid: string[][] = Array.from({ length: maxRow }, () => Array(maxCol).fill(''));
                  for (const c of tablePreview.cells) grid[c.row][c.col] = c.text;
                  return grid;
                })()
              : tablePreview.rows
          }
          onCancel={() => setSanitizeOpen(false)}
          onConfirm={(replacements) => {
            setSanitizeOpen(false);
            if (Object.keys(replacements).length === 0) return;
            const applyReplace = (text: string) => replacements[text] ?? text;
            setTablePreview(prev => {
              if (!prev) return prev;
              const rows = prev.rows.map(row => row.map(applyReplace));
              const cells = prev.cells?.map(c => ({ ...c, text: applyReplace(c.text) }));
              return { ...prev, rows, cells };
            });
          }}
        />
      )}
    </div>
  );
}
