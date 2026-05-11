import { useState, useEffect, useCallback } from 'react';
import { X, Plus, Pencil, Trash2, ChevronDown, ChevronRight, Check, Loader2, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000';

interface Batch {
  id: number;
  name: string;
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

  const [creating, setCreating]       = useState(false);
  const [createName, setCreateName]   = useState('');
  const [createSaving, setCreateSaving] = useState(false);

  const [editingId, setEditingId]     = useState<number | null>(null);
  const [editName, setEditName]       = useState('');
  const [editSaving, setEditSaving]   = useState(false);

  const [deleteId, setDeleteId]       = useState<number | null>(null);
  const [deleteSaving, setDeleteSaving] = useState(false);

  const [expandedId, setExpandedId]   = useState<number | null>(null);
  const [records, setRecords]         = useState<Record<number, BatchRecord[]>>({});
  const [loadingRec, setLoadingRec]   = useState<number | null>(null);

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

  const handleCreate = async () => {
    if (!createName.trim()) return;
    setCreateSaving(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/batches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: createName.trim(), created_by: username }),
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setBatches(prev => [{ ...data.batch, record_count: 0 }, ...prev]);
        setCreateName('');
        setCreating(false);
      }
    } catch { /* ignore */ }
    setCreateSaving(false);
  };

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

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="text-sm font-bold text-foreground">Batch Manager</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {batches.length} batch{batches.length !== 1 ? 'es' : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => { setCreating(true); setCreateName(''); }}
            >
              <Plus className="w-3.5 h-3.5 mr-1" /> New Batch
            </Button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto custom-scrollbar px-5 py-4 space-y-2">

          {/* Create form */}
          {creating && (
            <div className="rounded-lg border border-primary/50 bg-primary/5 p-3 space-y-2">
              <p className="text-xs font-semibold text-foreground">New batch</p>
              <input
                autoFocus
                value={createName}
                onChange={e => setCreateName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void handleCreate(); if (e.key === 'Escape') setCreating(false); }}
                placeholder="Batch name"
                className="w-full h-8 px-3 text-xs rounded-md border border-border bg-background text-foreground outline-none focus:ring-1 focus:ring-primary"
              />
              <div className="flex gap-2">
                <Button size="sm" className="h-7 text-xs" onClick={handleCreate} disabled={createSaving || !createName.trim()}>
                  {createSaving ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Check className="w-3 h-3 mr-1" />}
                  Create
                </Button>
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setCreating(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading batches…
            </div>
          ) : batches.length === 0 && !creating ? (
            <p className="text-center text-xs text-muted-foreground py-10">No batches yet. Click "New Batch" to create one.</p>
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
                      <span className="text-xs font-semibold text-foreground truncate">{b.name}</span>
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
