/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react';
import { X, Download, RefreshCw, Pencil, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ExtractedRow } from '@/types/utilscraper';
import { getFieldConfig } from '@/types/utilscraper';
import { exportToExcel } from '@/lib/excel-export';

interface Props {
  data: ExtractedRow[];
  filename: string;
  provider: string;
  onClose: () => void;
  onReExtract: () => void;
  onDataChange: (data: ExtractedRow[]) => void;
  multiFile?: boolean;
  onDownload?: () => void;
}

const CONF_PCT: Record<string, number> = { high: 95, medium: 65, low: 25 };

export default function ExcelPanel({ data, filename, provider, onClose, onReExtract, onDataChange, multiFile, onDownload }: Props) {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [sortCol, setSortCol]       = useState<string | null>(null);
  const [sortAsc, setSortAsc]       = useState(true);

  const sorted = [...data].sort((a, b) => {
    if (!sortCol) return 0;
    const av = String((a as any)[sortCol] ?? '');
    const bv = String((b as any)[sortCol] ?? '');
    return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
  });

  const handleSort = (col: string) => {
    if (sortCol === col) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(true); }
  };

  const handleEdit = (rowIdx: number, value: string) => {
    const next    = [...data];
    const realIdx = data.indexOf(sorted[rowIdx]);
    next[realIdx] = { ...next[realIdx], value, edited: true };
    onDataChange(next);
    setEditingIdx(null);
  };

  const extracted  = data.filter(r => r.value).length;
  const nullCount  = data.filter(r => !r.value).length;

  return (
    <div className="h-full flex flex-col bg-background">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="bg-card border-b border-border px-5 py-3 shrink-0">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-sm font-bold text-foreground">Extracted Data</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {extracted} value{extracted !== 1 ? 's' : ''} extracted
              {nullCount > 0 && <span className="text-warning ml-1">· {nullCount} empty</span>}
            </p>
          </div>
          <button
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-all duration-200"
            onClick={onClose}
            aria-label="Close panel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 h-8 text-xs"
            onClick={onReExtract}
          >
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Re-extract
          </Button>
          <Button
            size="sm"
            className="flex-1 h-8 text-xs bg-primary hover:bg-primary/90 text-primary-foreground font-semibold"
            onClick={() => { exportToExcel(data, filename, provider); onDownload?.(); }}
          >
            <Download className="w-3.5 h-3.5 mr-1.5" /> Export .xlsx
          </Button>
        </div>
      </div>

      {/* ── Column headers ─────────────────────────────────────────────── */}
      <div className="bg-primary text-primary-foreground text-[11px] font-semibold flex shrink-0">
        {multiFile && (
          <div
            className="w-28 shrink-0 px-3 py-2.5 cursor-pointer hover:bg-white/10 select-none transition-all duration-200 truncate"
            onClick={() => handleSort('filename')}
          >
            File {sortCol === 'filename' ? (sortAsc ? '↑' : '↓') : ''}
          </div>
        )}
        {['Page', 'Field', 'Value'].map(col => (
          <div
            key={col}
            className={`px-4 py-2.5 cursor-pointer hover:bg-white/10 select-none transition-all duration-200
              ${col === 'Page' ? 'w-14 shrink-0' : col === 'Field' ? 'w-44 shrink-0' : 'flex-1 border-l border-white/10'}`}
            onClick={() => handleSort(col.toLowerCase())}
          >
            {col} {sortCol === col.toLowerCase() ? (sortAsc ? '↑' : '↓') : ''}
          </div>
        ))}
      </div>

      {/* ── Rows ───────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto custom-scrollbar">
        {data.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
            <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
              <CheckCircle2 className="w-6 h-6 text-primary/50" />
            </div>
            <p className="text-sm text-muted-foreground">No values extracted yet.</p>
            <p className="text-xs text-muted-foreground/60">Draw highlight boxes over bill values then click Extract.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {sorted.map((row, i) => {
              const isNull  = row.value === null || row.value === undefined;
              const cfg     = getFieldConfig(row.field);
              const pct     = CONF_PCT[row.confidence ?? 'low'] ?? 25;
              const pctColor = pct >= 90 ? '#22c55e' : pct >= 60 ? '#f59e0b' : '#ef4444';

              return (
                <div
                  key={i}
                  className={`group/row flex items-stretch text-xs transition-all duration-200
                    ${i % 2 === 0 ? 'bg-card' : 'bg-muted/30'}
                    ${row.edited ? 'border-l-2 border-l-warning/60' : ''}
                    hover:bg-primary/5`}
                >
                  {/* File (multi-PDF mode) */}
                  {multiFile && (
                    <div className="w-28 shrink-0 px-3 py-3 text-muted-foreground text-[10px] flex items-center truncate" title={row.filename}>
                      {row.filename?.replace(/\.pdf$/i, '') ?? ''}
                    </div>
                  )}

                  {/* Page */}
                  <div className="w-14 shrink-0 px-4 py-3 text-muted-foreground font-medium flex items-center">
                    {row.page}
                  </div>

                  {/* Field */}
                  <div className="w-44 shrink-0 px-3 py-3 flex items-center">
                    <span className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: cfg.color }} />
                      <span className="text-foreground font-medium truncate">{cfg.label}</span>
                    </span>
                  </div>

                  {/* Value */}
                  <div
                    className="flex-1 px-3 py-3 flex items-center cursor-text border-l border-border"
                    onDoubleClick={() => setEditingIdx(i)}
                    title="Double-click to edit"
                  >
                    {editingIdx === i ? (
                      <input
                        className="w-full bg-card border border-primary rounded px-2 py-1 text-xs outline-none shadow-sm text-foreground"
                        defaultValue={row.value || ''}
                        autoFocus
                        onBlur={e => handleEdit(i, e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleEdit(i, (e.target as HTMLInputElement).value);
                          if (e.key === 'Escape') setEditingIdx(null);
                        }}
                      />
                    ) : (
                      <div className="flex items-center gap-2 w-full min-w-0">
                        {isNull ? (
                          <span className="text-muted-foreground/40 italic">—</span>
                        ) : (
                          <span className={`truncate ${row.edited ? 'text-warning' : 'text-foreground'}`}>
                            {row.value}
                          </span>
                        )}

                        <div className="ml-auto flex items-center gap-1.5 shrink-0">
                          {/* Accuracy — hidden by default, shown on row hover */}
                          {!isNull && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="flex items-center gap-1 cursor-help opacity-0 group-hover/row:opacity-100 transition-opacity">
                                  <div className="w-12 h-1.5 bg-muted rounded-full overflow-hidden">
                                    <div
                                      className="h-full rounded-full"
                                      style={{ width: `${pct}%`, backgroundColor: pctColor }}
                                    />
                                  </div>
                                  <span className="text-[10px] font-semibold" style={{ color: pctColor }}>
                                    {pct}%
                                  </span>
                                </div>
                              </TooltipTrigger>
                              <TooltipContent side="left" className="text-xs">
                                <div className="space-y-1">
                                  <div>{pct >= 90 ? 'High' : pct >= 60 ? 'Medium' : 'Low'} accuracy</div>
                                  {row.wasOcr && <div className="text-amber-300">🔍 OCR extracted</div>}
                                </div>
                              </TooltipContent>
                            </Tooltip>
                          )}

                          {row.edited && <Pencil className="w-3 h-3 text-amber-500" />}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Footer summary ─────────────────────────────────────────────── */}
      {data.length > 0 && (
        <div className="bg-card border-t border-border px-5 py-2.5 shrink-0">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{data.length} row{data.length !== 1 ? 's' : ''} · double-click any value to edit</span>
            <span className="text-primary font-medium">{extracted} extracted</span>
          </div>
        </div>
      )}
    </div>
  );
}