import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Plus, Search, GripHorizontal, X } from 'lucide-react';
import { toast } from 'sonner';
import type { DocumentType } from '@/types/utilscraper';
import { getFieldLabelsForType } from '@/types/utilscraper';
import { queriesFor } from '@/lib/field-label-synonyms';

export interface AutoHighlightField {
  key: string;
  label: string;
  queries: string[];
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  docType: DocumentType;
  existingCustomFields: string[];
  onStart: (fields: AutoHighlightField[]) => void;
}

const PANEL_WIDTH = 460;
const PANEL_INITIAL_RIGHT = 32;
const PANEL_INITIAL_TOP = 96;

export default function AutoHighlightDialog({
  open, onOpenChange, docType, existingCustomFields, onStart,
}: Props) {
  const baseFields = useMemo(
    () => getFieldLabelsForType(docType).filter(f => f.value !== 'custom'),
    [docType],
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [customInput, setCustomInput] = useState('');
  const [customFields, setCustomFields] = useState<string[]>([]);

  // ── Drag state ────────────────────────────────────────────────
  // Anchor the panel by its top-left corner. Initialized once on open
  // to a sensible position in the top-right of the viewport.
  const [pos, setPos] = useState<{ x: number; y: number }>({
    x: typeof window !== 'undefined' ? window.innerWidth - PANEL_WIDTH - PANEL_INITIAL_RIGHT : 600,
    y: PANEL_INITIAL_TOP,
  });
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  // Keep the panel inside the viewport when the window resizes.
  useEffect(() => {
    const onResize = () => {
      setPos(p => ({
        x: clamp(p.x, 0, window.innerWidth - 80),
        y: clamp(p.y, 0, window.innerHeight - 80),
      }));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onDragMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };

    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const nx = clamp(d.origX + (ev.clientX - d.startX), 0, window.innerWidth  - 80);
      const ny = clamp(d.origY + (ev.clientY - d.startY), 0, window.innerHeight - 80);
      setPos({ x: nx, y: ny });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
  };

  const reset = () => {
    setSelected(new Set());
    setCustomInput('');
    setCustomFields([]);
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
    if (!customFields.includes(name) && !existingCustomFields.includes(name)) {
      setCustomFields(prev => [...prev, name]);
    }
    setSelected(prev => new Set(prev).add(name));
    setCustomInput('');
  };

  const start = () => {
    if (selected.size === 0) {
      toast('Select at least one field', { icon: 'ℹ️' });
      return;
    }
    const allLabels = [
      ...baseFields.map(f => ({ key: f.value, label: f.label })),
      ...existingCustomFields.map(f => ({ key: f, label: f })),
      ...customFields.map(f => ({ key: f, label: f })),
    ];
    const fields: AutoHighlightField[] = allLabels
      .filter(l => selected.has(l.key))
      .map(l => ({ key: l.key, label: l.label, queries: queriesFor(l.key) }));
    onStart(fields);
    reset();
    onOpenChange(false);
  };

  const close = () => { reset(); onOpenChange(false); };

  if (!open) return null;

  return (
    <div
      className="fixed z-50 flex flex-col rounded-lg border border-border shadow-2xl
                 bg-background/85 backdrop-blur-md hover:bg-background/95 transition-colors
                 max-h-[80vh]"
      style={{
        left:  pos.x,
        top:   pos.y,
        width: PANEL_WIDTH,
      }}
    >
      {/* ── Drag handle / header ────────────────────────────────── */}
      <div
        onMouseDown={onDragMouseDown}
        className="flex items-center gap-2 px-4 py-2.5 border-b border-border/60 cursor-move select-none"
      >
        <GripHorizontal className="w-4 h-4 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold">Auto-highlight fields</div>
          <div className="text-[11px] text-muted-foreground truncate">
            Drag to move · Pick fields, then Start
          </div>
        </div>
        <button
          onClick={close}
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          title="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* ── Body (scrollable) ──────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
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

        <div className="grid grid-cols-2 gap-1.5">
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

        <div className="flex items-center gap-2 pt-2 border-t border-border/60">
          <input
            type="text"
            value={customInput}
            onChange={e => setCustomInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }}
            placeholder="Add custom field name…"
            className="flex-1 px-3 py-1.5 rounded-md bg-muted/70 border border-border text-sm focus:outline-none focus:ring-1 focus:ring-primary"
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

      {/* ── Footer ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-border/60">
        <button
          onClick={close}
          className="px-3 py-1.5 rounded-md text-xs text-muted-foreground hover:bg-muted transition-colors"
        >Cancel</button>
        <button
          onClick={start}
          disabled={selected.size === 0}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-primary text-primary-foreground text-xs hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          <Search className="w-3.5 h-3.5" /> Start
        </button>
      </div>
    </div>
  );
}

function FieldPill({
  label, color, checked, onToggle,
}: { label: string; color: string; checked: boolean; onToggle: () => void }) {
  return (
    <label
      className={`flex items-center gap-2 px-2 py-1.5 rounded-md border cursor-pointer text-xs transition-colors
        ${checked
          ? 'bg-primary/10 border-primary/30 text-foreground'
          : 'bg-muted/30 border-border text-muted-foreground hover:bg-muted/60'}`}
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

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
