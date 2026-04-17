import { useRef } from 'react';
import { FileText, Sheet, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  pdfFile: File | null;
  excelFile: File | null;
  onPdfChange: (f: File | null) => void;
  onExcelChange: (f: File | null) => void;
  onStart: () => void;
  running: boolean;
}

export default function DualUpload({
  pdfFile, excelFile, onPdfChange, onExcelChange, onStart, running,
}: Props) {
  const pdfRef = useRef<HTMLInputElement>(null);
  const xlRef  = useRef<HTMLInputElement>(null);
  const ready = !!pdfFile && !!excelFile;

  return (
    <div className="space-y-3">
      <Tile
        icon={<FileText className="w-5 h-5" />}
        label="Source PDF"
        hint="Drag-drop or click to pick the document to extract from"
        file={pdfFile}
        accept=".pdf"
        inputRef={pdfRef}
        onFile={onPdfChange}
      />
      <Tile
        icon={<Sheet className="w-5 h-5" />}
        label="Source output Excel"
        hint="The template workbook whose headers we'll map and fill"
        file={excelFile}
        accept=".xlsx,.xlsm,.xls"
        inputRef={xlRef}
        onFile={onExcelChange}
      />
      <Button
        className="w-full"
        onClick={onStart}
        disabled={!ready || running}
      >
        {running ? 'Matching…' : ready ? 'Read headers & auto-match' : 'Pick both files to continue'}
      </Button>
    </div>
  );
}

interface TileProps {
  icon: React.ReactNode;
  label: string;
  hint: string;
  file: File | null;
  accept: string;
  inputRef: React.RefObject<HTMLInputElement>;
  onFile: (f: File | null) => void;
}

function Tile({ icon, label, hint, file, accept, inputRef, onFile }: TileProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      className="border border-dashed border-border hover:border-primary/50 hover:bg-primary/5
                 rounded-lg p-3 cursor-pointer transition-colors"
      onClick={() => inputRef.current?.click()}
      onDragOver={e => e.preventDefault()}
      onDrop={e => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
    >
      <div className="flex items-center gap-3">
        <div className="text-primary">{icon}</div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-foreground">{label}</p>
          {file ? (
            <p className="text-[11px] text-foreground/70 truncate">{file.name}</p>
          ) : (
            <p className="text-[11px] text-muted-foreground">{hint}</p>
          )}
        </div>
        <Upload className="w-4 h-4 text-muted-foreground shrink-0" />
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={e => {
          const f = e.target.files?.[0] ?? null;
          onFile(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}
