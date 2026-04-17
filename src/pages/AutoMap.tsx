import { useCallback, useMemo, useState } from 'react';
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
import { buildInitialMappings, type HeaderToField } from '@/lib/automap/header-mapping';
import { processFile } from '@/lib/api';
import type { FieldLabel } from '@/types/utilscraper';

// ───────────────────────────────────────────────────────────────────────────
// Auto-map page: Source PDF + Source output Excel → read headers → rule-based
// match PDF text to each header → user walks pages, confirms per-highlight or
// per-page → live Excel preview fills the chosen row → download workbook with
// original styles preserved.
// ───────────────────────────────────────────────────────────────────────────
export default function AutoMap() {
  const navigate = useNavigate();

  const [pdfFiles,  setPdfFiles]  = useState<File[]>([]);
  const [activePdfIdx, setActivePdfIdx] = useState(0);
  const [excelFile, setExcelFile] = useState<File | null>(null);
  const [leftWidth,  setLeftWidth]  = useState(320);   // px — drag to resize
  const [rightWidth, setRightWidth] = useState(520);   // px — drag to resize
  const [source,    setSource]    = useState<SourceExcel | null>(null);
  // Backend session for the currently-active PDF. Used by onFieldRemap to
  // run a single-header match whenever the user picks a canonical field.
  // Null = never successfully processed the PDF on the backend; we fall
  // back to client-side autoMatch in that case.
  const [sessionId,  setSessionId]   = useState<string | null>(null);
  const [mappings,   setMappings]    = useState<MappingState[]>([]);
  const [activeHeader, setActiveHeader] = useState<string | null>(null);
  const [targetRow0,   setTargetRow0]   = useState(0);
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

  // Run a one-header PDF match. The single search term is the canonical
  // field label the user just picked from the dropdown. Uses the stored
  // session when available, otherwise falls back to client-side autoMatch
  // against the PDF file.
  const matchOneHeader = useCallback(async (
    pdf: File,
    session: string | null,
    searchTerm: string,
  ): Promise<HeaderMatch | null> => {
    try {
      if (session) {
        setProgress({ label: `Matching "${searchTerm}" on the server`, done: 0, total: 1 });
        const [hit] = await matchHeadersBackend(session, [searchTerm]);
        return hit ?? null;
      }
      setProgress({ label: `Matching "${searchTerm}" locally`, done: 0, total: 1 });
      const [hit] = await autoMatch(pdf, [searchTerm]);
      return hit ?? null;
    } catch (err) {
      console.warn(`[auto-map] match for "${searchTerm}" failed:`, err);
      return null;
    } finally {
      setProgress(null);
    }
  }, []);

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
        mapping: fm,
        match:   { header: fm.excelHeader, box: null, alternatives: [] },
        status:  'pending' as const,
      })));
      setActiveHeader(fieldMaps[0]?.excelHeader ?? null);

      toast.success(`Read ${src.headers.length} header${src.headers.length !== 1 ? 's' : ''}. Map each one to a canonical field using the dropdown.`);
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

  // User picked a canonical field from the dropdown. Update the mapping
  // and immediately run a single-header PDF match for the new field label.
  // Unmapping clears the previous match so nothing lingers.
  const onFieldRemap = useCallback(async (
    excelHeader: string,
    fieldKey: FieldLabel | null,
    fieldLabel: string | null,
  ) => {
    // 1. Update the mapping synchronously so the UI reflects the choice.
    setMappings(prev => prev.map(m => {
      if (m.mapping.excelHeader !== excelHeader) return m;
      return {
        ...m,
        mapping: { ...m.mapping, fieldKey, fieldLabel },
        // Clear previous match + overrides when the mapping changes.
        match:   { header: excelHeader, box: null, alternatives: [] },
        override: undefined,
        chosenBox: undefined,
        status:  'pending' as const,
      };
    }));
    if (!fieldLabel || !activePdf) return;

    // 2. Fire the per-header match (backend first, client fallback).
    const hit = await matchOneHeader(activePdf, sessionId, fieldLabel);
    if (!hit) return;
    setMappings(prev => prev.map(m =>
      m.mapping.excelHeader === excelHeader
        ? { ...m, match: hit }
        : m,
    ));
    setActiveHeader(excelHeader);
  }, [activePdf, sessionId, matchOneHeader]);

  const onDownload = useCallback(() => {
    if (!source) return;
    // Only confirmed values go into the sheet. (Edited-but-not-confirmed
    // stays out; confirmed-with-edit uses the override.)
    const values: Record<string, string> = {};
    for (const m of mappings) {
      if (m.status !== 'confirmed') continue;
      const v = m.override ?? m.chosenBox?.value ?? m.match.box?.value ?? '';
      values[m.mapping.excelHeader] = v;
    }
    if (Object.keys(values).length === 0) {
      toast.warning('Confirm at least one mapping before downloading.');
      return;
    }
    const wb = writeValuesToWorkbook({ source, rowIndex0: targetRow0, values });
    const blob = workbookToBlob(wb);
    const outName = (excelFile?.name || 'output').replace(/\.[^.]+$/, '') + `_filled_row${targetRow0 + 1}.xlsx`;
    downloadBlob(blob, outName);
  }, [source, mappings, targetRow0, excelFile]);

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

      // Preserve existing header→field mapping; reset match + status and
      // re-run a match for each header that has a canonical field picked.
      const prev = mappings;
      setMappings(prev.map(m => ({
        mapping: m.mapping,
        match:   { header: m.mapping.excelHeader, box: null, alternatives: [] },
        status:  'pending' as const,
      })));

      let found = 0;
      for (const m of prev) {
        if (!m.mapping.fieldLabel) continue;
        const hit = await matchOneHeader(pdf, sid, m.mapping.fieldLabel);
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
              activeHeader={activeHeader}
              onSelect={setActiveHeader}
              onFieldRemap={onFieldRemap}
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
              targetRow0={targetRow0}
              onTargetRowChange={setTargetRow0}
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
