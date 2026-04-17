import { useRef } from 'react';
import { FileText, Sheet, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DOCUMENT_TYPES, type DocumentType } from '@/types/utilscraper';

interface Props {
  docType: DocumentType | null;
  onDocTypeChange: (t: DocumentType) => void;
  pdfFiles: File[];
  excelFile: File | null;
  onPdfsChange: (f: File[]) => void;
  onExcelChange: (f: File | null) => void;
  onStart: () => void;
  running: boolean;
}

export default function DualUpload({
  docType, onDocTypeChange,
  pdfFiles, excelFile, onPdfsChange, onExcelChange, onStart, running,
}: Props) {
  const pdfRef = useRef<HTMLInputElement>(null);
  const xlRef  = useRef<HTMLInputElement>(null);
  const ready = !!docType && pdfFiles.length > 0 && !!excelFile;

  return (
    <div className="space-y-3">
      {/* Doc type — required before anything else */}
      <div>
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
          Document type
        </label>
        <div className="grid grid-cols-2 gap-1.5 mt-1.5">
          {DOCUMENT_TYPES.map(dt => (
            <button
              key={dt.value}
              type="button"
              onClick={() => onDocTypeChange(dt.value)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs font-medium transition-colors
                ${docType === dt.value
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border hover:border-primary/50 text-muted-foreground hover:text-foreground'}`}
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: dt.color }} />
              <span className="truncate">{dt.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Multi-PDF tile */}
      <div
        role="button"
        tabIndex={0}
        className="border border-dashed border-border hover:border-primary/50 hover:bg-primary/5
                   rounded-lg p-3 cursor-pointer transition-colors"
        onClick={() => pdfRef.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={e => {
          e.preventDefault();
          const dropped = Array.from(e.dataTransfer.files).filter(f =>
            f.type === 'application/pdf' || /\.pdf$/i.test(f.name),
          );
          if (dropped.length) onPdfsChange([...pdfFiles, ...dropped]);
        }}
      >
        <div className="flex items-center gap-3">
          <FileText className="w-5 h-5 text-primary" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-foreground">Source PDF{pdfFiles.length > 1 ? 's' : ''}</p>
            <p className="text-[11px] text-muted-foreground">
              {pdfFiles.length === 0
                ? 'Drop one or more PDFs — they get processed in order, one row each'
                : `${pdfFiles.length} file${pdfFiles.length !== 1 ? 's' : ''} queued`}
            </p>
          </div>
          <Upload className="w-4 h-4 text-muted-foreground shrink-0" />
        </div>

        {pdfFiles.length > 0 && (
          <ul className="mt-2 space-y-1" onClick={e => e.stopPropagation()}>
            {pdfFiles.map((f, i) => (
              <li key={i} className="flex items-center gap-1.5 text-[11px] bg-muted/40 rounded px-2 py-1">
                <FileText className="w-3 h-3 text-primary shrink-0" />
                <span className="truncate flex-1 text-foreground/80">{f.name}</span>
                <button
                  className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-destructive"
                  title="Remove"
                  onClick={() => onPdfsChange(pdfFiles.filter((_, k) => k !== i))}
                >
                  <X className="w-3 h-3" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <input
          ref={pdfRef}
          type="file"
          accept=".pdf"
          multiple
          className="hidden"
          onChange={e => {
            const next = Array.from(e.target.files || []);
            if (next.length) onPdfsChange([...pdfFiles, ...next]);
            e.target.value = '';
          }}
        />
      </div>

      {/* Excel tile — single file */}
      <div
        role="button"
        tabIndex={0}
        className="border border-dashed border-border hover:border-primary/50 hover:bg-primary/5
                   rounded-lg p-3 cursor-pointer transition-colors"
        onClick={() => xlRef.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={e => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f) onExcelChange(f);
        }}
      >
        <div className="flex items-center gap-3">
          <Sheet className="w-5 h-5 text-primary" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-foreground">Source output Excel</p>
            {excelFile ? (
              <p className="text-[11px] text-foreground/70 truncate">{excelFile.name}</p>
            ) : (
              <p className="text-[11px] text-muted-foreground">The template workbook whose headers we'll map and fill</p>
            )}
          </div>
          <Upload className="w-4 h-4 text-muted-foreground shrink-0" />
        </div>
        <input
          ref={xlRef}
          type="file"
          accept=".xlsx,.xlsm,.xls"
          className="hidden"
          onChange={e => {
            const f = e.target.files?.[0] ?? null;
            onExcelChange(f);
            e.target.value = '';
          }}
        />
      </div>

      <Button
        className="w-full"
        onClick={onStart}
        disabled={!ready || running}
      >
        {running
          ? 'Working…'
          : ready
            ? `Start · read Excel & process ${pdfFiles.length > 1 ? `${pdfFiles.length} PDFs` : 'PDF'}`
            : !docType
              ? 'Pick a document type first'
              : 'Pick PDF(s) + Excel to continue'}
      </Button>
    </div>
  );
}
