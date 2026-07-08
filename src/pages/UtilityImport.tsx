/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { UploadCloud, Loader2, CheckCircle2, FileSpreadsheet, Database } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000';

type ImportResult = {
  status: string;
  batch_id: number;
  batch_name: string;
  inserted: number;
  skipped_blank: number;
  detected_headers: string[];
  mapped_fields: string[];
};

export default function UtilityImport() {
  const { user } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const pickFile = useCallback((f: File | null) => {
    setResult(null); setError(null);
    setFile(f);
    if (f && !name) setName(f.name.replace(/\.(xlsx|xlsm|xls)$/i, ''));
  }, [name]);

  const doImport = useCallback(async () => {
    if (!file) { toast.error('Choose an Excel file first'); return; }
    if (!name.trim()) { toast.error('Give the batch a name'); return; }
    setImporting(true); setError(null); setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', name.trim());
      fd.append('created_by', user?.username || 'import');
      const res = await fetch(`${BACKEND_URL}/api/utility-import`, { method: 'POST', body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j.error || `Import failed (${res.status})`);
        toast.error(j.error || 'Import failed');
        return;
      }
      setResult(j);
      toast.success(`Imported ${j.inserted.toLocaleString()} rows into "${j.batch_name}"`);
    } catch (e: any) {
      setError(String(e));
      toast.error('Import error: ' + String(e).slice(0, 120));
    } finally {
      setImporting(false);
    }
  }, [file, name, user]);

  return (
    <div className="min-h-screen bg-background text-foreground p-5">
      <div className="max-w-[820px] mx-auto space-y-5">
        <header className="flex items-center gap-3">
          <Database className="w-6 h-6 text-primary" />
          <div>
            <h1 className="text-lg font-bold">Import Utility Excel → Database</h1>
            <p className="text-xs text-muted-foreground">
              Upload an externally-generated utility spreadsheet; every row is saved as a batch you can download in the utility template.
            </p>
          </div>
          <a href="/" className="ml-auto text-xs text-primary underline">← Back to main</a>
        </header>

        {/* Drop / pick */}
        <div
          role="button" tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) pickFile(f); }}
          className="border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center text-center cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-colors"
        >
          {file
            ? <><FileSpreadsheet className="w-8 h-8 text-primary mb-2" /><p className="text-sm font-semibold">{file.name}</p><p className="text-xs text-muted-foreground">{(file.size / 1024 / 1024).toFixed(1)} MB · click to change</p></>
            : <><UploadCloud className="w-8 h-8 text-muted-foreground mb-2" /><p className="text-sm font-semibold">Click to choose or drop a .xlsx file</p><p className="text-xs text-muted-foreground mt-1">Expected columns: Property Name · Provider Name · Account · Service Start/End Date · Current Charges · Utility Type</p></>}
          <input ref={inputRef} type="file" accept=".xlsx,.xlsm,.xls" className="hidden"
                 onChange={e => { const f = e.target.files?.[0] || null; pickFile(f); e.currentTarget.value = ''; }} />
        </div>

        {/* Batch name + import */}
        <div className="flex items-end gap-3 flex-wrap">
          <label className="flex-1 min-w-[240px] text-xs">
            <span className="text-muted-foreground">Batch name</span>
            <input value={name} onChange={e => setName(e.target.value)}
                   placeholder="e.g. Utilities — March 2026"
                   className="mt-1 w-full h-9 px-3 bg-muted rounded-md text-sm outline-none focus:ring-2 focus:ring-primary/40" />
          </label>
          <button type="button" onClick={doImport} disabled={importing || !file}
                  className="inline-flex items-center gap-2 px-4 h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
            {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />}
            {importing ? 'Importing… (large files take a minute)' : 'Import to database'}
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 text-destructive text-sm p-3">{error}</div>
        )}

        {result && (
          <div className="rounded-lg border border-green-500/40 bg-green-500/10 p-4 space-y-3">
            <div className="flex items-center gap-2 text-green-700 dark:text-green-400 font-semibold">
              <CheckCircle2 className="w-5 h-5" /> Imported successfully
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <Stat label="Rows inserted" value={result.inserted.toLocaleString()} />
              <Stat label="Blank rows skipped" value={String(result.skipped_blank)} />
              <Stat label="Batch ID" value={String(result.batch_id)} />
              <Stat label="Batch name" value={result.batch_name} />
            </div>
            <div className="text-xs text-muted-foreground">
              <div><span className="font-medium text-foreground">Detected columns:</span> {result.detected_headers.join(' · ')}</div>
              <div className="mt-1"><span className="font-medium text-foreground">Mapped fields:</span> {result.mapped_fields.join(', ')}</div>
            </div>
            <p className="text-xs text-muted-foreground">
              Open the main app → <span className="font-medium text-foreground">Batches</span> to download "<span className="font-medium text-foreground">{result.batch_name}</span>" in the utility template.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-background/60 border p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold truncate" title={value}>{value}</div>
    </div>
  );
}
