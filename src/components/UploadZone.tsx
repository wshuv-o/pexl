import { useCallback, useRef, useState } from 'react';
import { Upload, FileText, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DOCUMENT_TYPES, type DocumentType } from '@/types/utilscraper';

interface UploadZoneProps {
  compact: boolean;
  onFilesSelected: (files: File[]) => void;
  hasFiles: boolean;
  pendingFiles: File[];
  docType: DocumentType;
  onDocTypeChange: (t: DocumentType) => void;
  onProcess: () => void;
  processing: boolean;
}

export default function UploadZone({
  compact, onFilesSelected, hasFiles, pendingFiles, docType, onDocTypeChange, onProcess, processing,
}: UploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');
    if (files.length) onFilesSelected(files);
  }, [onFilesSelected]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length) onFilesSelected(files);
    e.target.value = '';
  }, [onFilesSelected]);

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
          <span className="text-muted-foreground text-xs">Drop more PDFs or click to browse</span>
          <input ref={inputRef} type="file" accept=".pdf" multiple className="hidden" onChange={handleChange} />
        </div>

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
        <p className="text-xs text-muted-foreground mt-1">PDF files only · multiple allowed</p>
        <input ref={inputRef} type="file" accept=".pdf" multiple className="hidden" onChange={handleChange} />
      </div>

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