import { useState, useRef, useEffect } from 'react';
import { X } from 'lucide-react';
import type { Highlight, ViewerTool } from '@/types/utilscraper';
import { getFieldConfig } from '@/types/utilscraper';

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const EDGE_CURSOR: Record<Edge, string> = {
  n:  'ns-resize', s:  'ns-resize',
  e:  'ew-resize', w:  'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  nw: 'nwse-resize', se: 'nwse-resize',
};

interface Props {
  highlights: Highlight[];
  drawing: { x: number; y: number; w: number; h: number } | null;
  selectionBox?: { x: number; y: number; w: number; h: number } | null;
  selectedIds?: Set<string>;
  onDelete: (id: string) => void;
  onReExtract: (id: string) => void;
  onMove?: (id: string, newX: number, newY: number) => void;
  // Fires on release after a Word/Paint-style edge/corner drag — caller
  // should update the highlight geometry and re-extract its value.
  onResize?: (id: string, bounds: { x: number; y: number; width: number; height: number }) => void;
  onSelectToggle?: (id: string, additive: boolean) => void;
  tool: ViewerTool;
}

const CONFIDENCE_PCT: Record<string, number> = {
  high:   95,
  medium: 65,
  low:    25,
};

export default function HighlightOverlay({
  highlights, drawing, selectionBox, selectedIds, onDelete, onMove, onResize, onSelectToggle, tool,
}: Props) {
  // Track which highlight is being dragged, plus preview position and pointer offset
  const [dragging, setDragging] = useState<{
    id: string;
    startX: number;   // highlight starting x (fraction)
    startY: number;   // highlight starting y (fraction)
    pointerX: number; // pointer start in px (client)
    pointerY: number; // pointer start in px (client)
    previewX: number; // live x during drag
    previewY: number; // live y during drag
  } | null>(null);

  const overlayRef = useRef<HTMLDivElement>(null);

  // ── Word-style resize state ───────────────────────────────────────────
  // Track which highlight's handle is being dragged + the live preview
  // bounds. Listeners bind ONCE per drag (null → non-null), read live
  // values through `resizeRef` so we don't re-bind on every mousemove.
  const [resize, setResize] = useState<{
    id: string;
    edge: Edge;
    startBox: { x: number; y: number; width: number; height: number };
    box:      { x: number; y: number; width: number; height: number };
  } | null>(null);
  const resizeRef = useRef(resize);
  useEffect(() => { resizeRef.current = resize; }, [resize]);

  const resizingId = resize?.id ?? null;

  useEffect(() => {
    if (!resizingId) return;

    const onMove = (e: MouseEvent) => {
      const curr = resizeRef.current;
      const overlay = overlayRef.current;
      if (!curr || !overlay) return;
      const rect = overlay.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width;
      const my = (e.clientY - rect.top)  / rect.height;
      setResize(prev => {
        if (!prev) return prev;
        const s = prev.startBox;
        let { x, y, width, height } = s;
        if (prev.edge.includes('w')) {
          const newX = Math.max(0, Math.min(mx, s.x + s.width - 0.002));
          width = s.x + s.width - newX;
          x = newX;
        }
        if (prev.edge.includes('e')) {
          width = Math.max(0.002, Math.min(1 - s.x, mx - s.x));
        }
        if (prev.edge.includes('n')) {
          const newY = Math.max(0, Math.min(my, s.y + s.height - 0.002));
          height = s.y + s.height - newY;
          y = newY;
        }
        if (prev.edge.includes('s')) {
          height = Math.max(0.002, Math.min(1 - s.y, my - s.y));
        }
        return { ...prev, box: { x, y, width, height } };
      });
    };

    const onUp = () => {
      const curr = resizeRef.current;
      setResize(null);
      if (!curr) return;
      const s = curr.startBox;
      const b = curr.box;
      const moved =
        Math.abs(s.x - b.x) > 0.001 ||
        Math.abs(s.y - b.y) > 0.001 ||
        Math.abs(s.width  - b.width)  > 0.001 ||
        Math.abs(s.height - b.height) > 0.001;
      if (moved && onResize) onResize(curr.id, b);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizingId, onResize]);

  const beginResize = (e: React.MouseEvent, h: Highlight, edge: Edge) => {
    e.preventDefault();
    e.stopPropagation();
    setResize({
      id: h.id,
      edge,
      startBox: { x: h.x, y: h.y, width: h.width, height: h.height },
      box:      { x: h.x, y: h.y, width: h.width, height: h.height },
    });
  };

  // Window-level listeners so dragging works even if cursor leaves the highlight
  useEffect(() => {
    if (!dragging) return;

    const onMouseMove = (e: MouseEvent) => {
      const overlay = overlayRef.current;
      if (!overlay) return;
      const rect = overlay.getBoundingClientRect();
      const dxPx = e.clientX - dragging.pointerX;
      const dyPx = e.clientY - dragging.pointerY;
      const dxFrac = dxPx / rect.width;
      const dyFrac = dyPx / rect.height;
      setDragging(d => d ? {
        ...d,
        previewX: Math.max(0, Math.min(1, d.startX + dxFrac)),
        previewY: Math.max(0, Math.min(1, d.startY + dyFrac)),
      } : null);
    };

    const onMouseUp = () => {
      setDragging(current => {
        if (current && onMove) {
          // Commit only if position actually changed
          if (current.previewX !== current.startX || current.previewY !== current.startY) {
            onMove(current.id, current.previewX, current.previewY);
          }
        }
        return null;
      });
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [dragging, onMove]);

  const handleBoxMouseDown = (e: React.MouseEvent, h: Highlight) => {
    if (tool !== 'cursor' || !onMove) return;
    // Don't start drag when clicking a button inside
    if ((e.target as HTMLElement).closest('button')) return;
    e.stopPropagation();
    e.preventDefault();

    // Handle selection: if not already selected, make this the only selection
    // (unless shift/ctrl held). If already selected, keep selection as-is so
    // the user can drag the group.
    if (onSelectToggle) {
      const alreadySelected = selectedIds?.has(h.id) ?? false;
      if (!alreadySelected) {
        onSelectToggle(h.id, e.shiftKey || e.ctrlKey || e.metaKey);
      } else if (e.shiftKey || e.ctrlKey || e.metaKey) {
        // Toggle off when modifier held on already-selected item
        onSelectToggle(h.id, true);
        return; // Don't start dragging
      }
    }

    setDragging({
      id: h.id,
      startX: h.x,
      startY: h.y,
      pointerX: e.clientX,
      pointerY: e.clientY,
      previewX: h.x,
      previewY: h.y,
    });
  };

  return (
    <div ref={overlayRef} className="absolute inset-0 pointer-events-none overflow-hidden">
      {highlights.filter(h => h.width > 0 && h.height > 0).map(h => {
        const cfg = getFieldConfig(h.field);

        const hasResult  = h.extractedValue !== undefined;
        const hasValue   = hasResult && h.extractedValue !== null && h.extractedValue !== '';
        const statusIcon = hasResult
          ? (hasValue ? (h.wasOcr ? '🟡' : '✅') : '❌')
          : null;

        const labelBelow = h.y < 0.06;

        const pct      = CONFIDENCE_PCT[h.confidence ?? 'low'] ?? 25;
        const pctColor = pct >= 90 ? '#22c55e' : pct >= 60 ? '#f59e0b' : '#ef4444';
        const pctText  = pct >= 90 ? '#86efac' : pct >= 60 ? '#fcd34d' : '#fca5a5';

        // Use live drag position when this highlight is being dragged
        const isDragging = dragging?.id === h.id;
        const isResizing = resize?.id === h.id;
        const isSelected = selectedIds?.has(h.id) ?? false;

        // If the group is being dragged together, apply the live delta to
        // every selected highlight for visual feedback.
        let posX = h.x;
        let posY = h.y;
        let posW = h.width;
        let posH = h.height;
        if (isDragging) {
          posX = dragging.previewX;
          posY = dragging.previewY;
        } else if (dragging && isSelected && selectedIds && selectedIds.has(dragging.id)) {
          const deltaX = dragging.previewX - dragging.startX;
          const deltaY = dragging.previewY - dragging.startY;
          posX = Math.max(0, Math.min(1 - h.width,  h.x + deltaX));
          posY = Math.max(0, Math.min(1 - h.height, h.y + deltaY));
        }
        if (isResizing && resize) {
          posX = resize.box.x;
          posY = resize.box.y;
          posW = resize.box.width;
          posH = resize.box.height;
        }

        const showSelectedRing = isSelected && !isDragging;

        return (
          <div
            key={h.id}
            className={`absolute group ${tool === 'cursor' ? 'pointer-events-auto' : 'pointer-events-none'}`}
            style={{
              left:            `${posX * 100}%`,
              top:             `${posY * 100}%`,
              width:           `${posW * 100}%`,
              height:          `${posH * 100}%`,
              backgroundColor: cfg.bgColor,
              border:          `2px ${h.isAutoExtracted && h.wasOcr ? 'dashed' : 'solid'} ${cfg.color}`,
              borderRadius:    3,
              zIndex:          isDragging ? 40 : isSelected ? 15 : 10,
              opacity:         h.isAutoExtracted && h.wasOcr ? 0.75 : 1,
              cursor:          tool === 'cursor' && onMove ? (isDragging ? 'grabbing' : 'move') : 'default',
              transition:      isDragging ? 'none' : 'box-shadow 0.15s ease',
              boxShadow:       isDragging
                ? `0 0 0 2px ${cfg.color}, 0 4px 12px rgba(0,0,0,0.2)`
                : showSelectedRing
                  ? `0 0 0 2px #2563eb, 0 0 0 4px rgba(37,99,235,0.25)`
                  : undefined,
            }}
            onMouseDown={e => handleBoxMouseDown(e, h)}
          >
            {/* Field label */}
            <span
              className="absolute left-0 text-[10px] font-medium px-1.5 py-0.5 rounded-sm whitespace-nowrap select-none z-20"
              style={{
                backgroundColor: cfg.color,
                color: '#ffffff',
                ...(labelBelow
                  ? { top: 'calc(100% + 2px)' }
                  : { bottom: 'calc(100% + 2px)' }),
              }}
            >
              {cfg.label}
            </span>

            {/* Status icon */}
            {statusIcon && (
              <span
                className="absolute text-xs select-none z-20"
                style={{
                  ...(labelBelow
                    ? { top: 'calc(100% + 2px)', right: 44 }
                    : { bottom: 'calc(100% + 2px)', right: 44 }),
                }}
              >
                {statusIcon}
              </span>
            )}

            {/* ── Resize handles ────────────────────────────────────
                Word/Paint style. Full-edge strips carry the two-sided
                cursor; 4 corner squares allow diagonal resize. Only
                rendered when the cursor tool is active, the handler is
                wired up, and the highlight is selected (to avoid a
                messy UI when many are on-screen). */}
            {tool === 'cursor' && onResize && (isSelected || isResizing) && (() => {
              const cornerSize = 10;
              const edgeThick  = 8;
              const common: React.CSSProperties = {
                position: 'absolute', zIndex: 50, pointerEvents: 'auto',
                userSelect: 'none', touchAction: 'none',
              };
              const onDown = (edge: Edge) => (e: React.MouseEvent) => beginResize(e, h, edge);
              return (
                <>
                  {/* Full-edge hit strips (transparent, cursor only) */}
                  <div style={{ ...common, left: 0, right: 0, top: -edgeThick / 2, height: edgeThick, cursor: EDGE_CURSOR.n }} onMouseDown={onDown('n')} />
                  <div style={{ ...common, left: 0, right: 0, bottom: -edgeThick / 2, height: edgeThick, cursor: EDGE_CURSOR.s }} onMouseDown={onDown('s')} />
                  <div style={{ ...common, top: 0, bottom: 0, left: -edgeThick / 2, width: edgeThick, cursor: EDGE_CURSOR.w }} onMouseDown={onDown('w')} />
                  <div style={{ ...common, top: 0, bottom: 0, right: -edgeThick / 2, width: edgeThick, cursor: EDGE_CURSOR.e }} onMouseDown={onDown('e')} />
                  {/* Corner squares */}
                  {([
                    ['nw', { top: 0,       left: 0 }],
                    ['ne', { top: 0,       right: 0 }],
                    ['sw', { bottom: 0,    left: 0 }],
                    ['se', { bottom: 0,    right: 0 }],
                  ] as Array<[Edge, React.CSSProperties]>).map(([edge, pos]) => (
                    <div
                      key={edge}
                      style={{
                        ...common,
                        ...pos,
                        width:  cornerSize,
                        height: cornerSize,
                        transform: `translate(${edge.includes('w') ? '-50%' : '50%'}, ${edge.includes('n') ? '-50%' : '50%'})`,
                        background: '#ffffff',
                        border: `2px solid ${cfg.color}`,
                        borderRadius: 2,
                        cursor: EDGE_CURSOR[edge],
                        boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
                      }}
                      onMouseDown={onDown(edge)}
                    />
                  ))}
                </>
              );
            })()}

            {/* Hover action button — Delete only */}
            {tool === 'cursor' && (
              <div
                className="absolute right-0 flex gap-0.5
                           opacity-0 group-hover:opacity-100 transition-all duration-200 z-30"
                style={{
                  ...(labelBelow
                    ? { top: 'calc(100% + 2px)' }
                    : { bottom: 'calc(100% + 2px)' }),
                }}
              >
                <button
                  className="w-5 h-5 rounded flex items-center justify-center
                             bg-red-500 hover:bg-red-600 transition-all duration-200"
                  onClick={e => { e.stopPropagation(); onDelete(h.id); }}
                  title={`Remove ${cfg.label} highlight`}
                >
                  <X className="w-2.5 h-2.5 text-white" />
                </button>
              </div>
            )}

            {/* Value + accuracy tooltip */}
            {hasValue && !isDragging && (
              <div
                className="absolute left-0 z-50 hidden group-hover:flex flex-col gap-1
                           bg-gray-900 text-white text-[11px] rounded-md shadow-xl
                           px-2.5 py-2 min-w-[160px] max-w-[260px] pointer-events-none"
                style={{
                  ...(labelBelow
                    ? { top: 'calc(100% + 24px)' }
                    : { bottom: 'calc(100% + 24px)' }),
                }}
              >
                <span className="font-semibold truncate">{h.extractedValue}</span>

                <div className="flex items-center gap-1.5 mt-0.5">
                  <div className="flex-1 h-1.5 bg-white/20 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${pct}%`, backgroundColor: pctColor }}
                    />
                  </div>
                  <span className="text-[10px] font-bold shrink-0" style={{ color: pctText }}>
                    {pct}%
                  </span>
                </div>
                <span className="text-[10px] text-white/50">
                  {pct >= 90 ? 'High' : pct >= 60 ? 'Medium' : 'Low'} accuracy
                </span>

                {h.wasOcr && (
                  <span className="text-[10px] text-amber-300">🔍 OCR extracted</span>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Live drawing box */}
      {drawing && (
        <div
          className="absolute pointer-events-none z-20"
          style={{
            left:            `${drawing.x * 100}%`,
            top:             `${drawing.y * 100}%`,
            width:           `${drawing.w * 100}%`,
            height:          `${drawing.h * 100}%`,
            border:          '2px dashed #2563eb',
            borderRadius:    3,
            backgroundColor: 'rgba(37,99,235,0.08)',
          }}
        />
      )}

      {/* Rubber-band selection box */}
      {selectionBox && (
        <div
          className="absolute pointer-events-none z-20"
          style={{
            left:            `${selectionBox.x * 100}%`,
            top:             `${selectionBox.y * 100}%`,
            width:           `${selectionBox.w * 100}%`,
            height:          `${selectionBox.h * 100}%`,
            border:          '1px dashed #2563eb',
            backgroundColor: 'rgba(37,99,235,0.1)',
          }}
        />
      )}
    </div>
  );
}
