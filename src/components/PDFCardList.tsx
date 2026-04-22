import { FileText, ChevronRight, Loader2, Check } from 'lucide-react';
import type { PDFSession } from '@/types/utilscraper';
import { DOCUMENT_TYPES } from '@/types/utilscraper';

interface PDFCardListProps {
  sessions: PDFSession[];
  expandedId: string | null;
  onToggle: (id: string) => void;
  onStartPageChange: (sessionId: string, startPage: number) => void;
}

function StatusBadge({ session }: { session: PDFSession }) {
  const ocrCount = Array.isArray(session.pages) ? session.pages.filter(p => p.is_ocr).length : 0;

  switch (session.status) {
    case 'uploading':
      return <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Loader2 className="w-3 h-3 animate-spin" />Uploading...</span>;
    case 'processing':
      return <span className="flex items-center gap-1 text-[11px] text-blue-500"><Loader2 className="w-3 h-3 animate-spin" />Analysing...</span>;
    case 'ready':
      return (
        <span className="flex items-center gap-1.5 flex-wrap">
          {ocrCount > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">{ocrCount} OCR</span>}
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary font-medium">Ready</span>
        </span>
      );
    case 'extracted':
      return <span className="flex items-center gap-1 text-[11px] text-primary font-medium"><Check className="w-3 h-3" />Extracted</span>;
    default:
      return null;
  }
}

export default function PDFCardList({ sessions, expandedId, onToggle, onStartPageChange }: PDFCardListProps) {
  if (!sessions.length) return null;

  return (
    <div className="space-y-1.5">
      {sessions.map((s, idx) => {
        const expanded  = expandedId === s.id;
        const isLoading = s.status === 'uploading' || s.status === 'processing';

        return (
          <div key={s.id} className="space-y-0">
            <div
              role="button"
              tabIndex={isLoading ? -1 : 0}
              aria-expanded={expanded}
              aria-disabled={isLoading}
              className={[
                'w-full text-left rounded-lg px-3 py-2.5 flex items-center gap-2.5 transition-all duration-200',
                isLoading  ? 'opacity-60 cursor-not-allowed bg-muted/50' :
                expanded   ? 'bg-primary/10 border border-primary/20 cursor-pointer' :
                             'bg-muted/50 border border-transparent hover:border-border hover:bg-card cursor-pointer',
                expanded ? 'rounded-b-none' : '',
              ].join(' ')}
              onClick={() => !isLoading && onToggle(s.id)}
              onKeyDown={e => { if (!isLoading && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onToggle(s.id); } }}
            >
              <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${expanded ? 'bg-primary/15' : 'bg-muted'}`}>
                <FileText className={`w-3.5 h-3.5 ${expanded ? 'text-primary' : 'text-muted-foreground'}`} />
              </div>

              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold truncate text-foreground">
                  <span className="text-muted-foreground font-normal mr-1">{idx + 1}.</span>
                  {s.filename}
                </p>
                <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
                  {(() => {
                    const dt = DOCUMENT_TYPES.find(d => d.value === s.docType);
                    return dt ? (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                        style={{ color: dt.color, backgroundColor: `${dt.color}18` }}
                      >
                        {dt.label}
                      </span>
                    ) : null;
                  })()}
                  <StatusBadge session={s} />
                </div>
              </div>

              {s.total_pages > 0 && (
                <span className="text-[10px] text-muted-foreground shrink-0">{s.total_pages}p</span>
              )}
              <ChevronRight className={`w-3.5 h-3.5 text-muted-foreground shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
            </div>

            {/* Start page setting — visible when card is expanded */}
            {expanded && !isLoading && s.total_pages > 1 && (
              <div
                className="bg-primary/5 border border-primary/20 border-t-0 rounded-b-lg px-3 py-1.5 flex items-center gap-2"
                onClick={e => e.stopPropagation()}
              >
                <span className="text-[10px] text-muted-foreground whitespace-nowrap">Start page</span>
                <input
                  type="number"
                  min={1}
                  max={s.total_pages}
                  value={s.startPage}
                  onChange={e => {
                    const n = parseInt(e.target.value);
                    if (!isNaN(n) && n >= 1 && n <= s.total_pages) {
                      onStartPageChange(s.id, n);
                    }
                  }}
                  className="w-12 h-5 text-center text-[11px] bg-background rounded border border-border
                             text-foreground outline-none focus:ring-1 focus:ring-primary"
                />
                {s.startPage > 1 && (
                  <span className="text-[10px] text-primary font-medium">
                    skipping {s.startPage - 1} cover pg{s.startPage > 2 ? 's' : ''}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}