import { useCallback, useEffect, useRef, useState } from 'react';
import { Upload, FileText, FolderOpen, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DOCUMENT_TYPES, type DocumentType } from '@/types/utilscraper';

interface UploadZoneProps {
  compact: boolean;
  onFilesSelected: (files: File[]) => void;
  pendingFiles: File[];
  docType: DocumentType;
  onDocTypeChange: (t: DocumentType) => void;
  onProcess: () => void;
  processing: boolean;
}

export default function UploadZone({
  compact, onFilesSelected, pendingFiles, docType, onDocTypeChange, onProcess, processing,
}: UploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const folderInputCompactRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  // Comma-separated filename prefixes (e.g. "APR, ASR") applied when the
  // user picks a folder or drops a folder. Empty → no filter. Individual
  // file picks/drops are never filtered because the user chose them.
  const [prefixFilter, setPrefixFilter] = useState('');

  const parsePrefixes = (raw: string) =>
    raw.split(',').map(p => p.trim().toLowerCase()).filter(p => p.length > 0);

  const matchesPrefix = (filename: string, prefixes: string[]) => {
    if (prefixes.length === 0) return true;
    const lower = filename.toLowerCase();
    return prefixes.some(p => lower.startsWith(p));
  };

  // webkitdirectory isn't in React's InputHTMLAttributes, so set it via DOM.
  useEffect(() => {
    for (const ref of [folderInputRef, folderInputCompactRef]) {
      if (ref.current) {
        ref.current.setAttribute('webkitdirectory', '');
        ref.current.setAttribute('directory', '');
      }
    }
  }, []);

  // Backend accepts PDF + Word (DOC / DOCX); Word docs are converted to
  // PDF server-side before OCR/extraction.
  const isSupportedDoc = (f: File) =>
    f.type === 'application/pdf'
    || f.type === 'application/msword'
    || f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || /\.(pdf|docx?)$/i.test(f.name);

  // Recursively walk a dropped FileSystemEntry tree (folders on drag-drop).
  const collectFilesFromEntry = useCallback(
    async (entry: FileSystemEntry | null): Promise<File[]> => {
      if (!entry) return [];
      if (entry.isFile) {
        const fileEntry = entry as FileSystemFileEntry;
        return new Promise<File[]>(resolve => {
          fileEntry.file(f => {
            if (!isSupportedDoc(f)) { resolve([]); return; }
            // Attach the full relative path ("/TopFolder/sub/file.pdf" → "TopFolder/sub/file.pdf")
            // so the session can show a multi-segment folder path in the Folder column.
            // File.webkitRelativePath is read-only, so we use a custom property.
            const rel = entry.fullPath.replace(/^\//, '');
            try {
              Object.defineProperty(f, '__relativePath', { value: rel, configurable: true });
            } catch { /* ignore — fall back to filename only */ }
            resolve([f]);
          }, () => resolve([]));
        });
      }
      if (entry.isDirectory) {
        const dirEntry = entry as FileSystemDirectoryEntry;
        const reader = dirEntry.createReader();
        const entries: FileSystemEntry[] = await new Promise(resolve => {
          const out: FileSystemEntry[] = [];
          const readBatch = () => {
            reader.readEntries(
              batch => {
                if (batch.length === 0) resolve(out);
                else { out.push(...batch); readBatch(); }
              },
              () => resolve(out),
            );
          };
          readBatch();
        });
        const nested = await Promise.all(entries.map(collectFilesFromEntry));
        return nested.flat();
      }
      return [];
    },
    [],
  );

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);

    // Prefer the items API so dropped folders expand into their files.
    const items = e.dataTransfer.items;
    if (items && items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
      const entries = Array.from(items)
        .map(i => i.webkitGetAsEntry())
        .filter((e): e is FileSystemEntry => e !== null);
      const folderDrop = entries.some(en => en.isDirectory);
      const collected = await Promise.all(entries.map(collectFilesFromEntry));
      let files = collected.flat();
      // Apply the prefix filter only for folder-origin drops, so individual
      // file drops aren't silently discarded.
      if (folderDrop) {
        const prefixes = parsePrefixes(prefixFilter);
        files = files.filter(f => matchesPrefix(f.name, prefixes));
      }
      if (files.length) onFilesSelected(files);
      return;
    }

    // Fallback: plain file drop — no prefix filter, files were explicit.
    const files = Array.from(e.dataTransfer.files).filter(isSupportedDoc);
    if (files.length) onFilesSelected(files);
  }, [onFilesSelected, collectFilesFromEntry, prefixFilter]);

  // File-picker change — no prefix filter because the user explicitly
  // selected individual files.
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter(isSupportedDoc);
    if (files.length) onFilesSelected(files);
    e.target.value = '';
  }, [onFilesSelected]);

  // Folder-picker change — walks the whole tree (webkitdirectory flattens
  // subfolders into one flat FileList, each with webkitRelativePath set),
  // then applies the comma-separated prefix filter if provided.
  const handleFolderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const prefixes = parsePrefixes(prefixFilter);
    const files = Array.from(e.target.files || [])
      .filter(isSupportedDoc)
      .filter(f => matchesPrefix(f.name, prefixes));
    if (files.length) onFilesSelected(files);
    e.target.value = '';
  }, [onFilesSelected, prefixFilter]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); }
  }, []);

  const activeDt = DOCUMENT_TYPES.find(d => d.value === docType)!;
  const hasPending = pendingFiles.length > 0;

  const docTypeDropdown = (
    <DocTypeDropdown docType={docType} onChange={onDocTypeChange} />
  );

  if (compact) {
    return (
      <div className="space-y-2">
        {docTypeDropdown}
        <div
          role="button"
          tabIndex={0}
          className={`border border-dashed rounded-lg p-3 flex items-center gap-2.5 cursor-pointer transition-all duration-200 text-sm
            ${dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-primary/5'}`}
          onClick={() => inputRef.current?.click()}
          onKeyDown={handleKeyDown}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <Upload className="w-4 h-4 text-primary shrink-0" />
          <span className="text-muted-foreground text-xs">Drop more PDFs or Word docs · click to browse</span>
        </div>
        <input
          type="text"
          value={prefixFilter}
          onChange={e => setPrefixFilter(e.target.value)}
          placeholder="Folder prefix filter (optional) — e.g. APR, ASR"
          className="w-full h-7 px-2 bg-muted rounded text-[11px] outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/70"
          title="When picking or dropping a folder, only files whose names start with any of these comma-separated prefixes are added. Case-insensitive. Leave empty to add every supported file."
        />
        <button
          type="button"
          onClick={() => folderInputCompactRef.current?.click()}
          className="w-full flex items-center justify-center gap-1.5 text-[11px] font-medium text-primary hover:bg-primary/5 border border-dashed border-primary/30 rounded-lg py-1.5 transition-colors"
          title="Pick a parent folder — every matching file in it and its subfolders is uploaded in one click. Or drag-drop several folders into the box above."
        >
          <FolderOpen className="w-3.5 h-3.5" /> Add folders
          {prefixFilter.trim() && (
            <span className="text-[10px] text-muted-foreground font-normal">(filtered)</span>
          )}
        </button>
        <input ref={inputRef} type="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple className="hidden" onChange={handleFileChange} />
        <input ref={folderInputCompactRef} type="file" multiple className="hidden" onChange={handleFolderChange} />

        {hasPending && (
          <>
            <ul className="space-y-1">
              {pendingFiles.map((file, i) => (
                <li key={i} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <FileText className="w-3 h-3 shrink-0 text-primary" />
                  <span className="truncate">{file.name}</span>
                </li>
              ))}
            </ul>
            <Button
              className="w-full text-xs font-semibold text-white h-8"
              style={{ backgroundColor: activeDt.color }}
              onClick={onProcess}
              disabled={processing}
            >
              {processing ? 'Processing...' : `Process ${pendingFiles.length} PDF${pendingFiles.length > 1 ? 's' : ''}`}
            </Button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {docTypeDropdown}
      <div
        role="button"
        tabIndex={0}
        className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center
                    cursor-pointer transition-all duration-200 text-center
          ${dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-primary/5'}`}
        onClick={() => inputRef.current?.click()}
        onKeyDown={handleKeyDown}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <div className={`w-12 h-12 rounded-full flex items-center justify-center mb-3 transition-all duration-200
          ${dragOver ? 'bg-primary/15' : 'bg-muted'}`}>
          <Upload className={`w-6 h-6 transition-all duration-200 ${dragOver ? 'text-primary' : 'text-muted-foreground'}`} />
        </div>
        <p className="text-sm font-semibold text-foreground">Click to upload or drag and drop</p>
        <p className="text-xs text-muted-foreground mt-1">PDFs, Word docs (.doc / .docx), or folders · Word is converted server-side</p>
      </div>
      <div className="space-y-1.5">
        <label className="text-[11px] text-muted-foreground">
          Folder prefix filter <span className="text-muted-foreground/70">(optional)</span>
        </label>
        <input
          type="text"
          value={prefixFilter}
          onChange={e => setPrefixFilter(e.target.value)}
          placeholder="e.g. APR, ASR — only files starting with any of these are taken from folders"
          className="w-full h-8 px-3 bg-muted rounded-md text-xs outline-none focus:ring-2 focus:ring-primary/40 text-foreground placeholder:text-muted-foreground/70"
          title="Comma-separated filename prefixes. Case-insensitive. Only affects folder picks & folder drops; individual files are never filtered."
        />
      </div>
      <button
        type="button"
        onClick={() => folderInputRef.current?.click()}
        className="w-full flex items-center justify-center gap-2 text-xs font-medium text-primary border border-dashed border-primary/30 rounded-xl py-2.5 hover:bg-primary/5 transition-colors"
        title="Pick a folder. Click again to add more folders, or drop multiple folders into the box above."
      >
        <FolderOpen className="w-4 h-4" /> Add folders
        {prefixFilter.trim() && (
          <span className="text-[10px] text-muted-foreground font-normal">(prefix-filtered)</span>
        )}
      </button>
      <input ref={inputRef} type="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple className="hidden" onChange={handleFileChange} />
      <input ref={folderInputRef} type="file" multiple className="hidden" onChange={handleFolderChange} />

      {hasPending && (
        <>
          <ul className="space-y-1">
            {pendingFiles.map((file, i) => (
              <li key={i} className="flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1">
                <FileText className="w-3 h-3 shrink-0 text-primary" />
                <span className="truncate">{file.name}</span>
              </li>
            ))}
          </ul>
          <Button
            className="w-full text-sm font-semibold text-white"
            style={{ backgroundColor: activeDt.color }}
            onClick={onProcess}
            disabled={processing}
          >
            {processing ? 'Processing...' : `Process ${pendingFiles.length} PDF${pendingFiles.length > 1 ? 's' : ''}`}
          </Button>
        </>
      )}
    </div>
  );
}

function DocTypeDropdown({ docType, onChange }: { docType: DocumentType; onChange: (t: DocumentType) => void }) {
  const [open, setOpen] = useState(false);
  const active = DOCUMENT_TYPES.find(d => d.value === docType)!;

  return (
    <div className="relative">
      <button
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-border
                   bg-card text-xs font-medium text-foreground hover:border-primary/30 transition-all duration-200"
        onClick={() => setOpen(o => !o)}
      >
        <span className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: active.color }} />
          {active.label}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full bg-card border border-border rounded-lg shadow-lg py-1">
          {DOCUMENT_TYPES.map(dt => (
            <button
              key={dt.value}
              className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-all duration-200
                ${docType === dt.value ? 'bg-muted font-semibold text-foreground' : 'text-muted-foreground hover:bg-muted/50'}`}
              onClick={() => { onChange(dt.value); setOpen(false); }}
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: dt.color }} />
              {dt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}