import { CheckCircle2, Circle, XCircle, Pencil, ChevronDown, Search, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { HeaderMatch, MatchBox } from '@/lib/automap/auto-match';
import { fieldsForDocType, type HeaderToField } from '@/lib/automap/header-mapping';
import type { FieldLabel, DocumentType } from '@/types/utilscraper';

export type MappingStatus = 'pending' | 'confirmed' | 'rejected';

export interface MappingState {
  mapping: HeaderToField;
  match:   HeaderMatch;
  status:  MappingStatus;
  override?:  string;
  chosenBox?: MatchBox | null;
}

interface Props {
  mappings:    MappingState[];
  docType:     DocumentType | null;
  activeHeader: string | null;
  onSelect:     (excelHeader: string) => void;
  onFieldRemap: (excelHeader: string, fieldKey: FieldLabel | null, fieldLabel: string | null) => void;
  onSearchTextChange: (excelHeader: string, searchText: string) => void;   // fired on blur/Enter
  onRematchAll: () => void;
  matching: boolean;
}

export default function MappingReview({
  mappings, docType, activeHeader,
  onSelect, onFieldRemap, onSearchTextChange, onRematchAll, matching,
}: Props) {
  const confirmedCount = mappings.filter(m => m.status === 'confirmed').length;
  const rejectedCount  = mappings.filter(m => m.status === 'rejected').length;
  const pendingCount   = mappings.length - confirmedCount - rejectedCount;
  const withSearch     = mappings.filter(m => m.mapping.searchText.trim()).length;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border space-y-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold text-foreground flex-1">Header mapping</h2>
          <button
            className="flex items-center gap-1 text-[11px] font-medium text-primary hover:underline disabled:opacity-40"
            disabled={matching || withSearch === 0}
            onClick={onRematchAll}
          >
            <RefreshCw className={`w-3 h-3 ${matching ? 'animate-spin' : ''}`} />
            Re-match all
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {withSearch}/{mappings.length} with search text · {confirmedCount} confirmed · {pendingCount} pending · {rejectedCount} rejected
        </p>
      </div>
      <ul className="flex-1 overflow-auto custom-scrollbar">
        {mappings.map(m => (
          <MappingRow
            key={m.mapping.excelHeader}
            state={m}
            docType={docType}
            isActive={m.mapping.excelHeader === activeHeader}
            onSelect={() => onSelect(m.mapping.excelHeader)}
            onFieldRemap={(fk, fl) => onFieldRemap(m.mapping.excelHeader, fk, fl)}
            onSearchTextCommit={txt => onSearchTextChange(m.mapping.excelHeader, txt)}
          />
        ))}
      </ul>
    </div>
  );
}

interface RowProps {
  state: MappingState;
  docType: DocumentType | null;
  isActive: boolean;
  onSelect: () => void;
  onFieldRemap: (fieldKey: FieldLabel | null, fieldLabel: string | null) => void;
  onSearchTextCommit: (text: string) => void;
}

function MappingRow({ state, docType, isActive, onSelect, onFieldRemap, onSearchTextCommit }: RowProps) {
  const [open, setOpen] = useState(false);
  const [searchDraft, setSearchDraft] = useState(state.mapping.searchText);
  useEffect(() => { setSearchDraft(state.mapping.searchText); }, [state.mapping.searchText]);

  const { mapping, status, match, override, chosenBox } = state;
  const box = chosenBox ?? match.box;
  const displayValue = override ?? box?.value ?? '';
  const options = fieldsForDocType(docType);

  const commitSearch = () => {
    const next = searchDraft.trim();
    if (next !== state.mapping.searchText.trim()) onSearchTextCommit(next);
  };

  return (
    <li
      className={`px-3 py-2 border-b border-border/40 cursor-pointer transition-colors
        ${isActive ? 'bg-primary/10 border-l-[3px] border-l-primary'
                   : 'hover:bg-muted/50 border-l-[3px] border-l-transparent'}`}
      onClick={onSelect}
    >
      {/* Row 1: status + excel header */}
      <div className="flex items-center gap-2">
        {status === 'confirmed' && <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />}
        {status === 'rejected'  && <XCircle      className="w-3.5 h-3.5 text-red-500 shrink-0" />}
        {status === 'pending'   && <Circle       className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
        <span className="text-xs font-semibold text-foreground truncate flex-1" title={mapping.excelHeader}>
          {mapping.excelHeader || <i className="text-muted-foreground">(empty header)</i>}
        </span>
        {override !== undefined && <Pencil className="w-3 h-3 text-amber-500 shrink-0" />}
      </div>

      {/* Row 2: field dropdown */}
      <div className="flex items-center gap-1.5 mt-1.5 ml-5">
        <span className="text-[10px] uppercase text-muted-foreground tracking-wide w-10">field</span>
        <button
          type="button"
          className={`flex-1 inline-flex items-center justify-between px-2 py-1 rounded border text-[11px]
            ${mapping.fieldLabel
              ? 'bg-primary/5 border-primary/30 text-primary'
              : 'bg-muted border-border text-muted-foreground'}`}
          onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        >
          <span className="truncate">{mapping.fieldLabel || 'Unmapped'}</span>
          <ChevronDown className="w-3 h-3 shrink-0" />
        </button>
      </div>

      {open && (
        <div
          className="mt-1 ml-[60px] bg-card border border-border rounded shadow-sm py-1 max-h-60 overflow-y-auto"
          onClick={e => e.stopPropagation()}
        >
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
              <span className="text-[9px] text-muted-foreground shrink-0 uppercase tracking-wide">
                {opt.fieldKey}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Row 3: user search text */}
      <div className="flex items-center gap-1.5 mt-1.5 ml-5">
        <span className="text-[10px] uppercase text-muted-foreground tracking-wide w-10">search</span>
        <div className="flex-1 flex items-center bg-muted rounded px-1.5">
          <Search className="w-3 h-3 text-muted-foreground shrink-0" />
          <input
            className="flex-1 bg-transparent text-[11px] px-1 py-1 outline-none text-foreground placeholder:text-muted-foreground/60"
            placeholder="Exact phrase to find in PDF"
            value={searchDraft}
            onClick={e => e.stopPropagation()}
            onChange={e => setSearchDraft(e.target.value)}
            onBlur={commitSearch}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commitSearch(); }
              if (e.key === 'Escape') setSearchDraft(state.mapping.searchText);
            }}
          />
        </div>
      </div>

      {/* Row 4: extracted value preview */}
      {(displayValue || box) && (
        <div className="flex items-center gap-1.5 mt-1 ml-5 text-[11px]">
          <span className="text-[10px] uppercase text-muted-foreground tracking-wide w-10">value</span>
          <span className={`truncate flex-1 ${box ? 'text-foreground/80' : 'text-muted-foreground italic'}`}>
            {displayValue || '—'}
          </span>
          {box && !override && (
            <span className="text-[10px] text-muted-foreground shrink-0">p{box.page}</span>
          )}
        </div>
      )}
    </li>
  );
}
