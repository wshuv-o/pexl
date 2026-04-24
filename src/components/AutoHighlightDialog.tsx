import { useCallback, useMemo, useState } from 'react';
import { Check, X, Plus, Loader2, ArrowRight, ArrowDown, Search } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import type { DocumentType, Highlight } from '@/types/utilscraper';
import { getFieldLabelsForType } from '@/types/utilscraper';
import { queriesFor } from '@/lib/field-label-synonyms';
import { searchBackend, type SearchMode } from '@/lib/api';

interface Candidate {
  id: string;
  fieldKey: string;
  fieldLabel: string;
  page: number;
  labelText: string;            // the matched label text on the page
  labelBbox: Rect;              // normalized 0-1
  rightBbox: Rect;              // normalized 0-1 — "value to the right of label"
  belowBbox: Rect;              // normalized 0-1 — "value below label"
  pick: null | 'right' | 'below';
}
type Rect = { x: number; y: number; width: number; height: number };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  docType: DocumentType;
  existingCustomFields: string[];
  onApply: (highlights: Record<number, Highlight[]>, runExtract: boolean) => void;
}

export default function AutoHighlightDialog({
  open, onOpenChange, sessionId, docType, existingCustomFields, onApply,
}: Props) {
  const baseFields = useMemo(
    () => getFieldLabelsForType(docType).filter(f => f.value !== 'custom'),
    [docType],
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [customInput, setCustomInput] = useState('');
  const [customFields, setCustomFields] = useState<string[]>([]);
  const [step, setStep] = useState<'pick' | 'searching' | 'review'>('pick');
  const [candidates, setCandidates] = useState<Candidate[]>([]);

  const reset = () => {
    setSelected(new Set());
    setCustomInput('');
    setCustomFields([]);
    setStep('pick');
    setCandidates([]);
  };

  const toggle = (key: string) =>
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const selectAll = () => {
    const all = new Set<string>();
    baseFields.forEach(f => all.add(f.value));
    existingCustomFields.forEach(f => all.add(f));
    customFields.forEach(f => all.add(f));
    setSelected(all);
  };

  const clearAll = () => setSelected(new Set());

  const addCustom = () => {
    const name = customInput.trim();
    if (!name) return;
    if (customFields.includes(name) || existingCustomFields.includes(name)) {
      setSelected(prev => new Set(prev).add(name));
      setCustomInput('');
      return;
    }
    setCustomFields(prev => [...prev, name]);
    setSelected(prev => new Set(prev).add(name));
    setCustomInput('');
  };

  const runSearch = useCallback(async () => {
    if (selected.size === 0) {
      toast('Select at least one field', { icon: 'ℹ️' });
      return;
    }
    setStep('searching');

    const allLabels = [
      ...baseFields.map(f => ({ key: f.value, label: f.label })),
      ...existingCustomFields.map(f => ({ key: f, label: f })),
      ...customFields.map(f => ({ key: f, label: f })),
    ];

    const fieldQueries = allLabels
      .filter(l => selected.has(l.key))
      .map(l => ({ key: l.key, label: l.label, queries: queriesFor(l.key) }));

    const modes: SearchMode[] = ['exact', 'partial', 'fuzzy'];
    const results: Candidate[] = [];
    const seen = new Set<string>();   // dedupe by fieldKey+page+roundedBbox

    await Promise.all(fieldQueries.map(async ({ key, label, queries }) => {
      // Cascade through modes until we get hits for this field.
      for (const mode of modes) {
        const hits: Candidate[] = [];
        for (const q of queries) {
          const r = await searchBackend(sessionId, q, mode, { limit: 20 });
          if (!r || r.count === 0) continue;
          for (const m of r.results) {
            const ps = r.page_sizes[String(m.page)];
            if (!ps) continue;
            for (const box of m.boxes) {
              const [x1, y1, x2, y2] = box;
              const labelBbox: Rect = {
                x: x1 / ps.width,
                y: y1 / ps.height,
                width:  (x2 - x1) / ps.width,
                height: (y2 - y1) / ps.height,
              };
              const rightBbox  = offsetRight(labelBbox);
              const belowBbox  = offsetBelow(labelBbox);
              const dedupeKey =
                `${key}|${m.page}|${labelBbox.x.toFixed(3)}|${labelBbox.y.toFixed(3)}`;
              if (seen.has(dedupeKey)) continue;
              seen.add(dedupeKey);
              hits.push({
                id: `${key}-${m.page}-${labelBbox.x.toFixed(3)}-${labelBbox.y.toFixed(3)}`,
                fieldKey:   key,
                fieldLabel: label,
                page:       m.page,
                labelText:  m.text,
                labelBbox, rightBbox, belowBbox,
                pick: null,
              });
            }
          }
        }
        if (hits.length > 0) {
          results.push(...hits);
          return;  // don't cascade further modes for this field
        }
      }
    }));

    results.sort((a, b) => {
      if (a.fieldKey !== b.fieldKey) return a.fieldKey.localeCompare(b.fieldKey);
      return a.page - b.page;
    });

    setCandidates(results);
    setStep('review');
    if (results.length === 0) {
      toast('No matches found for the selected fields', { icon: 'ℹ️' });
    }
  }, [selected, baseFields, existingCustomFields, customFields, sessionId]);

  const setPick = (id: string, side: 'right' | 'below') =>
    setCandidates(prev => prev.map(c =>
      c.id === id ? { ...c, pick: c.pick === side ? null : side } : c,
    ));

  const apply = () => {
    const chosen = candidates.filter(c => c.pick !== null);
    if (chosen.length === 0) {
      toast('Tick at least one match to apply', { icon: 'ℹ️' });
      return;
    }
    const byPage: Record<number, Highlight[]> = {};
    for (const c of chosen) {
      const bbox = c.pick === 'right' ? c.rightBbox : c.belowBbox;
      const hl: Highlight = {
        id: `auto-${Date.now()}-${c.id}-${Math.random().toString(36).slice(2, 5)}`,
        page:  c.page,
        field: c.fieldKey,
        x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height,
        isAutoExtracted: true,
      };
      if (!byPage[c.page]) byPage[c.page] = [];
      byPage[c.page].push(hl);
    }
    onApply(byPage, true);
    reset();
    onOpenChange(false);
    toast.success(`Added ${chosen.length} highlight${chosen.length !== 1 ? 's' : ''}. Extracting…`);
  };

  const chosenCount = candidates.filter(c => c.pick !== null).length;
  const totalCount  = candidates.length;

  // Group candidates by field for display
  const grouped = useMemo(() => {
    const map = new Map<string, Candidate[]>();
    for (const c of candidates) {
      if (!map.has(c.fieldKey)) map.set(c.fieldKey, []);
      map.get(c.fieldKey)!.push(c);
    }
    return map;
  }, [candidates]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-w-3xl w-[min(90vw,48rem)] max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Auto-highlight fields</DialogTitle>
          <DialogDescription>
            {step === 'pick'      && 'Pick the fields to find. Add custom fields if needed.'}
            {step === 'searching' && 'Searching the PDF for label text…'}
            {step === 'review'    && `${totalCount} match${totalCount !== 1 ? 'es' : ''} found — tick the correct side (right of label or below it).`}
          </DialogDescription>
        </DialogHeader>

        {/* ── Step 1: Pick fields ───────────────────────────────── */}
        {step === 'pick' && (
          <div className="flex-1 overflow-y-auto -mx-6 px-6 space-y-4 min-h-0">
            <div className="flex items-center gap-2 text-xs">
              <button
                onClick={selectAll}
                className="px-2 py-1 rounded-md bg-muted hover:bg-muted/80 transition-colors"
              >Select all</button>
              <button
                onClick={clearAll}
                className="px-2 py-1 rounded-md bg-muted hover:bg-muted/80 transition-colors"
              >Clear</button>
              <span className="text-muted-foreground ml-auto">
                {selected.size} selected
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {baseFields.map(f => (
                <FieldPill
                  key={f.value}
                  label={f.label}
                  color={f.color}
                  checked={selected.has(f.value)}
                  onToggle={() => toggle(f.value)}
                />
              ))}
              {existingCustomFields.map(f => (
                <FieldPill
                  key={`ex-${f}`}
                  label={f}
                  color="#64748b"
                  checked={selected.has(f)}
                  onToggle={() => toggle(f)}
                />
              ))}
              {customFields.map(f => (
                <FieldPill
                  key={`new-${f}`}
                  label={f}
                  color="#64748b"
                  checked={selected.has(f)}
                  onToggle={() => toggle(f)}
                />
              ))}
            </div>

            <div className="flex items-center gap-2 pt-2 border-t">
              <input
                type="text"
                value={customInput}
                onChange={e => setCustomInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }}
                placeholder="Add custom field name…"
                className="flex-1 px-3 py-1.5 rounded-md bg-muted border border-border text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <button
                onClick={addCustom}
                disabled={!customInput.trim()}
                className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                <Plus className="w-3.5 h-3.5" /> Add
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2: Searching ─────────────────────────────────── */}
        {step === 'searching' && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 py-8">
            <Loader2 className="w-8 h-8 text-primary animate-spin" />
            <p className="text-sm text-muted-foreground">Searching {selected.size} field{selected.size !== 1 ? 's' : ''}…</p>
          </div>
        )}

        {/* ── Step 3: Review ─────────────────────────────────────── */}
        {step === 'review' && (
          <div className="flex-1 overflow-y-auto -mx-6 px-6 min-h-0">
            {candidates.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No label text matched. Try adding more specific custom fields, or draw boxes manually.
              </div>
            ) : (
              <div className="space-y-4">
                {Array.from(grouped.entries()).map(([fieldKey, list]) => (
                  <div key={fieldKey}>
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                      {list[0].fieldLabel} <span className="text-muted-foreground/60 font-normal">({list.length})</span>
                    </div>
                    <div className="space-y-1.5">
                      {list.map(c => (
                        <CandidateRow
                          key={c.id}
                          candidate={c}
                          onPick={side => setPick(c.id, side)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="flex items-center gap-2 pt-2 border-t">
          {step === 'pick' && (
            <>
              <button
                onClick={() => onOpenChange(false)}
                className="px-3 py-1.5 rounded-md text-xs text-muted-foreground hover:bg-muted transition-colors"
              >Cancel</button>
              <button
                onClick={runSearch}
                disabled={selected.size === 0}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-primary text-primary-foreground text-xs hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                <Search className="w-3.5 h-3.5" /> Search
              </button>
            </>
          )}
          {step === 'review' && (
            <>
              <button
                onClick={() => setStep('pick')}
                className="px-3 py-1.5 rounded-md text-xs text-muted-foreground hover:bg-muted transition-colors"
              >Back</button>
              <span className="text-xs text-muted-foreground mr-auto">
                {chosenCount}/{totalCount} ticked
              </span>
              <button
                onClick={apply}
                disabled={chosenCount === 0}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-primary text-primary-foreground text-xs hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                Apply & Extract
              </button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── sub-components ─────────────────────────────────────────────────

function FieldPill({
  label, color, checked, onToggle,
}: { label: string; color: string; checked: boolean; onToggle: () => void }) {
  return (
    <label
      className={`flex items-center gap-2 px-2 py-1.5 rounded-md border cursor-pointer text-xs transition-colors
        ${checked
          ? 'bg-primary/10 border-primary/30 text-foreground'
          : 'bg-muted/40 border-border text-muted-foreground hover:bg-muted'}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="sr-only"
      />
      <span
        className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
          checked ? 'bg-primary border-primary' : 'border-border'
        }`}
      >
        {checked && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
      </span>
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
      <span className="truncate">{label}</span>
    </label>
  );
}

function CandidateRow({
  candidate, onPick,
}: { candidate: Candidate; onPick: (side: 'right' | 'below') => void }) {
  return (
    <div className="flex items-center gap-2 px-2.5 py-2 rounded-md bg-muted/30 border border-border">
      <div className="flex-1 min-w-0">
        <div className="text-xs text-muted-foreground">Page {candidate.page}</div>
        <div className="text-sm truncate" title={candidate.labelText}>
          “{candidate.labelText}”
        </div>
      </div>
      <SideButton
        icon={<ArrowRight className="w-3.5 h-3.5" />}
        label="Right"
        active={candidate.pick === 'right'}
        onClick={() => onPick('right')}
      />
      <SideButton
        icon={<ArrowDown className="w-3.5 h-3.5" />}
        label="Below"
        active={candidate.pick === 'below'}
        onClick={() => onPick('below')}
      />
      {candidate.pick !== null && (
        <span className="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-500 flex items-center justify-center shrink-0">
          <Check className="w-3.5 h-3.5" />
        </span>
      )}
      {candidate.pick === null && (
        <span className="w-6 h-6 rounded-full bg-muted text-muted-foreground flex items-center justify-center shrink-0">
          <X className="w-3.5 h-3.5" />
        </span>
      )}
    </div>
  );
}

function SideButton({
  icon, label, active, onClick,
}: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors shrink-0 border
        ${active
          ? 'bg-primary text-primary-foreground border-primary'
          : 'bg-background border-border text-muted-foreground hover:text-foreground hover:border-primary/50'}`}
    >
      {icon}<span>{label}</span>
    </button>
  );
}

// ── geometry helpers ───────────────────────────────────────────────

function offsetRight(label: Rect): Rect {
  const w = clamp(Math.max(0.18, label.width * 2.5), 0.05, 0.5);
  const x = Math.min(label.x + label.width, 0.98);
  return {
    x,
    y: label.y,
    width:  Math.min(w, 0.99 - x),
    height: label.height,
  };
}

function offsetBelow(label: Rect): Rect {
  const h = Math.max(0.015, label.height * 1.3);
  const y = Math.min(label.y + label.height, 0.98);
  return {
    x: label.x,
    y,
    width:  Math.max(label.width, 0.15),
    height: Math.min(h, 0.99 - y),
  };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
