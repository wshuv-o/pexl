import { useState } from 'react';
import { X, Merge, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { MergeGroup, MergeChoice } from '@/lib/bank-excel-export';

interface Props {
  groups: MergeGroup[];
  onConfirm: (choices: MergeChoice[]) => void;
  onCancel: () => void;
}

// Per-value state within a group
interface ValueState {
  value: string;
  selected: boolean;  // include in merge
}

interface GroupState {
  canonical: string;
  values: ValueState[];
}

export default function MergeDialog({ groups, onConfirm, onCancel }: Props) {
  const [state, setState] = useState<GroupState[]>(() =>
    groups.map(g => ({
      canonical: g.values[0],
      values: g.values.map(v => ({ value: v, selected: true })),
    })),
  );

  const handleConfirm = () => {
    const choices: MergeChoice[] = [];
    for (let i = 0; i < groups.length; i++) {
      const gs = state[i];
      const selected = gs.values.filter(v => v.selected).map(v => v.value);
      // Only merge if at least 2 values are selected
      if (selected.length >= 2) {
        choices.push({
          field: groups[i].field,
          values: selected,
          canonical: gs.canonical,
        });
      }
    }
    onConfirm(choices);
  };

  const toggleValue = (gi: number, vi: number) => {
    const next = [...state];
    const gs = { ...next[gi], values: [...next[gi].values] };
    gs.values[vi] = { ...gs.values[vi], selected: !gs.values[vi].selected };
    // If canonical was deselected, pick the first still-selected value
    if (!gs.values.find(v => v.value === gs.canonical && v.selected)) {
      const firstSelected = gs.values.find(v => v.selected);
      if (firstSelected) gs.canonical = firstSelected.value;
    }
    next[gi] = gs;
    setState(next);
  };

  const setCanonical = (gi: number, val: string) => {
    const next = [...state];
    next[gi] = { ...next[gi], canonical: val };
    setState(next);
  };

  const totalMergeCount = state.reduce((sum, gs) => {
    const sel = gs.values.filter(v => v.selected).length;
    return sum + (sel >= 2 ? sel : 0);
  }, 0);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2.5">
            <Merge className="w-4 h-4 text-primary" />
            <div>
              <h2 className="text-sm font-bold text-foreground">Merge Similar Items</h2>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {groups.length} group{groups.length !== 1 ? 's' : ''} found · Check values to merge, pick canonical
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

        {/* Groups */}
        <div className="flex-1 overflow-auto custom-scrollbar px-5 py-4 space-y-4">
          {groups.map((g, gi) => {
            const gs = state[gi];
            const selectedCount = gs.values.filter(v => v.selected).length;
            const willMerge = selectedCount >= 2;

            return (
              <div
                key={gi}
                className={`rounded-lg border p-3 transition-all duration-200 ${
                  willMerge ? 'border-primary/50 bg-primary/5' : 'border-border bg-muted/20'
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-semibold text-foreground uppercase tracking-wide">
                    {g.fieldLabel}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {g.values.length} similar · {selectedCount} checked
                  </span>
                  {willMerge && (
                    <span className="text-[10px] text-primary font-medium ml-auto">
                      will merge → {gs.canonical.length > 30 ? gs.canonical.slice(0, 30) + '…' : gs.canonical}
                    </span>
                  )}
                </div>

                {willMerge && (
                  <p className="text-[10px] text-muted-foreground mb-1.5">
                    Checked values merge into the one marked with the radio button:
                  </p>
                )}

                <div className="space-y-0.5">
                  {gs.values.map((vs, vi) => {
                    const isCanonical = gs.canonical === vs.value;
                    return (
                      <div
                        key={vi}
                        className={`flex items-center gap-2 rounded px-2 py-1.5 text-xs transition-all duration-200 ${
                          vs.selected
                            ? isCanonical
                              ? 'bg-primary/15 text-primary'
                              : willMerge
                                ? 'text-muted-foreground line-through'
                                : 'text-foreground'
                            : 'text-muted-foreground/40'
                        }`}
                      >
                        {/* Include/exclude checkbox */}
                        <input
                          type="checkbox"
                          checked={vs.selected}
                          onChange={() => toggleValue(gi, vi)}
                          className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                        />

                        {/* Canonical radio — only shown for selected values when merging */}
                        {vs.selected && willMerge && (
                          <input
                            type="radio"
                            name={`merge-group-${gi}`}
                            checked={isCanonical}
                            onChange={() => setCanonical(gi, vs.value)}
                            className="w-3 h-3 accent-primary cursor-pointer shrink-0"
                          />
                        )}

                        <span className="font-mono truncate">{vs.value}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-border shrink-0">
          <p className="text-[11px] text-muted-foreground">
            {totalMergeCount > 0
              ? `${totalMergeCount} values will be merged`
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
