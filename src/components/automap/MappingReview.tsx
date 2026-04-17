import { CheckCircle2, Circle, XCircle, Pencil, ChevronRight } from 'lucide-react';
import type { HeaderMatch, MatchBox } from '@/lib/automap/auto-match';

export type MappingStatus = 'pending' | 'confirmed' | 'rejected';

export interface MappingState {
  match: HeaderMatch;
  status: MappingStatus;
  override?: string;       // user-typed value (Edit)
  chosenBox?: MatchBox | null;  // user picked an alternative
}

interface Props {
  mappings: MappingState[];
  activeHeader: string | null;
  onSelect: (header: string) => void;
}

export default function MappingReview({ mappings, activeHeader, onSelect }: Props) {
  const confirmedCount = mappings.filter(m => m.status === 'confirmed').length;
  const rejectedCount  = mappings.filter(m => m.status === 'rejected').length;
  const pendingCount   = mappings.length - confirmedCount - rejectedCount;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-sm font-bold text-foreground">Header mapping</h2>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          {confirmedCount} confirmed · {pendingCount} pending · {rejectedCount} rejected
        </p>
      </div>
      <ul className="flex-1 overflow-auto custom-scrollbar">
        {mappings.map(m => {
          const isActive = m.match.header === activeHeader;
          const { status, match, override, chosenBox } = m;
          const box = chosenBox ?? match.box;
          const displayValue = override ?? box?.value ?? '—';
          return (
            <li
              key={match.header}
              className={`group/row px-4 py-2 border-b border-border/40 cursor-pointer transition-colors
                ${isActive ? 'bg-primary/10 border-l-[3px] border-l-primary'
                           : 'hover:bg-muted/50 border-l-[3px] border-l-transparent'}`}
              onClick={() => onSelect(match.header)}
            >
              <div className="flex items-center gap-2">
                {status === 'confirmed' && <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />}
                {status === 'rejected'  && <XCircle      className="w-3.5 h-3.5 text-red-500 shrink-0" />}
                {status === 'pending'   && <Circle       className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                <span className="text-xs font-semibold text-foreground truncate">{match.header}</span>
                {override !== undefined && <Pencil className="w-3 h-3 text-amber-500 shrink-0" />}
                <ChevronRight className="w-3 h-3 text-muted-foreground ml-auto opacity-0 group-hover/row:opacity-100" />
              </div>
              <div className="flex items-center gap-2 mt-1 ml-5">
                <span className={`text-[11px] truncate flex-1 ${box ? 'text-foreground/80' : 'text-muted-foreground italic'}`}>
                  {displayValue}
                </span>
                {box && !override && (
                  <span className="text-[10px] text-muted-foreground shrink-0">p{box.page}</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
