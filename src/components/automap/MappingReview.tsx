import { CheckCircle2, Circle, XCircle, Pencil, ArrowRight, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import type { HeaderMatch, MatchBox } from '@/lib/automap/auto-match';
import { ALL_FIELDS, type HeaderToField } from '@/lib/automap/header-mapping';
import type { FieldLabel } from '@/types/utilscraper';

export type MappingStatus = 'pending' | 'confirmed' | 'rejected';

export interface MappingState {
  mapping: HeaderToField;          // Excel header → canonical field
  match: HeaderMatch;              // PDF candidates for the mapped field
  status: MappingStatus;
  override?: string;               // user-typed value
  chosenBox?: MatchBox | null;     // user picked alternative PDF box
}

interface Props {
  mappings: MappingState[];
  activeHeader: string | null;
  onSelect:      (excelHeader: string) => void;
  onFieldRemap:  (excelHeader: string, fieldKey: FieldLabel | null, fieldLabel: string | null) => void;
}

export default function MappingReview({ mappings, activeHeader, onSelect, onFieldRemap }: Props) {
  const confirmedCount = mappings.filter(m => m.status === 'confirmed').length;
  const rejectedCount  = mappings.filter(m => m.status === 'rejected').length;
  const pendingCount   = mappings.length - confirmedCount - rejectedCount;
  const mappedCount    = mappings.filter(m => m.mapping.fieldKey).length;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-sm font-bold text-foreground">Header mapping</h2>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          {mappedCount}/{mappings.length} headers linked to fields
        </p>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          {confirmedCount} confirmed · {pendingCount} pending · {rejectedCount} rejected
        </p>
      </div>
      <ul className="flex-1 overflow-auto custom-scrollbar">
        {mappings.map(m => (
          <MappingRow
            key={m.mapping.excelHeader}
            state={m}
            isActive={m.mapping.excelHeader === activeHeader}
            onSelect={() => onSelect(m.mapping.excelHeader)}
            onFieldRemap={(fk, fl) => onFieldRemap(m.mapping.excelHeader, fk, fl)}
          />
        ))}
      </ul>
    </div>
  );
}

interface RowProps {
  state: MappingState;
  isActive: boolean;
  onSelect: () => void;
  onFieldRemap: (fieldKey: FieldLabel | null, fieldLabel: string | null) => void;
}

function MappingRow({ state, isActive, onSelect, onFieldRemap }: RowProps) {
  const [open, setOpen] = useState(false);
  const { mapping, status, match, override, chosenBox } = state;
  const box = chosenBox ?? match.box;
  const displayValue = override ?? box?.value ?? '';

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

      {/* Row 2: canonical field pill  →  value */}
      <div className="flex items-center gap-1.5 mt-1 ml-5 text-[11px]">
        <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
        <button
          type="button"
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium
            ${mapping.fieldLabel
              ? 'bg-primary/10 border-primary/30 text-primary'
              : 'bg-muted border-border text-muted-foreground'}`}
          onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
          title={mapping.fieldKey || 'no field mapped — click to pick'}
        >
          {mapping.fieldLabel || 'Unmapped'}
          <ChevronDown className="w-3 h-3" />
        </button>
        <span className={`ml-1 truncate flex-1 ${box ? 'text-foreground/80' : 'text-muted-foreground italic'}`}>
          {displayValue || '—'}
        </span>
        {box && !override && (
          <span className="text-[10px] text-muted-foreground shrink-0">p{box.page}</span>
        )}
      </div>

      {open && (
        <div
          className="mt-1 ml-5 bg-card border border-border rounded shadow-sm py-1 max-h-60 overflow-y-auto"
          onClick={e => e.stopPropagation()}
        >
          <div className="px-2 py-1 text-[10px] uppercase text-muted-foreground">Canonical field</div>
          <button
            className={`w-full text-left px-2 py-1 text-[11px] hover:bg-muted ${mapping.fieldKey === null ? 'bg-muted font-semibold' : ''}`}
            onClick={() => { onFieldRemap(null, null); setOpen(false); }}
          >
            <span className="italic text-muted-foreground">Unmapped</span>
          </button>
          {ALL_FIELDS.map(opt => (
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
    </li>
  );
}
