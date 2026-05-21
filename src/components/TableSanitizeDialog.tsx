import { useState, useMemo } from 'react';
import { X, Wand2, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';

// ── Levenshtein distance (two-row DP, O(n) space) ───────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  const curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev = curr.slice();
  }
  return prev[n];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isSkippable(s: string): boolean {
  if (!s || s.length < 4) return true;
  // Pure numeric / currency / date tokens — don't spell-check these
  if (/^[\d,.\-\s/$%()]+$/.test(s)) return true;
  if (/^\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?$/.test(s)) return true;
  return false;
}

function editThreshold(len: number): number {
  if (len <= 6) return 1;
  if (len <= 12) return 2;
  return Math.min(3, Math.floor(len * 0.15));
}

// ── Group computation ─────────────────────────────────────────────────────────

interface SanitizeGroup {
  values: string[];  // sorted most-frequent first
}

function computeGroups(rows: string[][]): SanitizeGroup[] {
  // 1. Frequency count of all non-skippable text values
  const freq = new Map<string, number>();
  for (const row of rows) {
    for (const cell of row) {
      const val = (cell ?? '').trim();
      if (!isSkippable(val)) freq.set(val, (freq.get(val) ?? 0) + 1);
    }
  }

  const values = [...freq.keys()];
  const normed = values.map(normalise);
  const grouped = new Set<string>();
  const groups: SanitizeGroup[] = [];

  // 2. Greedy grouping: for each ungrouped value, collect similar values
  for (let i = 0; i < values.length; i++) {
    if (grouped.has(values[i])) continue;
    const na = normed[i];
    const thresh = editThreshold(na.length);
    const group: string[] = [values[i]];

    for (let j = i + 1; j < values.length; j++) {
      if (grouped.has(values[j])) continue;
      const nb = normed[j];
      // Quick length pre-filter
      if (Math.abs(na.length - nb.length) > thresh + 1) continue;
      if (levenshtein(na, nb) <= thresh) {
        group.push(values[j]);
      }
    }

    if (group.length >= 2) {
      group.forEach(v => grouped.add(v));
      // Most-frequent value first → becomes default canonical
      group.sort((a, b) => (freq.get(b) ?? 0) - (freq.get(a) ?? 0));
      groups.push({ values: group });
    }
  }

  return groups;
}

// ── Component ────────────────────────────────────────────────────────────────

interface GroupState {
  canonical: string;
  values: { value: string; selected: boolean }[];
}

interface Props {
  rows: string[][];
  onConfirm: (replacements: Record<string, string>) => void;
  onCancel: () => void;
}

export default function TableSanitizeDialog({ rows, onConfirm, onCancel }: Props) {
  const groups = useMemo(() => computeGroups(rows), [rows]);

  const [state, setState] = useState<GroupState[]>(() =>
    groups.map(g => ({
      canonical: g.values[0],
      values: g.values.map(v => ({ value: v, selected: true })),
    })),
  );

  const toggleValue = (gi: number, vi: number) => {
    const next = [...state];
    const gs = { ...next[gi], values: [...next[gi].values] };
    gs.values[vi] = { ...gs.values[vi], selected: !gs.values[vi].selected };
    if (!gs.values.find(v => v.value === gs.canonical && v.selected)) {
      const first = gs.values.find(v => v.selected);
      if (first) gs.canonical = first.value;
    }
    next[gi] = gs;
    setState(next);
  };

  const setCanonical = (gi: number, val: string) => {
    setState(prev => {
      const next = [...prev];
      next[gi] = { ...next[gi], canonical: val };
      return next;
    });
  };

  const selectAll = (gi: number) => setState(prev => {
    const next = [...prev];
    next[gi] = { ...next[gi], values: next[gi].values.map(v => ({ ...v, selected: true })) };
    return next;
  });

  const unselectAll = (gi: number) => setState(prev => {
    const next = [...prev];
    next[gi] = { ...next[gi], values: next[gi].values.map(v => ({ ...v, selected: false })) };
    return next;
  });

  const handleConfirm = () => {
    const replacements: Record<string, string> = {};
    for (let i = 0; i < groups.length; i++) {
      const gs = state[i];
      const selected = gs.values.filter(v => v.selected);
      if (selected.length < 2) continue;
      for (const { value } of selected) {
        if (value !== gs.canonical) replacements[value] = gs.canonical;
      }
    }
    onConfirm(replacements);
  };

  const totalReplacements = state.reduce((sum, gs) => {
    const sel = gs.values.filter(v => v.selected);
    return sum + (sel.length >= 2 ? sel.length - 1 : 0);
  }, 0);

  if (groups.length === 0) {
    return (
      <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
        <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-sm p-6 flex flex-col items-center gap-4">
          <Check className="w-8 h-8 text-green-500" />
          <p className="text-sm font-medium text-foreground">No similar values found</p>
          <p className="text-xs text-muted-foreground text-center">
            All text in this table appears unique — no merge candidates detected.
          </p>
          <Button size="sm" className="h-8 text-xs" onClick={onCancel}>Close</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2.5">
            <Wand2 className="w-4 h-4 text-primary" />
            <div>
              <h2 className="text-sm font-bold text-foreground">Sanitize Table</h2>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {groups.length} group{groups.length !== 1 ? 's' : ''} of similar values · pick a canonical form to merge into
              </p>
            </div>
          </div>
          <button
            onClick={onCancel}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Groups */}
        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
          {groups.map((g, gi) => {
            const gs = state[gi];
            const selectedCount = gs.values.filter(v => v.selected).length;
            const willMerge = selectedCount >= 2;

            return (
              <div
                key={gi}
                className={`rounded-lg border p-3 transition-all ${
                  willMerge ? 'border-primary/50 bg-primary/5' : 'border-border bg-muted/20'
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] text-muted-foreground">
                    {g.values.length} similar · {selectedCount} checked
                  </span>
                  <div className="flex items-center gap-1 ml-auto">
                    {willMerge && (
                      <span className="text-[10px] text-primary font-medium mr-1">
                        → {gs.canonical.length > 22 ? gs.canonical.slice(0, 22) + '…' : gs.canonical}
                      </span>
                    )}
                    <button
                      onClick={() => selectAll(gi)}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    >
                      Select All
                    </button>
                    <button
                      onClick={() => unselectAll(gi)}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    >
                      Unselect All
                    </button>
                  </div>
                </div>

                {willMerge && (
                  <p className="text-[10px] text-muted-foreground mb-1.5">
                    Checked values will be replaced by the radio-selected canonical:
                  </p>
                )}

                <div className="space-y-0.5">
                  {gs.values.map((vs, vi) => {
                    const isCanonical = gs.canonical === vs.value;
                    return (
                      <div
                        key={vi}
                        className={`flex items-center gap-2 rounded px-2 py-1.5 text-xs transition-all ${
                          vs.selected
                            ? isCanonical
                              ? 'bg-primary/15 text-primary'
                              : willMerge
                                ? 'text-muted-foreground line-through'
                                : 'text-foreground'
                            : 'text-muted-foreground/40'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={vs.selected}
                          onChange={() => toggleValue(gi, vi)}
                          className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                        />
                        {vs.selected && willMerge && (
                          <input
                            type="radio"
                            name={`sanitize-group-${gi}`}
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
            {totalReplacements > 0
              ? `${totalReplacements} value${totalReplacements !== 1 ? 's' : ''} will be replaced in the table`
              : 'No replacements selected'}
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
              <Check className="w-3.5 h-3.5 mr-1" />
              Apply
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
