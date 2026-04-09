/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useState, useMemo } from 'react';
import { X, Download, RefreshCw, Pencil, CheckCircle2, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
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

// Each displayed row: one (pdf, page) combination
interface PageRow {
  sessionId: string;
  filename: string;
  page: number;
  cells: Record<string, ExtractedRow>; // keyed by field name
}

// Parse a value for numeric sorting (strips $, commas, whitespace)
const parseForSort = (val: string): number => parseFloat(val.replace(/[$,\s]/g, ''));

export default function ExcelPanel({
  data, filename, provider, onClose, onReExtract, onDataChange, multiFile, onDownload,
}: Props) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [sortCol, setSortCol]       = useState<string | null>(null);
  const [sortAsc, setSortAsc]       = useState(true);

  // ── Build page rows grouped by PDF ─────────────────────────────────────
  const { groups, fieldColumns } = useMemo(() => {
    // Preserve PDF order based on first appearance
    const pdfOrder: string[] = [];
    const pdfMap = new Map<string, { filename: string; pages: Map<number, PageRow> }>();
    const seenFields = new Set<string>();
    const fieldOrder: string[] = [];

    for (const row of data) {
      const key = row.sessionId || row.filename || 'unknown';
      if (!pdfMap.has(key)) {
        pdfMap.set(key, { filename: row.filename || '', pages: new Map() });
        pdfOrder.push(key);
      }
      const pdf = pdfMap.get(key)!;
      if (!pdf.pages.has(row.page)) {
        pdf.pages.set(row.page, {
          sessionId: row.sessionId || key,
          filename: row.filename || '',
          page: row.page,
          cells: {},
        });
      }
      pdf.pages.get(row.page)!.cells[row.field] = row;

      if (!seenFields.has(row.field)) {
        seenFields.add(row.field);
        fieldOrder.push(row.field);
      }
    }

    const groupList = pdfOrder.map(key => {
      const pdf = pdfMap.get(key)!;
      return {
        sessionId: key,
        filename: pdf.filename,
        rows: Array.from(pdf.pages.values()).sort((a, b) => a.page - b.page),
      };
    });

    return { groups: groupList, fieldColumns: fieldOrder };
  }, [data]);

  // ── Sort within each PDF group ─────────────────────────────────────────
  const sortedGroups = useMemo(() => {
    if (!sortCol) return groups;
    return groups.map(g => {
      const rows = [...g.rows].sort((a, b) => {
        if (sortCol === 'page') {
          return sortAsc ? a.page - b.page : b.page - a.page;
        }
        // Sort by a field column
        const av = a.cells[sortCol]?.value ?? '';
        const bv = b.cells[sortCol]?.value ?? '';
        const aEmpty = !av;
        const bEmpty = !bv;
        if (aEmpty && bEmpty) return 0;
        if (aEmpty) return 1;
        if (bEmpty) return -1;

        const an = parseForSort(av);
        const bn = parseForSort(bv);
        if (!isNaN(an) && !isNaN(bn)) {
          return sortAsc ? an - bn : bn - an;
        }
        return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
      return { ...g, rows };
    });
  }, [groups, sortCol, sortAsc]);

  // Flatten sorted groups back to ExtractedRow[] for export
  const sortedFlat = useMemo(() => {
    const out: ExtractedRow[] = [];
    for (const g of sortedGroups) {
      for (const r of g.rows) {
        for (const f of fieldColumns) {
          const cell = r.cells[f];
          if (cell) out.push(cell);
        }
      }
    }
    return out;
  }, [sortedGroups, fieldColumns]);

  const handleSort = (col: string) => {
    if (sortCol === col) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(true); }
  };

  const handleEdit = (cellKey: string, cell: ExtractedRow, newValue: string) => {
    const next = data.map(r =>
      r === cell ? { ...r, value: newValue, edited: true } : r,
    );
    onDataChange(next);
    setEditingKey(null);
    void cellKey;
  };

  const SortIcon = ({ col }: { col: string }) => {
    if (sortCol !== col) return <ArrowUpDown className="w-3 h-3 opacity-40" />;
    return sortAsc
      ? <ArrowUp className="w-3 h-3" />
      : <ArrowDown className="w-3 h-3" />;
  };

  const extracted = data.filter(r => r.value).length;
  const nullCount = data.filter(r => !r.value).length;
  const totalRows = sortedGroups.reduce((s, g) => s + g.rows.length, 0);

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

        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="flex-1 h-8 text-xs" onClick={onReExtract}>
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Re-extract
          </Button>
          <Button
            size="sm"
            className="flex-1 h-8 text-xs bg-primary hover:bg-primary/90 text-primary-foreground font-semibold"
            onClick={() => { exportToExcel(sortedFlat, filename, provider); onDownload?.(); }}
          >
            <Download className="w-3.5 h-3.5 mr-1.5" /> Export .xlsx
          </Button>
        </div>
      </div>

      {/* ── Scrollable table area ─────────────────────────────────────── */}
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
          <table className="min-w-full text-xs border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="bg-primary text-primary-foreground text-[11px] font-semibold">
                {multiFile && (
                  <th
                    className="text-left px-3 py-2.5 cursor-pointer hover:bg-white/10 select-none transition-all duration-200 whitespace-nowrap"
                    onClick={() => handleSort('filename')}
                  >
                    <span className="inline-flex items-center gap-1">File <SortIcon col="filename" /></span>
                  </th>
                )}
                <th
                  className="text-left px-3 py-2.5 cursor-pointer hover:bg-white/10 select-none transition-all duration-200 whitespace-nowrap"
                  onClick={() => handleSort('page')}
                >
                  <span className="inline-flex items-center gap-1">Page <SortIcon col="page" /></span>
                </th>
                {fieldColumns.map(f => {
                  const cfg = getFieldConfig(f);
                  return (
                    <th
                      key={f}
                      className="text-left px-3 py-2.5 cursor-pointer hover:bg-white/10 select-none transition-all duration-200 whitespace-nowrap border-l border-white/10"
                      onClick={() => handleSort(f)}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: cfg.color }} />
                        <span>{cfg.label}</span>
                        <SortIcon col={f} />
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sortedGroups.map((g, gi) => (
                <React.Fragment key={g.sessionId}>
                  {g.rows.map((row, ri) => {
                    const isLastInGroup = ri === g.rows.length - 1;
                    return (
                      <tr
                        key={`${g.sessionId}-${row.page}`}
                        className={`group/row transition-all duration-200 hover:bg-primary/5
                          ${ri % 2 === 0 ? 'bg-card' : 'bg-muted/20'}
                          ${isLastInGroup && gi < sortedGroups.length - 1 ? 'border-b-2 border-b-primary/40' : 'border-b border-border/40'}`}
                      >
                        {multiFile && (
                          <td className="px-3 py-2 text-muted-foreground text-[10px] truncate max-w-[140px]" title={g.filename}>
                            {ri === 0 ? g.filename.replace(/\.pdf$/i, '') : ''}
                          </td>
                        )}
                        <td className="px-3 py-2 text-muted-foreground font-medium">
                          {row.page}
                        </td>
                        {fieldColumns.map(f => {
                          const cell = row.cells[f];
                          const cellKey = `${g.sessionId}-${row.page}-${f}`;
                          if (!cell) {
                            return <td key={f} className="px-3 py-2 text-muted-foreground/30 italic border-l border-border/40">—</td>;
                          }
                          const isNull  = cell.value === null || cell.value === undefined || cell.value === '';
                          const pct     = CONF_PCT[cell.confidence ?? 'low'] ?? 25;
                          const pctColor = pct >= 90 ? '#22c55e' : pct >= 60 ? '#f59e0b' : '#ef4444';
                          const isEditing = editingKey === cellKey;

                          return (
                            <td
                              key={f}
                              className="px-3 py-2 cursor-text border-l border-border/40 min-w-[120px]"
                              onDoubleClick={() => setEditingKey(cellKey)}
                              title="Double-click to edit"
                            >
                              {isEditing ? (
                                <input
                                  className="w-full bg-card border border-primary rounded px-2 py-1 text-xs outline-none shadow-sm text-foreground"
                                  defaultValue={cell.value || ''}
                                  autoFocus
                                  onBlur={e => handleEdit(cellKey, cell, e.target.value)}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter') handleEdit(cellKey, cell, (e.target as HTMLInputElement).value);
                                    if (e.key === 'Escape') setEditingKey(null);
                                  }}
                                />
                              ) : (
                                <div className="flex items-center gap-2 min-w-0">
                                  {isNull ? (
                                    <span className="text-muted-foreground/40 italic">—</span>
                                  ) : (
                                    <span className={`truncate ${cell.edited ? 'text-warning' : 'text-foreground'}`}>
                                      {cell.value}
                                    </span>
                                  )}
                                  {!isNull && (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <div className="ml-auto shrink-0 opacity-0 group-hover/row:opacity-100 transition-opacity">
                                          <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: pctColor }} />
                                        </div>
                                      </TooltipTrigger>
                                      <TooltipContent side="left" className="text-xs">
                                        <div className="space-y-0.5">
                                          <div>{pct >= 90 ? 'High' : pct >= 60 ? 'Medium' : 'Low'} accuracy ({pct}%)</div>
                                          {cell.wasOcr && <div className="text-amber-300">🔍 OCR extracted</div>}
                                        </div>
                                      </TooltipContent>
                                    </Tooltip>
                                  )}
                                  {cell.edited && <Pencil className="w-2.5 h-2.5 text-amber-500 shrink-0" />}
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Footer summary ─────────────────────────────────────────────── */}
      {data.length > 0 && (
        <div className="bg-card border-t border-border px-5 py-2.5 shrink-0">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{totalRows} row{totalRows !== 1 ? 's' : ''} across {sortedGroups.length} PDF{sortedGroups.length !== 1 ? 's' : ''} · double-click any cell to edit</span>
            <span className="text-primary font-medium">{extracted} extracted</span>
          </div>
        </div>
      )}
    </div>
  );
}
