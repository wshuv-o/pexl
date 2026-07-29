import { useState, useEffect, useMemo, useCallback } from 'react';
import { X, Loader2, LayoutGrid, Table2 } from 'lucide-react';
import { getFieldConfig, getFieldLabelsForType, type DocumentType } from '@/types/utilscraper';

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
  const [tab, setTab] = useState<'template' | 'raw'>('template');

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

  // Template columns: the canonical fields for the batch's doc type (so the
  // preview mirrors the export template's columns). Falls back to whatever
  // fields are present when the batch has no doc type.
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

  const cols = tab === 'template' ? templateCols : presentFields;
  const sessionCount = sessionTint.size;

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-5xl max-h-[88vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="text-sm font-bold text-foreground">Preview — {batchName}</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {records.length} record{records.length !== 1 ? 's' : ''} · {sessionCount} session{sessionCount !== 1 ? 's' : ''} ·
              each session is tinted a different colour
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Tab switch */}
            <div className="flex rounded-lg border border-border overflow-hidden text-[11px] font-medium">
              <button
                onClick={() => setTab('template')}
                className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors ${
                  tab === 'template' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" /> Template
              </button>
              <button
                onClick={() => setTab('raw')}
                className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors ${
                  tab === 'raw' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                <Table2 className="w-3.5 h-3.5" /> Raw
              </button>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Session legend */}
        {sessionCount > 0 && (
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
          {tab === 'template'
            ? 'Template view — columns match the export template for this batch’s document type.'
            : 'Raw view — every saved field, exactly as stored.'}
        </div>
      </div>
    </div>
  );
}
