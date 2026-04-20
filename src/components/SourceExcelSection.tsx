import { useRef, useState, useMemo } from 'react';
import { Sheet, Upload, X, ChevronDown, Key, Search, CheckCircle2 } from 'lucide-react';
import type { SourceExcel } from '@/lib/automap/excel-reader';
import { fieldsForDocType, type HeaderToField } from '@/lib/automap/header-mapping';
import type { DocumentType, FieldLabel } from '@/types/utilscraper';

// ───────────────────────────────────────────────────────────────────────────
// Sidebar block for the optional "source Excel" feature. Before an Excel
// is uploaded this collapses to a single button. After upload it shows
// the filename summary and a scrollable, filterable list of header rows
// where each row has a canonical-field dropdown plus a 🔑 row-key toggle.
// ───────────────────────────────────────────────────────────────────────────

interface Props {
  sourceExcel: SourceExcel | null;
  docType: DocumentType | null;
  headerMappings: HeaderToField[];
  rowKeyHeader: string | null;
  onUpload: (file: File) => void;
  onClear: () => void;
  onFieldRemap: (excelHeader: string, fieldKey: FieldLabel | null, fieldLabel: string | null) => void;
  onSetRowKey: (excelHeader: string | null) => void;
}

export default function SourceExcelSection({
  sourceExcel, docType, headerMappings, rowKeyHeader,
  onUpload, onClear, onFieldRemap, onSetRowKey,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState('');
  const [hideMapped, setHideMapped] = useState(false);

  const mappedCount = useMemo(
    () => headerMappings.filter(m => m.fieldKey).length,
    [headerMappings],
  );

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return headerMappings.filter(m => {
      if (hideMapped && m.fieldKey) return false;
      if (q && !m.excelHeader.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [headerMappings, filter, hideMapped]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Sheet className="w-3.5 h-3.5 text-primary" />
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Source Excel {!sourceExcel && <span className="text-muted-foreground/60 lowercase">(optional)</span>}
        </h2>
      </div>

      {!sourceExcel ? (
        <button
          type="button"
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-dashed border-border hover:border-primary/50 hover:bg-primary/5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => inputRef.current?.click()}
          title="Upload your output Excel template. Extracted values will be written into it."
        >
          <Upload className="w-3.5 h-3.5" />
          Upload source Excel
        </button>
      ) : (
        <>
          {/* Summary chip */}
          <div className="flex items-center gap-1.5 bg-primary/5 border border-primary/20 rounded-md px-2.5 py-2">
            <Sheet className="w-3.5 h-3.5 text-primary shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold text-foreground truncate" title={sourceExcel.sheetName}>
                {sourceExcel.sheetName}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {sourceExcel.headers.length} cols · {sourceExcel.rows.length} rows
                {rowKeyHeader && (
                  <> · <span className="text-amber-600 inline-flex items-center gap-0.5"><Key className="w-2.5 h-2.5" />{rowKeyHeader}</span></>
                )}
              </p>
            </div>
            <button
              className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              onClick={onClear}
              title="Remove source Excel — reverts to normal export"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Mapping progress + filter */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${(mappedCount / Math.max(1, headerMappings.length)) * 100}%` }}
                />
              </div>
              <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
                {mappedCount}/{headerMappings.length} mapped
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <div className="flex-1 flex items-center bg-muted/60 rounded px-2">
                <Search className="w-3 h-3 text-muted-foreground shrink-0" />
                <input
                  className="flex-1 bg-transparent text-[11px] px-1.5 py-1 outline-none text-foreground placeholder:text-muted-foreground/70"
                  placeholder="Filter headers…"
                  value={filter}
                  onChange={e => setFilter(e.target.value)}
                />
                {filter && (
                  <button
                    onClick={() => setFilter('')}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
              <label
                className="flex items-center gap-1 text-[10px] text-muted-foreground whitespace-nowrap cursor-pointer select-none"
                title="Hide rows that already have a canonical field picked"
              >
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={hideMapped}
                  onChange={e => setHideMapped(e.target.checked)}
                />
                Hide mapped
              </label>
            </div>
          </div>

          {/* Mapping list */}
          <ul className="border border-border rounded-md overflow-hidden divide-y divide-border/60 max-h-80 overflow-y-auto custom-scrollbar">
            {visible.length === 0 && (
              <li className="px-3 py-6 text-center text-[11px] text-muted-foreground">
                {filter ? 'No headers match this filter.' : 'All headers already mapped.'}
              </li>
            )}
            {visible.map(m => (
              <MappingRow
                key={m.excelHeader}
                mapping={m}
                docType={docType}
                isRowKey={m.excelHeader === rowKeyHeader}
                onFieldRemap={(fk, fl) => onFieldRemap(m.excelHeader, fk, fl)}
                onSetRowKey={() => onSetRowKey(m.excelHeader === rowKeyHeader ? null : m.excelHeader)}
              />
            ))}
          </ul>
        </>
      )}

      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xlsm,.xls"
        className="hidden"
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) onUpload(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}

// ── Mapping row ─────────────────────────────────────────────────────────────
interface RowProps {
  mapping: HeaderToField;
  docType: DocumentType | null;
  isRowKey: boolean;
  onFieldRemap: (fieldKey: FieldLabel | null, fieldLabel: string | null) => void;
  onSetRowKey: () => void;
}

function MappingRow({ mapping, docType, isRowKey, onFieldRemap, onSetRowKey }: RowProps) {
  const [open, setOpen] = useState(false);
  const options = fieldsForDocType(docType);
  const isMapped = !!mapping.fieldKey;

  return (
    <li className={`px-2.5 py-2 transition-colors ${isMapped ? 'bg-primary/[0.03]' : 'hover:bg-muted/30'}`}>
      {/* Top: header text + row-key star */}
      <div className="flex items-center gap-1.5">
        {isMapped ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-primary shrink-0" />
        ) : (
          <span className="w-3.5 h-3.5 rounded-full border border-muted-foreground/30 shrink-0" />
        )}
        <span
          className={`text-xs font-medium truncate flex-1 ${isMapped ? 'text-foreground' : 'text-foreground/80'}`}
          title={mapping.excelHeader}
        >
          {mapping.excelHeader || <i className="text-muted-foreground">(empty)</i>}
        </span>
        <button
          type="button"
          className={`shrink-0 p-0.5 rounded transition-colors ${
            isRowKey
              ? 'text-amber-500 bg-amber-500/15'
              : 'text-muted-foreground/50 hover:text-amber-500 hover:bg-amber-500/10'
          }`}
          onClick={onSetRowKey}
          title={isRowKey
            ? 'Row-key column — each PDF lands in the row where its extracted value matches this column.'
            : 'Mark this column as the row identifier (used to place each PDF in the matching Excel row).'}
        >
          <Key className="w-3 h-3" />
        </button>
      </div>

      {/* Bottom: canonical-field pill (dropdown) */}
      <div className="mt-1 ml-5">
        <button
          type="button"
          className={`w-full flex items-center justify-between gap-1 px-2 py-1 rounded border text-[11px] transition-colors
            ${isMapped
              ? 'bg-primary/10 border-primary/30 text-primary hover:bg-primary/15'
              : 'bg-muted border-border text-muted-foreground hover:border-primary/40 hover:text-foreground'}`}
          onClick={() => setOpen(o => !o)}
        >
          <span className="truncate">{mapping.fieldLabel || 'Pick a field…'}</span>
          <ChevronDown className="w-3 h-3 shrink-0" />
        </button>

        {open && (
          <div className="mt-1 bg-card border border-border rounded shadow-lg py-1 max-h-56 overflow-y-auto custom-scrollbar">
            <button
              className={`w-full text-left px-2 py-1 text-[11px] hover:bg-muted ${mapping.fieldKey === null ? 'bg-muted font-semibold' : ''}`}
              onClick={() => { onFieldRemap(null, null); setOpen(false); }}
            >
              <span className="italic text-muted-foreground">Unmapped</span>
            </button>
            {options.map(opt => (
              <button
                key={opt.fieldKey}
                className={`w-full text-left px-2 py-1 text-[11px] hover:bg-muted flex items-center justify-between gap-2
                  ${opt.fieldKey === mapping.fieldKey ? 'bg-muted font-semibold' : ''}`}
                onClick={() => { onFieldRemap(opt.fieldKey, opt.fieldLabel); setOpen(false); }}
              >
                <span className="truncate">{opt.fieldLabel}</span>
                <span className="text-[9px] text-muted-foreground shrink-0 uppercase tracking-wide">{opt.fieldKey}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}
