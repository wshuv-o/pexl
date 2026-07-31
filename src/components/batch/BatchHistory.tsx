import { useState, useEffect, useCallback, useMemo } from 'react';
import { X, Loader2, History, Trash2, Save } from 'lucide-react';
import { FIELD_LABELS } from '@/types/utilscraper';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000';

interface HistoryEntry {
  id: number;
  session_id: string;
  filename: string;
  page: number;
  version: number;
  fields: Record<string, string>;
  action: string;
  changed_by: string | null;
  changed_at: string | null;
}

interface Props {
  batchId: number;
  batchName: string;
  onClose: () => void;
}

const label = (f: string) => FIELD_LABELS[f] ?? f;
const cleanName = (f: string) => f.replace(/\.(pdf|docx?)$/i, '');

/** What changed between a version and the one before it, for the same record. */
function diffAgainstPrevious(entry: HistoryEntry, previous?: HistoryEntry) {
  const before = previous?.fields ?? {};
  const after = entry.fields ?? {};
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
  return keys
    .map(f => ({ field: f, from: before[f] ?? '', to: after[f] ?? '' }))
    .filter(d => d.from !== d.to);
}

export default function BatchHistory({ batchId, batchName, onClose }: Props) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch(`${BACKEND_URL}/api/batches/${batchId}/history`);
      const d = await res.json();
      if (d.status === 'ok') setEntries(d.history as HistoryEntry[]);
      else setFailed(true);
    } catch {
      setFailed(true);
    }
    setLoading(false);
  }, [batchId]);
  useEffect(() => { void load(); }, [load]);

  // History arrives newest-first. To diff each entry we need the previous
  // version *of the same record*, so index by record and walk each timeline.
  const previousOf = useMemo(() => {
    const byRecord = new Map<string, HistoryEntry[]>();
    for (const e of entries) {
      const k = `${e.session_id}-${e.page}`;
      if (!byRecord.has(k)) byRecord.set(k, []);
      byRecord.get(k)!.push(e);
    }
    const map = new Map<number, HistoryEntry | undefined>();
    for (const list of byRecord.values()) {
      const asc = [...list].sort((a, b) => a.version - b.version);
      asc.forEach((e, i) => map.set(e.id, i > 0 ? asc[i - 1] : undefined));
    }
    return map;
  }, [entries]);

  return (
    <div className="fixed inset-0 z-[215] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-3xl max-h-[88vh] flex flex-col">

        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2.5">
            <History className="w-4 h-4 text-primary" />
            <div>
              <h2 className="text-sm font-bold text-foreground">Version history — {batchName}</h2>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {entries.length} change{entries.length !== 1 ? 's' : ''}, newest first
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto custom-scrollbar px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading history…
            </div>
          ) : failed ? (
            <p className="text-center text-xs text-muted-foreground py-16">
              Couldn’t load history for this batch.
            </p>
          ) : entries.length === 0 ? (
            <p className="text-center text-xs text-muted-foreground py-16">
              No changes recorded yet. History starts from the next save.
            </p>
          ) : (
            <ol className="space-y-2.5">
              {entries.map(e => {
                const diff = diffAgainstPrevious(e, previousOf.get(e.id));
                const isDelete = e.action === 'delete';
                return (
                  <li key={e.id} className="border border-border rounded-lg overflow-hidden">
                    <div className="flex items-center gap-2 px-3 py-2 bg-muted/60 text-[11px]">
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-medium ${
                        isDelete ? 'bg-destructive/15 text-destructive' : 'bg-primary/10 text-primary'
                      }`}>
                        {isDelete ? <Trash2 className="w-3 h-3" /> : <Save className="w-3 h-3" />}
                        v{e.version}
                      </span>
                      <span className="font-medium text-foreground truncate">{cleanName(e.filename)}</span>
                      <span className="text-muted-foreground">page {e.page}</span>
                      <span className="ml-auto text-muted-foreground shrink-0">
                        {e.changed_by ?? 'unknown'}
                        {e.changed_at && ` · ${new Date(e.changed_at).toLocaleString()}`}
                      </span>
                    </div>

                    {isDelete ? (
                      <p className="px-3 py-2 text-[11px] text-muted-foreground">Record removed from the batch.</p>
                    ) : diff.length === 0 ? (
                      <p className="px-3 py-2 text-[11px] text-muted-foreground">
                        {previousOf.get(e.id) ? 'Saved with no field changes.' : 'First save of this record.'}
                      </p>
                    ) : (
                      <div className="divide-y divide-border">
                        {diff.map(d => (
                          <div key={d.field} className="flex items-start gap-3 px-3 py-1.5 text-[11px]">
                            <span className="text-muted-foreground min-w-[130px] shrink-0">{label(d.field)}</span>
                            <span className="line-through text-muted-foreground/60 break-words">
                              {d.from || <span className="italic">empty</span>}
                            </span>
                            <span className="text-muted-foreground/50">→</span>
                            <span className="font-medium text-foreground break-words">
                              {d.to || <span className="italic text-muted-foreground/50">empty</span>}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        <div className="px-5 py-2.5 border-t border-border shrink-0 text-[10px] text-muted-foreground">
          Every save records a snapshot. Edits made before this feature was added aren’t listed.
        </div>
      </div>
    </div>
  );
}
