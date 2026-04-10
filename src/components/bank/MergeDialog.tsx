import { useState } from 'react';
import { X, Merge, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { MergeGroup, MergeChoice } from '@/lib/bank-excel-export';

interface Props {
  groups: MergeGroup[];
  onConfirm: (choices: MergeChoice[]) => void;
  onCancel: () => void;
}

interface GroupState {
  enabled: boolean;
  canonical: string;  // which value to keep
}

export default function MergeDialog({ groups, onConfirm, onCancel }: Props) {
  const [state, setState] = useState<GroupState[]>(() =>
    // Start with all groups disabled — user picks which to merge
    groups.map(g => ({ enabled: false, canonical: g.values[0] })),
  );

  const handleConfirm = () => {
    const choices: MergeChoice[] = [];
    for (let i = 0; i < groups.length; i++) {
      if (state[i].enabled) {
        choices.push({
          field: groups[i].field,
          values: groups[i].values,
          canonical: state[i].canonical,
        });
      }
    }
    onConfirm(choices);
  };

  const enabledCount = state.filter(s => s.enabled).length;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2.5">
            <Merge className="w-4 h-4 text-primary" />
            <div>
              <h2 className="text-sm font-bold text-foreground">Merge Similar Items?</h2>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {groups.length} similarity group{groups.length !== 1 ? 's' : ''} found · Pick which to merge
              </p>
            </div>
          </div>
          <button
            onClick={onCancel}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-all duration-200"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Groups list */}
        <div className="flex-1 overflow-auto custom-scrollbar px-5 py-4 space-y-4">
          {groups.map((g, gi) => {
            const s = state[gi];
            return (
              <div
                key={gi}
                className={`rounded-lg border p-3 transition-all duration-200 ${
                  s.enabled
                    ? 'border-primary/50 bg-primary/5'
                    : 'border-border bg-muted/20'
                }`}
              >
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    onChange={e => {
                      const next = [...state];
                      next[gi] = { ...next[gi], enabled: e.target.checked };
                      setState(next);
                    }}
                    className="mt-0.5 w-4 h-4 accent-primary cursor-pointer shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs font-semibold text-foreground uppercase tracking-wide">
                        {g.fieldLabel}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {g.values.length} similar values
                      </span>
                    </div>

                    {/* Canonical value selector */}
                    {s.enabled && (
                      <p className="text-[11px] text-muted-foreground mb-1.5">
                        Keep this value:
                      </p>
                    )}
                    <div className="space-y-1">
                      {g.values.map((val, vi) => (
                        <label
                          key={vi}
                          className={`flex items-center gap-2 rounded px-2 py-1.5 text-xs transition-all duration-200 ${
                            s.enabled
                              ? s.canonical === val
                                ? 'bg-primary/15 text-primary cursor-pointer'
                                : 'text-muted-foreground hover:bg-muted cursor-pointer line-through'
                              : 'text-muted-foreground/70'
                          }`}
                        >
                          {s.enabled && (
                            <input
                              type="radio"
                              checked={s.canonical === val}
                              onChange={() => {
                                const next = [...state];
                                next[gi] = { ...next[gi], canonical: val };
                                setState(next);
                              }}
                              className="w-3 h-3 accent-primary cursor-pointer shrink-0"
                            />
                          )}
                          <span className="font-mono truncate">{val}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </label>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-border shrink-0">
          <p className="text-[11px] text-muted-foreground">
            {enabledCount > 0
              ? `${enabledCount} group${enabledCount !== 1 ? 's' : ''} will be merged`
              : 'No merges selected — download as-is'}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs bg-primary hover:bg-primary/90 text-primary-foreground font-semibold"
              onClick={handleConfirm}
            >
              <Download className="w-3.5 h-3.5 mr-1" />
              Download
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
