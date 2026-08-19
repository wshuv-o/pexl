/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { FolderOpen, Loader2, ScanLine, Download, FileSpreadsheet } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000';
const IMAGE_RE = /\.(png|jpe?g|tif|tiff|bmp|webp|gif)$/i;

type Summary = { rows: number; images: number; communities: number; errors: number };

export default function CrimeScrape() {
  const { trackPagesExtracted } = useAuth();
  const [picked, setPicked] = useState<{ files: File[]; folder: string } | null>(null);
  const [scraping, setScraping] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  // Folder-pick time stands in for "uploaded_at" here — there's no upload
  // step, the files go up with the scrape request itself.
  const pickedAtRef = useRef<number | undefined>(undefined);

  // webkitdirectory must be set via DOM (not in React's typings).
  const attachDir = useCallback((el: HTMLInputElement | null) => {
    folderInputRef.current = el;
    if (el) { el.setAttribute('webkitdirectory', ''); el.setAttribute('directory', ''); }
  }, []);

  const onPick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const all = Array.from(e.target.files || []);
    const imgs = all.filter(f => IMAGE_RE.test((f as any).webkitRelativePath || f.name));
    if (imgs.length === 0) { toast.error('No image files found in that folder.'); return; }
    const first = (imgs[0] as any).webkitRelativePath || imgs[0].name;
    const folder = first.split('/')[0] || 'folder';
    setPicked({ files: imgs, folder });
    pickedAtRef.current = Date.now();
    setSummary(null);
    toast.success(`${imgs.length} image${imgs.length !== 1 ? 's' : ''} ready from "${folder}"`);
    e.target.value = '';
  }, []);

  const scrape = useCallback(async () => {
    if (!picked) return;
    setScraping(true);
    setSummary(null);
    try {
      const fd = new FormData();
      for (const f of picked.files) {
        const rel = (f as any).webkitRelativePath || f.name;
        fd.append('files', f, f.name);
        fd.append('paths', rel);
      }
      const res = await fetch(`${BACKEND_URL}/api/crime-scrape`, { method: 'POST', body: fd });
      if (!res.ok) {
        let msg = res.statusText;
        try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
        toast.error('Scrape failed: ' + msg);
        return;
      }
      const s: Summary = {
        rows: Number(res.headers.get('X-Crime-Rows') || 0),
        images: Number(res.headers.get('X-Crime-Images') || 0),
        communities: Number(res.headers.get('X-Crime-Communities') || 0),
        errors: Number(res.headers.get('X-Crime-Errors') || 0),
      };
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${picked.folder}_crime_data.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      setSummary(s);
      toast.success(`Scraped ${s.rows} rows from ${s.communities} communities — Excel downloaded`);
      // One screenshot = one page of extracted content here (these are image
      // folders, not PDFs). X-Crime-Images is the count the backend actually
      // read, so failed images aren't billed as pages.
      trackPagesExtracted(s.images - s.errors, pickedAtRef.current, Date.now())
        .catch(() => {});
    } catch (e: any) {
      toast.error('Scrape error: ' + String(e).slice(0, 140));
    } finally {
      setScraping(false);
    }
  }, [picked, trackPagesExtracted]);

  return (
    <div className="min-h-screen bg-background text-foreground p-6">
      <div className="max-w-2xl mx-auto space-y-5">
        <header className="flex items-center gap-3">
          <ScanLine className="w-6 h-6 text-primary" />
          <div>
            <h1 className="text-lg font-bold">Crime Records — Folder Scrape</h1>
            <p className="text-xs text-muted-foreground">
              Upload a folder of community subfolders (each with crime-map screenshots) → get one combined Excel.
            </p>
          </div>
          <a href="/" className="ml-auto text-xs text-primary underline">← Back to main</a>
        </header>

        {/* Step 1: pick folder */}
        <div className="border border-dashed rounded-xl p-6 space-y-3">
          <button
            type="button"
            onClick={() => folderInputRef.current?.click()}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg border border-primary/40 hover:bg-primary/5 text-sm font-medium"
          >
            <FolderOpen className="w-5 h-5 text-primary" />
            {picked ? `Change folder (currently "${picked.folder}")` : 'Choose folder…'}
          </button>
          <input ref={attachDir} type="file" multiple className="hidden" onChange={onPick} />

          {picked && (
            <p className="text-xs text-muted-foreground text-center">
              <FileSpreadsheet className="inline w-3.5 h-3.5 mr-1" />
              {picked.files.length} image{picked.files.length !== 1 ? 's' : ''} from <b>{picked.folder}</b> — ready to scrape.
            </p>
          )}
        </div>

        {/* Step 2: scrape */}
        <button
          type="button"
          onClick={scrape}
          disabled={!picked || scraping}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50"
        >
          {scraping
            ? <><Loader2 className="w-5 h-5 animate-spin" /> Scraping… (this can take a minute for many photos)</>
            : <><Download className="w-5 h-5" /> Scrape folder → download Excel</>}
        </button>

        {/* Result summary */}
        {summary && (
          <div className="rounded-lg border bg-muted/40 p-4 text-sm space-y-1">
            <div className="font-semibold flex items-center gap-2"><FileSpreadsheet className="w-4 h-4 text-primary" /> Done — Excel downloaded</div>
            <ul className="text-xs text-muted-foreground grid grid-cols-2 gap-x-6 gap-y-0.5 mt-1">
              <li><b>{summary.rows}</b> total rows</li>
              <li><b>{summary.communities}</b> communities</li>
              <li><b>{summary.images}</b> images processed</li>
              <li className={summary.errors ? 'text-destructive' : ''}><b>{summary.errors}</b> image errors</li>
            </ul>
            <p className="text-[11px] text-muted-foreground pt-1">
              Columns: Community, Class, Incident #, Crime, Date/Time, Location Name, Address, Accuracy, Agency.
              Every photo in every subfolder is processed; duplicates are kept.
            </p>
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">
          Tip: pick the parent folder that contains the community subfolders. The subfolder name becomes the
          <b> Community</b> column. Empty ("No results found") screenshots contribute no rows.
        </p>
      </div>
    </div>
  );
}
