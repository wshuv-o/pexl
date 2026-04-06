import { X, RotateCcw } from 'lucide-react';
import type { Highlight, ViewerTool } from '@/types/utilscraper';
import { getFieldConfig } from '@/types/utilscraper';

interface Props {
  highlights: Highlight[];
  drawing: { x: number; y: number; w: number; h: number } | null;
  onDelete: (id: string) => void;
  onReExtract: (id: string) => void;
  tool: ViewerTool;
}

// Confidence level → percentage shown in tooltip
const CONFIDENCE_PCT: Record<string, number> = {
  high:   95,
  medium: 65,
  low:    25,
};

export default function HighlightOverlay({ highlights, drawing, onDelete, onReExtract, tool }: Props) {
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
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

        return (
          <div
            key={h.id}
            className={`absolute group ${tool === 'cursor' ? 'pointer-events-auto' : 'pointer-events-none'}`}
            style={{
              left:            `${h.x * 100}%`,
              top:             `${h.y * 100}%`,
              width:           `${h.width * 100}%`,
              height:          `${h.height * 100}%`,
              backgroundColor: cfg.bgColor,
              border:          `2px ${h.isAutoExtracted && h.wasOcr ? 'dashed' : 'solid'} ${cfg.color}`,
              borderRadius:    3,
              zIndex:          10,
              opacity:         h.isAutoExtracted && h.wasOcr ? 0.75 : 1,
            }}
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

            {/* Hover action buttons — Re-extract + Delete */}
            {tool === 'cursor' && (
              <div
                className="absolute right-0 flex gap-0.5
                           opacity-0 group-hover:opacity-100 transition-opacity z-30"
                style={{
                  ...(labelBelow
                    ? { top: 'calc(100% + 2px)' }
                    : { bottom: 'calc(100% + 2px)' }),
                }}
              >
                <button
                  className="w-5 h-5 rounded flex items-center justify-center
                             bg-blue-600 hover:bg-blue-700 transition-all duration-200"
                  onClick={e => { e.stopPropagation(); onReExtract(h.id); }}
                  title={`Re-extract ${cfg.label}`}
                >
                  <RotateCcw className="w-2.5 h-2.5 text-white" />
                </button>
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
            {hasValue && (
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

                {/* Accuracy bar + % */}
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
    </div>
  );
}