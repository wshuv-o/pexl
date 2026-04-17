import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, Wand2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import DualUpload from '@/components/automap/DualUpload';
import MappingReview, { type MappingState } from '@/components/automap/MappingReview';
import AutoHighlightViewer from '@/components/automap/AutoHighlightViewer';
import LiveExcelPreview from '@/components/automap/LiveExcelPreview';

import { readSourceExcel, type SourceExcel } from '@/lib/automap/excel-reader';
import { autoMatch, type HeaderMatch } from '@/lib/automap/auto-match';
import { matchHeadersBackend } from '@/lib/automap/api';
import { writeValuesToWorkbook, workbookToBlob, downloadBlob } from '@/lib/automap/excel-writer';
import { buildInitialMappings } from '@/lib/automap/header-mapping';
import { processFile } from '@/lib/api';
import type { FieldLabel, DocumentType } from '@/types/utilscraper';

// ───────────────────────────────────────────────────────────────────────────
// Auto-map page: Source PDF + Source output Excel → read headers → rule-based
// match PDF text to each header → user walks pages, confirms per-highlight or
// per-page → live Excel preview fills the chosen row → download workbook with
// original styles preserved.
// ───────────────────────────────────────────────────────────────────────────
export default function AutoMap() {
  const navigate = useNavigate();

  const [docType,   setDocType]   = useState<DocumentType | null>(null);
  const [pdfFiles,  setPdfFiles]  = useState<File[]>([]);
  const [activePdfIdx, setActivePdfIdx] = useState(0);
  const [excelFile, setExcelFile] = useState<File | null>(null);
  const [leftWidth,  setLeftWidth]  = useState(340);   // px — drag to resize
  const [rightWidth, setRightWidth] = useState(520);   // px — drag to resize
  const [source,    setSource]    = useState<SourceExcel | null>(null);
  // Backend session for the currently-active PDF. Used by onFieldRemap to
  // run a single-header match whenever the user picks a canonical field.
  // Null = never successfully processed the PDF on the backend; we fall
  // back to client-side autoMatch in that case.
  const [sessionId,  setSessionId]   = useState<string | null>(null);
  // Latched once the backend /api/automap/match endpoint has failed, so we
  // stop spamming the server and the user with repeated fallback toasts.
  const [backendMatchDown, setBackendMatchDown] = useState(false);
  const [mappings,   setMappings]    = useState<MappingState[]>([]);
  const [activeHeader, setActiveHeader] = useState<string | null>(null);
  const [targetRow0,   setTargetRow0]   = useState(0);
  const [targetAuto,   setTargetAuto]   = useState<number | null>(null); // set by key-field row matching
  // The Excel column whose extracted value identifies which row to write
  // to. When set, each PDF's key-field match value is looked up in that
  // column of source.rows and targetRow0 is pointed at the matching row.
  const [rowKeyHeader, setRowKeyHeader] = useState<string | null>(null);
  const [running,      setRunning]      = useState(false);
  const [progress,     setProgress]     = useState<{ label: string; done: number; total: number } | null>(null);

  const activePdf = pdfFiles[activePdfIdx] ?? null;

  // Upload + OCR a single PDF on the backend, return its session id.
  // Null means the backend path failed — caller should fall back to the
  // client-side autoMatch() function for that PDF.
  const uploadPdf = useCallback(async (pdf: File): Promise<string | null> => {
    try {
      setProgress({ label: 'Uploading PDF & running OCR', done: 0, total: 1 });
      const processed = await processFile(pdf, '', (step, detail) => {
        setProgress({ label: detail || 'Processing PDF', done: step, total: 3 });
      });
      return processed.session_id;
    } catch (err) {
      console.warn('[auto-map] backend upload failed, will match client-side:', err);
      return null;
    }
  }, []);

  // Run a one-header PDF match. Tries the backend first when a session is
  // available; on ANY backend failure (404, 500, network error, …) falls
  // through to the client-side autoMatch so the feature keeps working
  // even if `/api/automap/match` isn't deployed.
  const matchOneHeader = useCallback(async (
    pdf: File,
    session: string | null,
    searchTerm: string,
  ): Promise<HeaderMatch | null> => {
    // 1. Backend path — only if we have a session AND haven't already
    //    observed that the endpoint is down in this session.
    if (session && !backendMatchDown) {
      try {
        setProgress({ label: `Matching "${searchTerm}" on the server`, done: 0, total: 1 });
        const [hit] = await matchHeadersBackend(session, [searchTerm]);
        setProgress(null);
        return hit ?? null;
      } catch (err) {
        const msg = (err as Error).message || String(err);
        console.warn(`[auto-map] backend match failed for "${searchTerm}", falling back client-side:`, err);
        setBackendMatchDown(true);
        // Show the user a single actionable toast, not one per header.
        if (msg.includes('404')) {
          toast.warning('Backend /api/automap/match not found (404) — matching locally. Deploy the endpoint to use server-side matching.');
        } else {
          toast.warning(`Backend match failed — matching locally. (${msg.slice(0, 120)})`);
        }
      }
    }

    // 2. Client fallback — always try, even if the backend just failed.
    try {
      setProgress({ label: `Matching "${searchTerm}" locally`, done: 0, total: 1 });
      const [hit] = await autoMatch(pdf, [searchTerm]);
      return hit ?? null;
    } catch (err) {
      console.warn(`[auto-map] client match for "${searchTerm}" failed:`, err);
      return null;
    } finally {
      setProgress(null);
    }
  }, [backendMatchDown]);

  const start = useCallback(async () => {
    if (pdfFiles.length === 0 || !excelFile) return;
    setRunning(true);
    try {
      // ── Step 1: read Excel headers once (shared across all PDFs) ──────
      const src = await readSourceExcel(excelFile);
      if (src.headers.length === 0) throw new Error('No headers found in the first row of the Excel sheet.');
      setSource(src);

      // ── Step 2: upload the first queued PDF so OCR runs. No automatic
      //    field mapping, no automatic PDF matching — the user picks
      //    canonical fields one at a time via the dropdown, which fires
      //    a per-header match via onFieldRemap().
      setActivePdfIdx(0);
      const sid = await uploadPdf(pdfFiles[0]);
      setSessionId(sid);

      const fieldMaps = buildInitialMappings(src.headers);
      setMappings(fieldMaps.map(fm => ({
        mapping:  fm,
        match:    { header: fm.excelHeader, box: null, alternatives: [] },
        status:   'pending' as const,
        included: false,     // opt-in; user checks the ones they need
      })));
      setActiveHeader(fieldMaps[0]?.excelHeader ?? null);

      toast.success(`Read ${src.headers.length} Excel header${src.headers.length !== 1 ? 's' : ''}. Set the canonical field and the exact PDF search phrase for each.`);
    } catch (err) {
      const msg = (err as Error).message || 'Unknown error';
      toast.error(msg);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, [pdfFiles, excelFile, uploadPdf]);

  const patchMapping = useCallback((excelHeader: string, patch: Partial<MappingState>) => {
    setMappings(prev => prev.map(m =>
      m.mapping.excelHeader === excelHeader ? { ...m, ...patch } : m,
    ));
  }, []);

  const onConfirmHeader = useCallback((excelHeader: string, value?: string) => {
    patchMapping(excelHeader, {
      status: 'confirmed',
      ...(value !== undefined ? { override: value } : {}),
    });
    // Auto-advance to next pending mapping for a fluid confirm flow.
    setMappings(prev => {
      const idx = prev.findIndex(m => m.mapping.excelHeader === excelHeader);
      const next = prev.slice(idx + 1).find(m => m.status === 'pending');
      if (next) setActiveHeader(next.mapping.excelHeader);
      return prev;
    });
  }, [patchMapping]);

  const onRejectHeader = useCallback((excelHeader: string) => {
    patchMapping(excelHeader, { status: 'rejected' });
  }, [patchMapping]);

  // Opt-in toggle — only included rows participate in matching + download.
  const onToggleIncluded = useCallback((excelHeader: string, included: boolean) => {
    setMappings(prev => prev.map(m =>
      m.mapping.excelHeader === excelHeader ? { ...m, included } : m,
    ));
    if (!included && activeHeader === excelHeader) setActiveHeader(null);
  }, [activeHeader]);

  const onIncludeAll = useCallback((included: boolean) => {
    setMappings(prev => prev.map(m => ({ ...m, included })));
    if (!included) setActiveHeader(null);
  }, []);

  // Mark a column as the row-identifier. Unsetting clears the auto-target,
  // so the manual row picker in the right panel takes over again.
  const onSetRowKey = useCallback((excelHeader: string | null) => {
    setRowKeyHeader(excelHeader);
    if (!excelHeader) setTargetAuto(null);
  }, []);

  // Whenever a mapping's match settles, if it is the row-key, look its
  // value up in the corresponding column of the source Excel. First row
  // where the trimmed, case-insensitive cell value equals the extracted
  // value wins. Miss → keep the manual row pick.
  useEffect(() => {
    if (!source || !rowKeyHeader) { setTargetAuto(null); return; }
    const km = mappings.find(m => m.mapping.excelHeader === rowKeyHeader);
    const value = km?.override ?? km?.chosenBox?.value ?? km?.match.box?.value ?? '';
    if (!value.trim()) { setTargetAuto(null); return; }
    const colIdx = source.headers.indexOf(rowKeyHeader);
    if (colIdx < 0) { setTargetAuto(null); return; }
    const needle = value.trim().toLowerCase();
    const rowIdx = source.rows.findIndex(r => (r[colIdx] ?? '').trim().toLowerCase() === needle);
    setTargetAuto(rowIdx >= 0 ? rowIdx : null);
  }, [source, rowKeyHeader, mappings]);

  // Effective target row: auto-resolved via the key field if available,
  // otherwise the user's manual pick.
  const effectiveTargetRow = targetAuto ?? targetRow0;

  const onEditHeader = useCallback((excelHeader: string, value: string) => {
    patchMapping(excelHeader, { override: value });
  }, [patchMapping]);

  const onApplyToPageAll = useCallback((page: number, status: 'confirmed' | 'rejected') => {
    setMappings(prev => prev.map(m => {
      const b = m.chosenBox ?? m.match.box;
      if (b && b.page === page && m.status === 'pending') return { ...m, status };
      return m;
    }));
    toast.success(`${status === 'confirmed' ? 'Confirmed' : 'Rejected'} all mappings on page ${page}`);
  }, []);

  // Canonical-field dropdown change — pure metadata (used for Excel
  // normalization and the UI pill). Does NOT trigger a PDF search; that's
  // driven separately by the "search text" input below (onSearchTextChange).
  const onFieldRemap = useCallback((
    excelHeader: string,
    fieldKey: FieldLabel | null,
    fieldLabel: string | null,
  ) => {
    setMappings(prev => prev.map(m =>
      m.mapping.excelHeader === excelHeader
        ? { ...m, mapping: { ...m.mapping, fieldKey, fieldLabel } }
        : m,
    ));
  }, []);

  // User committed a new exact-search phrase for a header (blur/Enter in
  // the third-column input). Store it, then run a one-header PDF match
  // against the current active PDF using that exact phrase.
  const onSearchTextChange = useCallback(async (excelHeader: string, searchText: string) => {
    setMappings(prev => prev.map(m =>
      m.mapping.excelHeader === excelHeader
        ? {
            ...m,
            mapping: { ...m.mapping, searchText },
            // Clear previous match so stale values don't hang around.
            match:   { header: excelHeader, box: null, alternatives: [] },
            override: undefined,
            chosenBox: undefined,
            status:  'pending' as const,
          }
        : m,
    ));

    // Don't run a PDF search for excluded rows, even if they have text.
    const isIncluded = mappings.find(m => m.mapping.excelHeader === excelHeader)?.included;
    if (!searchText.trim() || !activePdf || !isIncluded) return;
    const hit = await matchOneHeader(activePdf, sessionId, searchText.trim());
    if (!hit) return;
    setMappings(prev => prev.map(m =>
      m.mapping.excelHeader === excelHeader ? { ...m, match: hit } : m,
    ));
    setActiveHeader(excelHeader);
  }, [activePdf, sessionId, mappings, matchOneHeader]);

  // Re-run the PDF match for every header that has a non-empty search
  // phrase. Useful after switching PDFs or when the user wants to force
  // a refresh.
  const onRematchAll = useCallback(async () => {
    if (!activePdf) return;
    setRunning(true);
    try {
      for (const m of mappings) {
        if (!m.included) continue;
        const q = m.mapping.searchText.trim();
        if (!q) continue;
        const hit = await matchOneHeader(activePdf, sessionId, q);
        setMappings(curr => curr.map(x =>
          x.mapping.excelHeader === m.mapping.excelHeader
            ? {
                ...x,
                match: hit ?? { header: x.mapping.excelHeader, box: null, alternatives: [] },
                status: 'pending' as const,
                override: undefined,
                chosenBox: undefined,
              }
            : x,
        ));
      }
      toast.success('Re-ran all configured searches against the current PDF.');
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, [activePdf, sessionId, mappings, matchOneHeader]);

  const onDownload = useCallback(() => {
    if (!source) return;
    // Only confirmed values go into the sheet. (Edited-but-not-confirmed
    // stays out; confirmed-with-edit uses the override.)
    const values: Record<string, string> = {};
    for (const m of mappings) {
      if (!m.included) continue;
      if (m.status !== 'confirmed') continue;
      const v = m.override ?? m.chosenBox?.value ?? m.match.box?.value ?? '';
      values[m.mapping.excelHeader] = v;
    }
    if (Object.keys(values).length === 0) {
      toast.warning('Confirm at least one mapping before downloading.');
      return;
    }
    const wb = writeValuesToWorkbook({ source, rowIndex0: effectiveTargetRow, values });
    const blob = workbookToBlob(wb);
    const outName = (excelFile?.name || 'output').replace(/\.[^.]+$/, '') + `_filled_row${effectiveTargetRow + 1}.xlsx`;
    downloadBlob(blob, outName);
  }, [source, mappings, effectiveTargetRow, excelFile]);

  // Advance to the next queued PDF: upload it, reset confirmations, bump
  // the target row. User's header→field mappings are preserved; each
  // already-mapped header is re-matched against the new PDF's text.
  const goNextPdf = useCallback(async () => {
    if (!source) return;
    const nextIdx = activePdfIdx + 1;
    if (nextIdx >= pdfFiles.length) {
      toast.info('No more PDFs in the queue.');
      return;
    }
    setRunning(true);
    try {
      setActivePdfIdx(nextIdx);
      setTargetRow0(r => r + 1);

      const pdf = pdfFiles[nextIdx];
      const sid = await uploadPdf(pdf);
      setSessionId(sid);

      // Preserve existing header→field mapping AND the user's include
      // selection; only the match result / confirmation status resets.
      const prev = mappings;
      setMappings(prev.map(m => ({
        mapping:  m.mapping,
        included: m.included,
        match:    { header: m.mapping.excelHeader, box: null, alternatives: [] },
        status:   'pending' as const,
      })));

      let found = 0;
      for (const m of prev) {
        if (!m.included) continue;          // skip excluded rows
        const q = m.mapping.searchText.trim();
        if (!q) continue;
        const hit = await matchOneHeader(pdf, sid, q);
        if (hit) {
          found++;
          setMappings(curr => curr.map(x =>
            x.mapping.excelHeader === m.mapping.excelHeader ? { ...x, match: hit } : x,
          ));
        }
      }
      toast.success(`PDF ${nextIdx + 1} / ${pdfFiles.length}: ${found} values found`);
    } catch (err) {
      toast.error((err as Error).message || 'Failed to process next PDF');
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, [source, activePdfIdx, pdfFiles, mappings, uploadPdf, matchOneHeader]);

  const hasData = !!source;

  // If mappings change, keep the viewer reference in sync with matches order.
  const viewerMappings = useMemo(() => mappings, [mappings]);

  return (
    <div className="h-screen flex flex-col bg-background">
      <header className="h-12 bg-card border-b border-border flex items-center px-4 gap-3 shrink-0">
        <button
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => navigate('/')}
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back to main
        </button>
        <div className="h-5 w-px bg-border" />
        <div className="flex items-center gap-2">
          <Wand2 className="w-4 h-4 text-primary" />
          <h1 className="text-sm font-bold">Auto-map · PDF → Excel template</h1>
          {pdfFiles.length > 1 && (
            <span className="text-[11px] text-muted-foreground ml-2 px-2 py-0.5 rounded bg-muted">
              PDF {activePdfIdx + 1} / {pdfFiles.length} · {activePdf?.name}
            </span>
          )}
        </div>
        {progress && (
          <span className="ml-auto text-[11px] text-muted-foreground">
            {progress.label}{progress.total > 1 ? ` · ${progress.done + 1} / ${progress.total}` : '…'}
          </span>
        )}
        {hasData && pdfFiles.length > 1 && activePdfIdx < pdfFiles.length - 1 && (
          <button
            className="ml-auto text-xs font-medium text-primary hover:underline disabled:opacity-40"
            disabled={running}
            onClick={goNextPdf}
          >
            Next PDF →
          </button>
        )}
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Left rail — uploads + mapping list (drag the handle to its right to resize) */}
        <aside
          className="shrink-0 border-r border-border flex flex-col bg-card"
          style={{ width: `${leftWidth}px` }}
        >
          {!hasData ? (
            <div className="p-4">
              <DualUpload
                docType={docType}
                onDocTypeChange={setDocType}
                pdfFiles={pdfFiles}
                excelFile={excelFile}
                onPdfsChange={setPdfFiles}
                onExcelChange={setExcelFile}
                onStart={start}
                running={running}
              />
              <div className="mt-6 p-3 rounded-lg bg-primary/5 border border-primary/20">
                <p className="text-[11px] font-semibold text-primary mb-1">How it works</p>
                <ol className="text-[11px] text-primary/80 space-y-1 list-decimal list-inside leading-relaxed">
                  <li>Pick the source PDF + the output Excel template</li>
                  <li>Headers are read from row 1 of the first sheet</li>
                  <li>Each header is matched against labels in the PDF</li>
                  <li>Walk the pages, confirm or edit each highlight</li>
                  <li>Pick the target row, download the filled workbook</li>
                </ol>
              </div>
            </div>
          ) : (
            <MappingReview
              mappings={viewerMappings}
              docType={docType}
              activeHeader={activeHeader}
              rowKeyHeader={rowKeyHeader}
              onSelect={setActiveHeader}
              onFieldRemap={onFieldRemap}
              onSearchTextChange={onSearchTextChange}
              onToggleIncluded={onToggleIncluded}
              onIncludeAll={onIncludeAll}
              onSetRowKey={onSetRowKey}
              onRematchAll={onRematchAll}
              matching={running}
            />
          )}
        </aside>

        {/* Resize handle for left rail */}
        <div
          className="w-1 bg-border hover:bg-primary cursor-col-resize shrink-0 relative"
          onMouseDown={e => {
            e.preventDefault();
            const startX = e.clientX;
            const startW = leftWidth;
            const onMove = (ev: MouseEvent) => {
              const next = Math.max(240, Math.min(640, startW + (ev.clientX - startX)));
              setLeftWidth(next);
            };
            const onUp = () => {
              window.removeEventListener('mousemove', onMove);
              window.removeEventListener('mouseup', onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
          }}
        >
          <div className="absolute inset-y-0 -left-1 -right-1" />
        </div>

        {/* Center — PDF viewer */}
        <main className="flex-1 overflow-hidden min-w-0">
          {hasData && activePdf ? (
            <AutoHighlightViewer
              key={activePdfIdx}
              file={activePdf}
              mappings={viewerMappings}
              activeHeader={activeHeader}
              onConfirmHeader={onConfirmHeader}
              onRejectHeader={onRejectHeader}
              onEditHeader={onEditHeader}
              onApplyToPageAll={onApplyToPageAll}
            />
          ) : (
            <EmptyCenter />
          )}
        </main>

        {/* Resize handle for right rail */}
        <div
          className="w-1 bg-border hover:bg-primary cursor-col-resize shrink-0 relative"
          onMouseDown={e => {
            e.preventDefault();
            const startX = e.clientX;
            const startW = rightWidth;
            const onMove = (ev: MouseEvent) => {
              const next = Math.max(320, Math.min(1100, startW - (ev.clientX - startX)));
              setRightWidth(next);
            };
            const onUp = () => {
              window.removeEventListener('mousemove', onMove);
              window.removeEventListener('mouseup', onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
          }}
        >
          <div className="absolute inset-y-0 -left-1 -right-1" />
        </div>

        {/* Right rail — live Excel preview */}
        <aside
          className="shrink-0 border-l border-border"
          style={{ width: `${rightWidth}px` }}
        >
          {hasData && source ? (
            <LiveExcelPreview
              source={source}
              mappings={viewerMappings}
              targetRow0={effectiveTargetRow}
              autoTargetFromKey={targetAuto !== null}
              onTargetRowChange={r => { setTargetAuto(null); setTargetRow0(r); }}
              onDownload={onDownload}
            />
          ) : (
            <EmptyRight />
          )}
        </aside>
      </div>
    </div>
  );
}

function EmptyCenter() {
  return (
    <div className="h-full flex items-center justify-center text-center px-6">
      <div>
        <Wand2 className="w-10 h-10 mx-auto text-primary/40 mb-3" />
        <p className="text-sm font-semibold text-foreground/70">Pick a PDF + Excel and click Auto-match</p>
        <p className="text-xs text-muted-foreground mt-1">
          The PDF will render here with one highlight per Excel header.
        </p>
      </div>
    </div>
  );
}

function EmptyRight() {
  return (
    <div className="h-full flex items-center justify-center text-center px-6 bg-muted/20">
      <p className="text-xs text-muted-foreground">
        The live Excel preview appears once the workbook is loaded.
      </p>
    </div>
  );
}
