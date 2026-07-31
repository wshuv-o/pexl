import { useState, useEffect, useMemo, useCallback } from 'react';
import { X, Loader2 } from 'lucide-react';
import type ExcelJS from 'exceljs';
import { getFieldConfig, getFieldLabelsForType, type DocumentType, type ExtractedRow } from '@/types/utilscraper';
import { buildUtilityWorkbook } from '@/lib/utility-excel-export';
import { buildBankStatementWorkbook } from '@/lib/bank-excel-export';
import SheetGrid from '@/components/SheetGrid';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000';

interface BatchRecord {
  id: number;
  batch_id: number;
  session_id: string;
  filename: string;
  page: number;
  fields: Record<string, string>;
  created_at: string;
}

interface Props {
  batchId: number;
  batchName: string;
  docType?: DocumentType | null;
  onClose: () => void;
}

// Light per-session tints. `bg` is a low-alpha row wash that reads on both
// light and dark themes; `dot` is the solid legend swatch / left border.
const SESSION_TINTS = [
  { bg: 'rgba(59,130,246,0.12)',  dot: '#3b82f6' },
  { bg: 'rgba(16,185,129,0.12)',  dot: '#10b981' },
  { bg: 'rgba(249,115,22,0.12)',  dot: '#f97316' },
  { bg: 'rgba(168,85,247,0.12)',  dot: '#a855f7' },
  { bg: 'rgba(236,72,153,0.12)',  dot: '#ec4899' },
  { bg: 'rgba(234,179,8,0.14)',   dot: '#eab308' },
  { bg: 'rgba(20,184,166,0.12)',  dot: '#14b8a6' },
  { bg: 'rgba(239,68,68,0.12)',   dot: '#ef4444' },
];

const cleanName = (f: string) => f.replace(/\.(pdf|docx?)$/i, '');

