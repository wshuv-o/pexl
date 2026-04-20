import { CheckCircle2, Circle, XCircle, Pencil, ChevronDown, Search, RefreshCw, SquareCheck, Square, Key } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { HeaderMatch, MatchBox } from '@/lib/automap/auto-match';
import { fieldsForDocType, type HeaderToField } from '@/lib/automap/header-mapping';
import type { FieldLabel, DocumentType } from '@/types/utilscraper';

export type MappingStatus = 'pending' | 'confirmed' | 'rejected';

export interface MappingState {
  mapping:  HeaderToField;
  match:    HeaderMatch;
  status:   MappingStatus;
  included: boolean;          // opt-in — only included rows are matched / downloaded
  override?:  string;
  chosenBox?: MatchBox | null;
}

interface Props {
  mappings:    MappingState[];
  docType:     DocumentType | null;
  activeHeader: string | null;
  rowKeyHeader: string | null;         // which column's value identifies the Excel row
  onSelect:     (excelHeader: string) => void;
  onFieldRemap: (excelHeader: string, fieldKey: FieldLabel | null, fieldLabel: string | null) => void;
  onSearchTextChange: (excelHeader: string, searchText: string) => void;   // fired on blur/Enter
  onToggleIncluded:   (excelHeader: string, included: boolean) => void;
  onIncludeAll:       (included: boolean) => void;
  onSetRowKey:        (excelHeader: string | null) => void;
  onRematchAll: () => void;
  matching: boolean;
}

