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
import { processFile } from '@/lib/api';

// ───────────────────────────────────────────────────────────────────────────
// Auto-map page: Source PDF + Source output Excel → read headers → rule-based
// match PDF text to each header → user walks pages, confirms per-highlight or
// per-page → live Excel preview fills the chosen row → download workbook with
// original styles preserved.
// ───────────────────────────────────────────────────────────────────────────
export default function AutoMap() {
  const navigate = useNavigate();

  const [pdfFile,   setPdfFile]   = useState<File | null>(null);
  const [excelFile, setExcelFile] = useState<File | null>(null);
  const [source,    setSource]    = useState<SourceExcel | null>(null);
  const [matches,   setMatches]   = useState<HeaderMatch[] | null>(null);
  const [mappings,  setMappings]  = useState<MappingState[]>([]);
  const [activeHeader, setActiveHeader] = useState<string | null>(null);
  const [targetRow0,   setTargetRow0]   = useState(0);
  const [running,      setRunning]      = useState(false);
  const [progress,     setProgress]     = useState<{ label: string; done: number; total: number } | null>(null);

  const start = useCallback(async () => {
    if (!pdfFile || !excelFile) return;
    setRunning(true);
    try {
      // ── Step 1: read Excel headers (client-side, free) ────────────────
      const src = await readSourceExcel(excelFile);
      if (src.headers.length === 0) throw new Error('No headers found in the first row of the Excel sheet.');
      setSource(src);

      // ── Step 2: try the backend path first (works on scanned PDFs via
      //    the session's OCR words); fall back to the client-side matcher
      //    if the backend is unreachable or errors. ──────────────────────
      let result: HeaderMatch[] | null = null;

      try {
        setProgress({ label: 'Uploading PDF & running OCR', done: 0, total: 1 });
        const processed = await processFile(pdfFile, '', (step, detail) => {
          setProgress({
            label: detail || 'Processing PDF',
            done: step,
            total: 3,
          });
        });
        setProgress({ label: 'Auto-matching headers on the server', done: 1, total: 1 });
        result = await matchHeadersBackend(processed.session_id, src.headers);
      } catch (backendErr) {
        // Backend unreachable / errored — silently fall through.
        console.warn('[auto-map] backend path failed, falling back to client matcher:', backendErr);
        toast.info('Backend unavailable — matching locally via pdfjs.');
        result = await autoMatch(
          pdfFile,
          src.headers,
          (done, total) => setProgress({ label: 'Local matching', done, total }),
        );
      }

      setMatches(result);
      setMappings(result.map(r => ({ match: r, status: 'pending' as const })));
      setActiveHeader(result[0]?.header ?? null);
      toast.success(`Found ${result.filter(r => r.box).length} / ${result.length} candidate mappings`);
    } catch (err) {
      const msg = (err as Error).message || 'Unknown error';
      toast.error(msg);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, [pdfFile, excelFile]);

  const patchMapping = useCallback((header: string, patch: Partial<MappingState>) => {
    setMappings(prev => prev.map(m => m.match.header === header ? { ...m, ...patch } : m));
  }, []);

  const onConfirmHeader = useCallback((header: string, value?: string) => {
    patchMapping(header, {
      status: 'confirmed',
      ...(value !== undefined ? { override: value } : {}),
    });
    // Auto-advance to next pending header for a fluid confirm flow.
    setMappings(prev => {
      const idx = prev.findIndex(m => m.match.header === header);
      const next = prev.slice(idx + 1).find(m => m.status === 'pending');
      if (next) setActiveHeader(next.match.header);
      return prev;
    });
  }, [patchMapping]);

  const onRejectHeader = useCallback((header: string) => {
    patchMapping(header, { status: 'rejected' });
  }, [patchMapping]);

  const onEditHeader = useCallback((header: string, value: string) => {
    patchMapping(header, { override: value });
  }, [patchMapping]);

  const onApplyToPageAll = useCallback((page: number, status: 'confirmed' | 'rejected') => {
    setMappings(prev => prev.map(m => {
      const b = m.chosenBox ?? m.match.box;
      if (b && b.page === page && m.status === 'pending') return { ...m, status };
      return m;
    }));
    toast.success(`${status === 'confirmed' ? 'Confirmed' : 'Rejected'} all mappings on page ${page}`);
  }, []);

  const onDownload = useCallback(() => {
    if (!source) return;
    // Only confirmed values go into the sheet. (Edited-but-not-confirmed
    // stays out; confirmed-with-edit uses the override.)
    const values: Record<string, string> = {};
    for (const m of mappings) {
      if (m.status !== 'confirmed') continue;
      const v = m.override ?? m.chosenBox?.value ?? m.match.box?.value ?? '';
      values[m.match.header] = v;
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

  const hasData = !!source && !!matches;

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
        </div>
        {progress && (
          <span className="ml-auto text-[11px] text-muted-foreground">
            {progress.label}{progress.total > 1 ? ` · ${progress.done + 1} / ${progress.total}` : '…'}
          </span>
        )}
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Left rail — uploads + mapping list */}
        <aside className="w-80 shrink-0 border-r border-border flex flex-col bg-card">
          {!hasData ? (
            <div className="p-4">
              <DualUpload
                pdfFile={pdfFile}
                excelFile={excelFile}
                onPdfChange={setPdfFile}
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
            />
          )}
        </aside>

        {/* Center — PDF viewer */}
        <main className="flex-1 overflow-hidden">
          {hasData && pdfFile ? (
            <AutoHighlightViewer
              file={pdfFile}
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

        {/* Right rail — live Excel preview */}
        <aside className="w-[520px] shrink-0 border-l border-border">
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
