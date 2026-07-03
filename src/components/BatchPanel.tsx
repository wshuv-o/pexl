import { useState, useEffect, useCallback } from 'react';
import { X, Pencil, Trash2, ChevronDown, ChevronRight, Check, Loader2, CheckCircle2, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DOCUMENT_TYPES, type DocumentType, type ExtractedRow } from '@/types/utilscraper';
import { exportToExcel } from '@/lib/excel-export';
import { toast } from 'sonner';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000';

interface Batch {
  id: number;
  name: string;
  doc_type?: DocumentType;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  record_count: number;
}

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
  username: string;
  activeBatchId?: number | null;
  onClose: () => void;
  onSelect?: (id: number, name: string) => void;
}

export default function BatchPanel({ username, activeBatchId, onClose, onSelect }: Props) {
  const [batches, setBatches]         = useState<Batch[]>([]);
  const [loading, setLoading]         = useState(true);

  const [editingId, setEditingId]     = useState<number | null>(null);
  const [editName, setEditName]       = useState('');
  const [editSaving, setEditSaving]   = useState(false);

  const [deleteId, setDeleteId]       = useState<number | null>(null);
  const [deleteSaving, setDeleteSaving] = useState(false);

  const [expandedId, setExpandedId]   = useState<number | null>(null);
  const [records, setRecords]         = useState<Record<number, BatchRecord[]>>({});
  const [loadingRec, setLoadingRec]   = useState<number | null>(null);

  const [downloadingId, setDownloadingId] = useState<number | null>(null);

  // Fetch a batch's records and export using the doc type baked in at
  // batch-creation time. No per-download picker — the batch's own
  // doc_type wins.
  //
  // Pre-migration batches have doc_type = NULL (unknown). In that case we
  // deliberately do NOT force a template — exportToExcel auto-detects the
  // right doc type from the actual field names in the records. That's
  // safer than defaulting to utility_bill, which would mislabel an old
  // Bank Statement / Appraisal batch.
  const handleDownload = async (batch: Batch) => {
    setDownloadingId(batch.id);
    try {
      const res = await fetch(`${BACKEND_URL}/api/batches/${batch.id}/records`);
      const data = await res.json();
      if (data.status !== 'ok') { toast.error('Failed to load batch records'); return; }
      const rows: ExtractedRow[] = [];
      for (const rec of data.records as BatchRecord[]) {
        for (const [field, value] of Object.entries(rec.fields)) {
          if (!value) continue;
          rows.push({
            page: rec.page,
            field,
            value,
            confidence: 'high',
            wasOcr: false,
            filename: rec.filename,
            sessionId: rec.session_id,
          });
        }
      }
      if (rows.length === 0) { toast('No records to export in this batch', { icon: 'ℹ️' }); return; }
      const safeStem = batch.name.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || `batch_${batch.id}`;
      // Only pass forceDocType when the batch actually has one. NULL →
      // let the exporter's field-count heuristic pick the template.
      const opts = batch.doc_type ? { forceDocType: batch.doc_type } : {};
      await exportToExcel(rows, safeStem, safeStem, opts);
      const label = batch.doc_type
        ? (DOCUMENT_TYPES.find(t => t.value === batch.doc_type)?.label ?? batch.doc_type)
        : 'auto-detected template';
      toast.success(`Downloading "${batch.name}" as ${label}`);
    } catch (err) {
      console.error('batch download failed:', err);
      toast.error('Download failed');
    } finally {
      setDownloadingId(null);
    }
  };

  const loadBatches = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/batches`);
      const data = await res.json();
      if (data.status === 'ok') setBatches(data.batches);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { void loadBatches(); }, [loadBatches]);

  const handleUpdate = async (id: number) => {
    if (!editName.trim()) return;
    setEditSaving(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/batches/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName.trim(), updated_by: username }),
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setBatches(prev => prev.map(b => b.id === id ? { ...b, ...data.batch } : b));
        setEditingId(null);
      }
    } catch { /* ignore */ }
    setEditSaving(false);
  };

  const handleDelete = async (id: number) => {
    setDeleteSaving(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/batches/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.status === 'ok') {
        setBatches(prev => prev.filter(b => b.id !== id));
        if (expandedId === id) setExpandedId(null);
        setDeleteId(null);
      }
    } catch { /* ignore */ }
    setDeleteSaving(false);
  };

  const toggleExpand = async (id: number) => {
    if (expandedId === id) { setExpandedId(null); return; }
    setExpandedId(id);
    if (records[id]) return;
    setLoadingRec(id);
    try {
      const res = await fetch(`${BACKEND_URL}/api/batches/${id}/records`);
      const data = await res.json();
      if (data.status === 'ok') setRecords(prev => ({ ...prev, [id]: data.records }));
    } catch { /* ignore */ }
    setLoadingRec(null);
  };

  const fmtDate = (iso: string) => {
    try { return new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }); }
    catch { return iso; }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">

        {/* Header — create-batch button removed; new batches are created from
            the batch-selector dropdown in the Excel panel now. This manager
            is edit / delete / inspect only. */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="text-sm font-bold text-foreground">Batch Manager</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {batches.length} batch{batches.length !== 1 ? 'es' : ''} · download, rename, delete, inspect records
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto custom-scrollbar px-5 py-4 space-y-2">

          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading batches…
            </div>
          ) : batches.length === 0 ? (
            <p className="text-center text-xs text-muted-foreground py-10">No batches yet. Use the batch selector in the Excel panel to create one.</p>
          ) : (
            batches.map(b => (
              <div key={b.id} className="rounded-lg border border-border bg-card overflow-hidden">

                {/* Batch row */}
                <div className="flex items-center gap-2 px-3 py-2.5">
                  <button
                    onClick={() => void toggleExpand(b.id)}
                    className="flex items-center gap-1.5 flex-1 min-w-0 text-left group"
                  >
                    {expandedId === b.id
                      ? <ChevronDown className="w-3.5 h-3.5 shrink-0 text-primary" />
                      : <ChevronRight className="w-3.5 h-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
                    }
                    {editingId === b.id ? (
                      <input
                        autoFocus
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') void handleUpdate(b.id); if (e.key === 'Escape') setEditingId(null); }}
                        onClick={e => e.stopPropagation()}
                        className="flex-1 h-6 px-2 text-xs rounded border border-primary bg-background text-foreground outline-none"
                      />
                    ) : (
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-semibold text-foreground truncate">{b.name}</span>
                        {/* Doc-type badge — display only. Batches always get
                            their doc type at creation time now, so there's
                            no reason to change it after. Batches without a
                            doc_type simply don't show a badge. */}
                        {(() => {
                          const dt = b.doc_type
                            ? DOCUMENT_TYPES.find(t => t.value === b.doc_type)
                            : null;
                          if (!dt) return null;
                          return (
                            <span
                              className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border"
                              style={{
                                backgroundColor: `${dt.color}22`,
                                borderColor: `${dt.color}55`,
                                color: dt.color,
                              }}
                              title={`Export template: ${dt.label}`}
                            >
                              {dt.label}
                            </span>
                          );
                        })()}
                      </span>
                    )}
                  </button>

                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-[10px] text-muted-foreground hidden sm:block">
                      {b.record_count} record{b.record_count !== 1 ? 's' : ''}
                    </span>
                    <span className="text-[10px] text-muted-foreground hidden md:block">
                      by {b.created_by}
                    </span>
                    <span className="text-[10px] text-muted-foreground hidden md:block">
                      {fmtDate(b.created_at)}
                    </span>

                    {onSelect && editingId !== b.id && (
                      <button
                        className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-all ${
                          activeBatchId === b.id
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-muted-foreground hover:bg-primary/20 hover:text-primary'
                        }`}
                        onClick={e => { e.stopPropagation(); onSelect(b.id, b.name); }}
                        title={activeBatchId === b.id ? 'Active batch' : 'Use this batch'}
                      >
                        <CheckCircle2 className="w-3 h-3" />
                        {activeBatchId === b.id ? 'Active' : 'Select'}
                      </button>
                    )}

                    {editingId === b.id ? (
                      <>
                        <button
                          className="p-1 rounded text-muted-foreground hover:text-green-500 hover:bg-green-500/10 transition-all"
                          onClick={() => void handleUpdate(b.id)}
                          title="Save"
                        >
                          {editSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                        </button>
                        <button
                          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
                          onClick={() => setEditingId(null)}
                          title="Cancel"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </>
                    ) : (
                      <>
                        {/* Download batch as Excel using the doc type baked in
                            at creation. No picker — one click, one file.
                            Pre-migration batches (doc_type = NULL) show
                            "auto-detected" — the exporter picks the
                            template from actual field names. */}
                        {(() => {
                          const dt = b.doc_type
                            ? DOCUMENT_TYPES.find(t => t.value === b.doc_type)
                            : null;
                          return (
                            <button
                              className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                              disabled={downloadingId === b.id || b.record_count === 0}
                              title={
                                b.record_count === 0
                                  ? 'No records to download'
                                  : dt
                                    ? `Download as ${dt.label}`
                                    : 'Set the batch template first (click the pill next to the batch name)'
                              }
                              onClick={e => { e.stopPropagation(); void handleDownload(b); }}
                            >
                              {downloadingId === b.id
                                ? <Loader2 className="w-3 h-3 animate-spin" />
                                : <Download className="w-3 h-3" />}
                            </button>
                          );
                        })()}
                        <button
                          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
                          onClick={() => { setEditingId(b.id); setEditName(b.name); }}
                          title="Rename"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
                          onClick={() => setDeleteId(b.id)}
                          title="Delete batch"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Delete confirm */}
                {deleteId === b.id && (
                  <div className="mx-3 mb-2.5 rounded border border-destructive/50 bg-destructive/10 px-3 py-2 flex items-center gap-3">
                    <p className="text-xs text-destructive flex-1">Delete <b>{b.name}</b> and all its records?</p>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="h-6 text-[11px]"
                      onClick={() => void handleDelete(b.id)}
                      disabled={deleteSaving}
                    >
                      {deleteSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Delete'}
                    </Button>
                    <button
                      className="text-[11px] text-muted-foreground hover:text-foreground"
                      onClick={() => setDeleteId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {/* Records */}
                {expandedId === b.id && (
                  <div className="border-t border-border bg-muted/20 px-3 py-2">
                    {loadingRec === b.id ? (
                      <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading records…
                      </div>
                    ) : !records[b.id] || records[b.id].length === 0 ? (
                      <p className="text-xs text-muted-foreground py-2">No records in this batch yet.</p>
                    ) : (
                      <div className="space-y-1">
                        {Object.entries(
                          records[b.id].reduce((acc, r) => {
                            const key = r.filename;
                            if (!acc[key]) acc[key] = [];
                            acc[key].push(r);
                            return acc;
                          }, {} as Record<string, BatchRecord[]>)
                        ).map(([filename, recs]) => (
                          <div key={filename}>
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                              {filename.replace(/\.(pdf|docx?)$/i, '')}
                            </p>
                            {recs.map(r => (
                              <div key={r.id} className="flex items-start gap-2 py-1 border-b border-border/30 last:border-0">
                                <span className="text-[10px] text-muted-foreground shrink-0 w-12">p.{r.page}</span>
                                <div className="flex flex-wrap gap-x-3 gap-y-0.5 min-w-0">
                                  {Object.entries(r.fields).map(([k, v]) => v ? (
                                    <span key={k} className="text-[10px] text-foreground">
                                      <span className="text-muted-foreground">{k}:</span> {v}
                                    </span>
                                  ) : null)}
                                </div>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