export default function MappingReview({
  mappings, docType, activeHeader, rowKeyHeader,
  onSelect, onFieldRemap, onSearchTextChange, onToggleIncluded, onIncludeAll,
  onSetRowKey, onRematchAll, matching,
}: Props) {
  const [hideExcluded, setHideExcluded] = useState(false);
  const [query, setQuery] = useState('');

  const includedCount  = mappings.filter(m => m.included).length;
  const confirmedCount = mappings.filter(m => m.included && m.status === 'confirmed').length;
  const withSearch     = mappings.filter(m => m.included && m.mapping.searchText.trim()).length;
  const allIncluded    = includedCount === mappings.length && mappings.length > 0;

  const visibleMappings = useMemo(() => {
    const q = query.trim().toLowerCase();
    return mappings.filter(m => {
      if (hideExcluded && !m.included) return false;
      if (q && !m.mapping.excelHeader.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [mappings, hideExcluded, query]);

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
          <span className="text-foreground font-medium">{includedCount}</span> / {mappings.length} included ·
          &nbsp;{confirmedCount} confirmed · {withSearch} with search
        </p>
        <p className="text-[10px] text-muted-foreground/80 italic">
          Tip: click the <Key className="w-2.5 h-2.5 inline text-amber-500" /> on a column like
          <span className="text-foreground"> Unit&nbsp;ID </span>
          to pick which Excel row each PDF goes into.
        </p>

        {/* Filter + bulk controls */}
        <div className="flex items-center gap-1.5">
          <div className="flex-1 flex items-center bg-muted rounded px-1.5">
            <Search className="w-3 h-3 text-muted-foreground shrink-0" />
            <input
              className="flex-1 bg-transparent text-[11px] px-1 py-1 outline-none"
              placeholder="Filter headers…"
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
          </div>
          <button
            className="text-[10px] px-2 py-1 rounded bg-muted hover:bg-muted/70 text-foreground/80 whitespace-nowrap"
            onClick={() => onIncludeAll(!allIncluded)}
            title={allIncluded ? 'Exclude every row' : 'Include every row'}
          >
            {allIncluded ? 'Exclude all' : 'Include all'}
          </button>
          <label
            className="flex items-center gap-1 text-[10px] text-foreground/70 whitespace-nowrap cursor-pointer select-none"
            title="Hide rows you haven't opted into"
          >
            <input
              type="checkbox"
              className="accent-primary"
              checked={hideExcluded}
              onChange={e => setHideExcluded(e.target.checked)}
            />
            Hide excluded
          </label>
        </div>
      </div>

      <ul className="flex-1 overflow-auto custom-scrollbar">
        {visibleMappings.length === 0 && (
          <li className="px-4 py-6 text-center text-[11px] text-muted-foreground">
            {query
              ? `No headers match "${query}".`
              : hideExcluded
                ? 'No included rows yet — uncheck "Hide excluded" or click "Include all".'
                : 'No mappings.'}
          </li>
        )}
        {visibleMappings.map(m => (
          <MappingRow
            key={m.mapping.excelHeader}
            state={m}
            docType={docType}
            isActive={m.mapping.excelHeader === activeHeader}
            isRowKey={m.mapping.excelHeader === rowKeyHeader}
            onSelect={() => m.included && onSelect(m.mapping.excelHeader)}
            onFieldRemap={(fk, fl) => onFieldRemap(m.mapping.excelHeader, fk, fl)}
            onSearchTextCommit={txt => onSearchTextChange(m.mapping.excelHeader, txt)}
            onToggleIncluded={v => onToggleIncluded(m.mapping.excelHeader, v)}
            onSetRowKey={() =>
              onSetRowKey(m.mapping.excelHeader === rowKeyHeader ? null : m.mapping.excelHeader)
            }
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
  isRowKey: boolean;
  onSelect: () => void;
  onFieldRemap: (fieldKey: FieldLabel | null, fieldLabel: string | null) => void;
  onSearchTextCommit: (text: string) => void;
  onToggleIncluded: (included: boolean) => void;
  onSetRowKey: () => void;
}

function MappingRow({
  state, docType, isActive, isRowKey,
  onSelect, onFieldRemap, onSearchTextCommit, onToggleIncluded, onSetRowKey,
}: RowProps) {
  const [open, setOpen] = useState(false);
  const [searchDraft, setSearchDraft] = useState(state.mapping.searchText);
  useEffect(() => { setSearchDraft(state.mapping.searchText); }, [state.mapping.searchText]);

  const { mapping, status, match, override, chosenBox, included } = state;
  const box = chosenBox ?? match.box;
  const displayValue = override ?? box?.value ?? '';
  const options = fieldsForDocType(docType);

  const commitSearch = () => {
    const next = searchDraft.trim();
    if (next !== state.mapping.searchText.trim()) onSearchTextCommit(next);
  };

  return (
    <li
      className={`px-3 py-2 border-b border-border/40 transition-colors
        ${included ? 'cursor-pointer' : 'opacity-60'}
        ${isActive ? 'bg-primary/10 border-l-[3px] border-l-primary'
                   : included ? 'hover:bg-muted/50 border-l-[3px] border-l-transparent'
                              : 'bg-muted/10 border-l-[3px] border-l-transparent'}`}
      onClick={onSelect}
    >
      {/* Row 1: include checkbox + status + excel header */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={`shrink-0 transition-colors ${included ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
          onClick={e => { e.stopPropagation(); onToggleIncluded(!included); }}
          title={included ? 'Included — click to exclude' : 'Excluded — click to include this header'}
        >
          {included
            ? <SquareCheck className="w-4 h-4" />
            : <Square      className="w-4 h-4" />}
        </button>
        {included && status === 'confirmed' && <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />}
        {included && status === 'rejected'  && <XCircle      className="w-3.5 h-3.5 text-red-500 shrink-0" />}
        {included && status === 'pending'   && <Circle       className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
        <span
          className={`text-xs font-semibold truncate flex-1 ${included ? 'text-foreground' : 'text-muted-foreground italic'}`}
          title={mapping.excelHeader}
        >
          {mapping.excelHeader || <i className="text-muted-foreground">(empty header)</i>}
        </span>
        {included && override !== undefined && <Pencil className="w-3 h-3 text-amber-500 shrink-0" />}
        {included && (
          <button
            type="button"
            className={`shrink-0 p-0.5 rounded transition-colors ${
              isRowKey
                ? 'text-amber-500 bg-amber-500/15'
                : 'text-muted-foreground/50 hover:text-amber-500 hover:bg-amber-500/10'
            }`}
            onClick={e => { e.stopPropagation(); onSetRowKey(); }}
            title={isRowKey
              ? 'This column identifies which Excel row to write to. Click to unset.'
              : 'Use this column\u2019s extracted value to find the matching Excel row.'}
          >
            <Key className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Remaining rows are hidden when the header is excluded — nothing to configure. */}
      {!included ? null : <>

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
      </>}
    </li>
  );
}
