import { useCallback, useEffect, useRef, useState } from 'react';
import { Upload, FileText, FolderOpen, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DOCUMENT_TYPES, type DocumentType } from '@/types/utilscraper';

interface UploadZoneProps {
  compact: boolean;
  onFilesSelected: (files: File[]) => void;
  pendingFiles: File[];
  onFileRemove: (index: number) => void;
  docType: DocumentType;
  onProcess: () => void;
  processing: boolean;
}

export default function UploadZone({
  compact, onFilesSelected, pendingFiles, onFileRemove, docType, onProcess, processing,
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

  // Doc-type picker used to live here at the top of the upload zone, but
  // it duplicated the confirm-doc-type modal that already appears right
  // before processing. Users were setting it twice. The dropdown component
  // and the confirmation modal cover every case.

  if (compact) {
    return (
      <div className="space-y-2">
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
            {/* Process button FIRST so a 300-file queue doesn't push it off
                screen. The pending list below flows naturally beneath it. */}
            <Button
              className="w-full text-xs font-semibold text-white h-8"
              style={{ backgroundColor: activeDt.color }}
              onClick={onProcess}
              disabled={processing}
            >
              {processing ? 'Processing...' : `Process ${pendingFiles.length} PDF${pendingFiles.length > 1 ? 's' : ''}`}
            </Button>
            <div className="flex items-center justify-between text-[10px] text-muted-foreground px-0.5">
              <span>{pendingFiles.length} queued</span>
              <button
                type="button"
                className="hover:text-destructive transition-colors"
                onClick={() => { for (let i = pendingFiles.length - 1; i >= 0; i--) onFileRemove(i); }}
                title="Remove all queued files"
              >
                Clear all
              </button>
            </div>
            <ul className="space-y-1">
              {pendingFiles.map((file, i) => (
                <li key={i} className="group flex items-center gap-1.5 text-xs text-muted-foreground">
                  <FileText className="w-3 h-3 shrink-0 text-primary" />
                  <span className="truncate flex-1">{file.name}</span>
                  <button
                    className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive transition-all duration-150 shrink-0"
                    onClick={() => onFileRemove(i)}
                    title="Remove from queue"
                    aria-label={`Remove ${file.name}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
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
          {/* Process button FIRST — see compact-mode comment above. */}
          <Button
            className="w-full text-sm font-semibold text-white"
            style={{ backgroundColor: activeDt.color }}
            onClick={onProcess}
            disabled={processing}
          >
            {processing ? 'Processing...' : `Process ${pendingFiles.length} PDF${pendingFiles.length > 1 ? 's' : ''}`}
          </Button>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground px-0.5">
            <span>{pendingFiles.length} queued</span>
            <button
              type="button"
              className="hover:text-destructive transition-colors"
              onClick={() => { for (let i = pendingFiles.length - 1; i >= 0; i--) onFileRemove(i); }}
              title="Remove all queued files"
            >
              Clear all
            </button>
          </div>
          <ul className="space-y-1">
            {pendingFiles.map((file, i) => (
              <li key={i} className="group flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1">
                <FileText className="w-3 h-3 shrink-0 text-primary" />
                <span className="truncate flex-1">{file.name}</span>
                <button
                  className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive transition-all duration-150 shrink-0"
                  onClick={() => onFileRemove(i)}
                  title="Remove from queue"
                  aria-label={`Remove ${file.name}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}