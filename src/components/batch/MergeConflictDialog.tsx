import { useMemo, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { FIELD_LABELS } from '@/types/utilscraper';
import { partitionConflict, type RecordConflict, type FieldMap, type Side } from '@/lib/batch-merge';

export type { RecordConflict, FieldMap } from '@/lib/batch-merge';

const label = (f: string) => FIELD_LABELS[f] ?? f;

/** Resolve a concurrent edit to the same batch record. */
interface Props {
  conflict: RecordConflict;
  onCancel: () => void;
  onResolve: (merged: FieldMap) => void;
}

export default function MergeConflictDialog({ conflict, onCancel, onResolve }: Props) {
  const { auto, clashes } = useMemo(() => partitionConflict(conflict), [conflict]);

  // Default every genuine clash to the server's value: preferring what is
  // already saved is the choice that cannot lose someone else's work by
  // accident. The user can flip any of them.
  const [choice, setChoice] = useState<Record<string, Side>>(
    () => Object.fromEntries(clashes.map(c => [c.field, 'theirs' as Side])),
  );

  const merged = (): FieldMap => {
    const out: FieldMap = { ...conflict.theirs };
    for (const a of auto) {
      if (a.value) out[a.field] = a.value; else delete out[a.field];
    }
    for (const c of clashes) {
      const v = choice[c.field] === 'mine' ? c.mine : c.theirs;
      if (v) out[c.field] = v; else delete out[c.field];
    }
    return out;
  };

  const setAll = (side: Side) =>
    setChoice(Object.fromEntries(clashes.map(c => [c.field, side])));

  return (
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-3xl max-h-[88vh] flex flex-col">

        <div className="flex items-start justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex gap-3">
            <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
            <div>
              <h2 className="text-sm font-bold text-foreground">Someone else edited this record</h2>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {conflict.filename.replace(/\.(pdf|docx?)$/i, '')} · page {conflict.page}
                {conflict.theirsBy && <> · last saved by <span className="font-medium">{conflict.theirsBy}</span></>}
                {conflict.theirsAt && <> at {new Date(conflict.theirsAt).toLocaleString()}</>}
              </p>
            </div>
          </div>
          <button onClick={onCancel} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
          {clashes.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Your changes don’t overlap theirs — everything merges cleanly. Review and save.
            </p>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-foreground">
                  {clashes.length} field{clashes.length !== 1 ? 's' : ''} changed by both of you — pick one
                </p>
                <div className="flex gap-1.5">
                  <button onClick={() => setAll('mine')}
                          className="px-2 py-1 rounded border border-border text-[10px] hover:bg-muted">
                    Use all mine
                  </button>
                  <button onClick={() => setAll('theirs')}
                          className="px-2 py-1 rounded border border-border text-[10px] hover:bg-muted">
                    Use all theirs
                  </button>
                </div>
              </div>

              {clashes.map(c => (
                <div key={c.field} className="border border-border rounded-lg overflow-hidden">
                  <div className="px-3 py-1.5 bg-muted text-[11px] font-semibold">{label(c.field)}</div>
                  <div className="grid grid-cols-2 divide-x divide-border">
                    {(['mine', 'theirs'] as Side[]).map(side => {
                      const value = side === 'mine' ? c.mine : c.theirs;
                      const active = choice[c.field] === side;
                      return (
                        <button
                          key={side}
                          onClick={() => setChoice(p => ({ ...p, [c.field]: side }))}
                          className={`text-left px-3 py-2 transition-colors ${
                            active ? 'bg-primary/10 ring-1 ring-inset ring-primary/40' : 'hover:bg-muted/50'
                          }`}
                        >
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
                            {side === 'mine' ? 'Yours' : 'On the server'}
                          </div>
                          <div className="text-xs font-medium break-words">
                            {value || <span className="text-muted-foreground/50 italic">empty</span>}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {auto.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-foreground mb-1.5">
                Merged automatically ({auto.length})
              </p>
              <div className="border border-border rounded-lg divide-y divide-border">
                {auto.map(a => (
                  <div key={a.field} className="flex items-center gap-3 px-3 py-1.5 text-[11px]">
                    <span className="text-muted-foreground min-w-[130px]">{label(a.field)}</span>
                    <span className="font-medium break-words flex-1">
                      {a.value || <span className="text-muted-foreground/50 italic">empty</span>}
                    </span>
                    <span className="text-[10px] text-muted-foreground shrink-0">
                      {a.from === 'mine' ? 'your change' : 'their change'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-between shrink-0">
          <p className="text-[10px] text-muted-foreground">
            Saving writes the merged result as version {conflict.serverVersion + 1}.
          </p>
          <div className="flex gap-2">
            <button onClick={onCancel}
                    className="px-4 py-1.5 text-sm rounded-md text-muted-foreground hover:text-foreground hover:bg-muted">
              Discard my changes
            </button>
            <button onClick={() => onResolve(merged())}
                    className="px-4 py-1.5 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90">
              Save merged
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