export default function BatchPreview({ batchId, batchName, docType, onClose }: Props) {
  const [records, setRecords] = useState<BatchRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/batches/${batchId}/records`);
      const data = await res.json();
      if (data.status === 'ok') setRecords(data.records as BatchRecord[]);
    } catch { /* ignore */ }
    setLoading(false);
  }, [batchId]);
  useEffect(() => { void load(); }, [load]);

  // Assign each session a tint in order of first appearance.
  const sessionTint = useMemo(() => {
    const map = new Map<string, { bg: string; dot: string; filename: string }>();
    let i = 0;
    for (const r of records) {
      if (!map.has(r.session_id)) {
        map.set(r.session_id, { ...SESSION_TINTS[i % SESSION_TINTS.length], filename: r.filename });
        i++;
      }
    }
    return map;
  }, [records]);

  // Union of every field key that actually appears, in first-seen order.
  const presentFields = useMemo(() => {
    const seen: string[] = [];
    const set = new Set<string>();
    for (const r of records) {
      for (const k of Object.keys(r.fields)) {
        if (!set.has(k)) { set.add(k); seen.push(k); }
      }
    }
    return seen;
  }, [records]);

  // Template columns: the canonical fields for the batch's doc type. Only
  // used for doc types that have no dedicated workbook builder below.
  const templateCols = useMemo(() => {
    if (!docType) return presentFields;
    const canonical: string[] = getFieldLabelsForType(docType)
      .filter(f => f.value !== 'custom')
      .map(f => f.value as string);
    // Append any present-but-non-canonical fields (e.g. custom labels) so
    // nothing saved is hidden.
    const extra = presentFields.filter(f => !canonical.includes(f));
    return [...canonical, ...extra];
  }, [docType, presentFields]);

  const cols = templateCols;
  const sessionCount = sessionTint.size;

  // ── Real-template preview ──────────────────────────────────────────────
  // Utility and bank batches export a purpose-built workbook whose shape has
  // nothing to do with "one row per record": the utility recon pivots utility
  // items against month columns, the bank template runs a balance chain with
  // trailing-period tables. Showing a flat field-per-column grid for those was
  // simply the wrong document. So we build the actual workbook here and render
  // it — same code path as the download, so it can't drift.
  const [workbook, setWorkbook] = useState<ExcelJS.Workbook | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [activeSheet, setActiveSheet] = useState(0);

  const hasRealTemplate = docType === 'utility_bill' || docType === 'bank_statement';

  // Batch records store one flat {field: value} map per (session, page).
  // Rebuild the ExtractedRow[] the exporters expect.
  const rowsFromRecords = useMemo<ExtractedRow[]>(() => {
    const out: ExtractedRow[] = [];
    for (const rec of records) {
      for (const [field, value] of Object.entries(rec.fields ?? {})) {
        if (!value) continue;
        out.push({
          page: rec.page, field, value,
          confidence: 'high', wasOcr: false,
          filename: rec.filename, sessionId: rec.session_id,
        });
      }
    }
    return out;
  }, [records]);

  useEffect(() => {
    if (!hasRealTemplate || records.length === 0) return;
    let cancelled = false;
    setBuilding(true);
    setBuildError(null);
    (async () => {
      try {
        let wb: ExcelJS.Workbook;
        if (docType === 'bank_statement') {
          wb = await buildBankStatementWorkbook(rowsFromRecords);
        } else {
          const fileMap = new Map<string, ExtractedRow[]>();
          for (const r of rowsFromRecords) {
            // Same grouping key the exporter uses.
            const key = r.filename || 'Unknown';
            if (!fileMap.has(key)) fileMap.set(key, []);
            fileMap.get(key)!.push(r);
          }
          ({ wb } = await buildUtilityWorkbook(fileMap));
        }
        if (cancelled) return;
        setWorkbook(wb);
        setActiveSheet(0);
      } catch (err) {
        if (cancelled) return;
        console.error('template preview build failed', err);
        setBuildError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setBuilding(false);
      }
    })();
    return () => { cancelled = true; };
  }, [hasRealTemplate, docType, rowsFromRecords, records.length]);

  const sheets = workbook?.worksheets ?? [];
  const showRealTemplate = hasRealTemplate;

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-5xl max-h-[88vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="text-sm font-bold text-foreground">Preview — {batchName}</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {records.length} record{records.length !== 1 ? 's' : ''} · {sessionCount} session{sessionCount !== 1 ? 's' : ''}
              {!showRealTemplate && ' · each session is tinted a different colour'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Sheet tabs — the exported workbook usually has several. */}
        {showRealTemplate && sheets.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-5 py-2 border-b border-border shrink-0">
            {sheets.map((ws, i) => (
              <button
                key={ws.id ?? i}
                onClick={() => setActiveSheet(i)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  i === activeSheet
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted border border-border'
                }`}
              >
                {ws.name}
              </button>
            ))}
          </div>
        )}

        {/* Session legend — only meaningful for the per-record views. */}
        {!showRealTemplate && sessionCount > 0 && (
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 px-5 py-2.5 border-b border-border shrink-0">
            {Array.from(sessionTint.values()).map((t, i) => (
              <span key={i} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: t.dot }} />
                {cleanName(t.filename)}
              </span>
            ))}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-auto custom-scrollbar">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading records…
            </div>
          ) : records.length === 0 ? (
            <p className="text-center text-xs text-muted-foreground py-16">No records saved in this batch yet.</p>
          ) : showRealTemplate ? (
            building ? (
              <div className="flex items-center justify-center py-16 text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin mr-2" /> Building the export template…
              </div>
            ) : buildError ? (
              <div className="px-5 py-10 text-center text-xs text-muted-foreground">
                <p className="text-warning font-medium mb-1">Couldn’t build the template preview.</p>
                <p className="opacity-80">{buildError}</p>
              </div>
            ) : sheets[activeSheet] ? (
              <SheetGrid worksheet={sheets[activeSheet]} />
            ) : (
              <p className="text-center text-xs text-muted-foreground py-16">Nothing to preview.</p>
            )
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 z-10">
                <tr className="bg-muted">
                  <th className="text-left font-semibold text-muted-foreground px-3 py-2 border-b border-border whitespace-nowrap">File</th>
                  <th className="text-left font-semibold text-muted-foreground px-3 py-2 border-b border-border whitespace-nowrap">Page</th>
                  {cols.map(c => {
                    const cfg = getFieldConfig(c);
                    return (
                      <th
                        key={c}
                        className="text-left font-semibold px-3 py-2 border-b border-border whitespace-nowrap"
                        style={{ color: cfg.color }}
                        title={cfg.label}
                      >
                        {cfg.label}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {records.map(rec => {
                  const tint = sessionTint.get(rec.session_id);
                  return (
                    <tr key={rec.id} style={{ backgroundColor: tint?.bg }}>
                      <td
                        className="px-3 py-2 border-b border-border/60 text-foreground font-medium whitespace-nowrap"
                        style={{ borderLeft: `3px solid ${tint?.dot ?? 'transparent'}` }}
                        title={rec.filename}
                      >
                        {cleanName(rec.filename)}
                      </td>
                      <td className="px-3 py-2 border-b border-border/60 text-muted-foreground">{rec.page}</td>
                      {cols.map(c => (
                        <td key={c} className="px-3 py-2 border-b border-border/60 text-foreground whitespace-nowrap">
                          {rec.fields[c] || <span className="text-muted-foreground/30">—</span>}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-5 py-2.5 border-t border-border shrink-0 text-[10px] text-muted-foreground">
          {showRealTemplate
            ? 'The actual workbook this batch exports, built by the same code as the download. Formula cells (ƒ) are calculated when Excel opens the file.'
            : 'Canonical columns for this document type — it has no dedicated workbook template.'}
        </div>
      </div>
    </div>
  );
}
