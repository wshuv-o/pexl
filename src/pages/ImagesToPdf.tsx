/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Images, Loader2, FileDown, X, ArrowUp, ArrowDown, FolderOpen } from 'lucide-react';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000';
const IMAGE_RE = /\.(png|jpe?g|tif|tiff|bmp|webp|gif)$/i;

type Result = { pages: number; passthrough: number; skipped: number };

export default function ImagesToPdf() {
  const [files, setFiles] = useState<File[]>([]);
  const [dpi, setDpi] = useState(96);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const attachDir = useCallback((el: HTMLInputElement | null) => {
    folderRef.current = el;
    if (el) { el.setAttribute('webkitdirectory', ''); el.setAttribute('directory', ''); }
  }, []);

  const addFiles = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []).filter(f =>
      IMAGE_RE.test((f as any).webkitRelativePath || f.name));
    if (!picked.length) { toast.error('No image files selected.'); return; }
    // Natural sort so "img2.png" comes before "img10.png".
    picked.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    setFiles(prev => [...prev, ...picked]);
    setResult(null);
    toast.success(`${picked.length} image${picked.length !== 1 ? 's' : ''} added`);
    e.target.value = '';
  }, []);

  const move = (i: number, d: -1 | 1) => setFiles(prev => {
    const j = i + d;
    if (j < 0 || j >= prev.length) return prev;
    const next = [...prev];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const remove = (i: number) => setFiles(prev => prev.filter((_, idx) => idx !== i));

  const convert = useCallback(async () => {
    if (!files.length) return;
    setBusy(true); setResult(null);
    try {
      const fd = new FormData();
      files.forEach(f => fd.append('files', f, f.name));
      fd.append('dpi', String(dpi));
      const res = await fetch(`${BACKEND_URL}/api/images-to-pdf`, { method: 'POST', body: fd });
      if (!res.ok) {
        let msg = res.statusText;
        try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
        toast.error('Convert failed: ' + msg);
        return;
      }
      const r: Result = {
        pages: Number(res.headers.get('X-Pdf-Pages') || 0),
        passthrough: Number(res.headers.get('X-Pdf-Passthrough') || 0),
        skipped: Number(res.headers.get('X-Pdf-Skipped') || 0),
      };
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'images.pdf'; a.click();
      URL.revokeObjectURL(url);
      setResult(r);
      toast.success(`PDF created — ${r.pages} page${r.pages !== 1 ? 's' : ''} at full resolution`);
    } catch (e: any) {
      toast.error('Convert error: ' + String(e).slice(0, 140));
    } finally {
      setBusy(false);
    }
  }, [files, dpi]);

  return (
    <div className="min-h-screen bg-background text-foreground p-6">
      <div className="max-w-3xl mx-auto space-y-5">
        <header className="flex items-center gap-3">
          <Images className="w-6 h-6 text-primary" />
          <div>
            <h1 className="text-lg font-bold">Images → PDF</h1>
            <p className="text-xs text-muted-foreground">
              Full resolution. No downscaling, no re-compression — JPEGs are embedded byte-for-byte.
            </p>
          </div>
          <a href="/" className="ml-auto text-xs text-primary underline">← Back to main</a>
        </header>

        {/* Pick */}
        <div className="flex gap-3">
          <button type="button" onClick={() => fileRef.current?.click()}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg border border-dashed border-primary/40 hover:bg-primary/5 text-sm font-medium">
            <Images className="w-4 h-4 text-primary" /> Add images
          </button>
          <button type="button" onClick={() => folderRef.current?.click()}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg border border-dashed border-primary/40 hover:bg-primary/5 text-sm font-medium">
            <FolderOpen className="w-4 h-4 text-primary" /> Add a folder
          </button>
          <input ref={fileRef} type="file" accept=".png,.jpg,.jpeg,.tif,.tiff,.bmp,.webp,.gif,image/*" multiple className="hidden" onChange={addFiles} />
          <input ref={attachDir} type="file" multiple className="hidden" onChange={addFiles} />
        </div>

        {/* Options */}
        <div className="flex items-center gap-3 flex-wrap text-sm">
          <label className="flex items-center gap-2">
            Page size DPI:
            <select value={dpi} onChange={e => setDpi(Number(e.target.value))}
              className="bg-muted rounded px-2 py-1 text-sm">
              <option value={72}>72 (1 px = 1 pt, biggest page)</option>
              <option value={96}>96 (screen, default)</option>
              <option value={150}>150</option>
              <option value={200}>200</option>
              <option value={300}>300 (print)</option>
            </select>
          </label>
          <span className="text-[11px] text-muted-foreground">
            DPI only sets the page's physical size — pixels are always embedded 1:1.
          </span>
        </div>

        {/* List */}
        {files.length > 0 && (
          <div className="border rounded-lg divide-y max-h-[340px] overflow-auto">
            {files.map((f, i) => (
              <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                <span className="w-6 text-muted-foreground tabular-nums">{i + 1}</span>
                <span className="flex-1 truncate">{f.name}</span>
                <span className="text-muted-foreground tabular-nums">{(f.size / 1024).toFixed(0)} KB</span>
                <button type="button" aria-label="Move up" title="Move up" onClick={() => move(i, -1)} disabled={i === 0}
                  className="p-1 rounded hover:bg-muted disabled:opacity-30"><ArrowUp className="w-3.5 h-3.5" /></button>
                <button type="button" aria-label="Move down" title="Move down" onClick={() => move(i, 1)} disabled={i === files.length - 1}
                  className="p-1 rounded hover:bg-muted disabled:opacity-30"><ArrowDown className="w-3.5 h-3.5" /></button>
                <button type="button" aria-label="Remove" title="Remove" onClick={() => remove(i)}
                  className="p-1 rounded hover:bg-destructive/10 text-destructive"><X className="w-3.5 h-3.5" /></button>
              </div>
            ))}
          </div>
        )}

        {files.length > 0 && (
          <div className="flex items-center gap-3">
            <button type="button" onClick={convert} disabled={busy}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50">
              {busy ? <><Loader2 className="w-5 h-5 animate-spin" /> Building PDF…</>
                    : <><FileDown className="w-5 h-5" /> Convert {files.length} image{files.length !== 1 ? 's' : ''} → PDF</>}
            </button>
            <button type="button" onClick={() => { setFiles([]); setResult(null); }}
              className="px-3 py-3 rounded-lg border text-sm hover:bg-muted">Clear</button>
          </div>
        )}

        {result && (
          <div className="rounded-lg border bg-muted/40 p-4 text-sm">
            <div className="font-semibold flex items-center gap-2"><FileDown className="w-4 h-4 text-primary" /> PDF downloaded</div>
            <ul className="text-xs text-muted-foreground mt-1 space-y-0.5">
              <li><b>{result.pages}</b> pages, each at its image's native pixel size</li>
              <li><b>{result.passthrough}</b> JPEG{result.passthrough !== 1 ? 's' : ''} embedded byte-for-byte (zero loss)</li>
              {result.skipped > 0 && <li className="text-destructive"><b>{result.skipped}</b> file(s) skipped</li>}
            </ul>
          </div>
        )}

        {files.length === 0 && (
          <div className="text-sm text-muted-foreground border border-dashed rounded-lg p-8 text-center">
            Add images (or a whole folder) to begin. They're ordered naturally by filename — reorder or remove any before converting.
          </div>
        )}
      </div>
    </div>
  );
}
