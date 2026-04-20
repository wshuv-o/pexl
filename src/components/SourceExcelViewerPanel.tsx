import { X, Download, Key } from 'lucide-react';
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import type { SourceExcel } from '@/lib/automap/excel-reader';
import type { HeaderToField } from '@/lib/automap/header-mapping';
import type { ExtractedRow } from '@/types/utilscraper';

// ───────────────────────────────────────────────────────────────────────────
// Right-rail panel shown when a source Excel is loaded. Replaces the normal
// ExcelPanel so the user can see the template they uploaded and where their
// extracted values will land before clicking Download.
// ───────────────────────────────────────────────────────────────────────────

interface Props {
  sourceExcel: SourceExcel;
  headerMappings: HeaderToField[];
  data: ExtractedRow[];
  rowKeyHeader: string | null;
  onClose: () => void;
  onDownload: () => void;
}

export default function SourceExcelViewerPanel({
  sourceExcel, headerMappings, data, rowKeyHeader, onClose, onDownload,
}: Props) {
  // ── Group extracted data by session (one PDF → one row), and compute
  // pending values keyed by column index. We also resolve the target row
  // per session via the row-key header when set, else append in order.
  const { perSession, pendingByCol, targetRows } = useMemo(() => {
    // Group
    const bySession = new Map<string, ExtractedRow[]>();
    const sessionOrder: string[] = [];
    for (const r of data) {
      if (!r.value) continue;
      const key = r.sessionId || r.filename || 'unknown';
      if (!bySession.has(key)) { bySession.set(key, []); sessionOrder.push(key); }
      bySession.get(key)!.push(r);
    }

    // Header → fieldKey + column index lookups.
    const headerFieldKey = new Map<string, string>();
    for (const m of headerMappings) {
      if (m.fieldKey) headerFieldKey.set(m.excelHeader, m.fieldKey);
    }
    const rowKeyColIdx = rowKeyHeader ? sourceExcel.headers.indexOf(rowKeyHeader) : -1;
    const rowKeyFieldKey = rowKeyHeader ? headerFieldKey.get(rowKeyHeader) ?? null : null;

    // Per-session record: resolved targetRow0 + values keyed by column index.
    type Record = { sessionId: string; targetRow: number; byCol: Map<number, string> };
    const records: Record[] = [];
    let appendCursor = sourceExcel.rows.length;

    for (const sid of sessionOrder) {
      const sessRows = bySession.get(sid)!;
      const byCol = new Map<number, string>();
      for (const [excelHeader, fieldKey] of headerFieldKey) {
        const colIdx = sourceExcel.headers.indexOf(excelHeader);
        if (colIdx < 0) continue;
        const matches = sessRows.filter(r => r.field === fieldKey && r.value);
        if (matches.length === 0) continue;
        byCol.set(colIdx, matches.length === 1
          ? String(matches[0].value)
          : matches.map(m => String(m.value)).join('; '));
      }

      // Resolve target row via row-key.
      let targetRow = appendCursor;
      if (rowKeyHeader && rowKeyFieldKey && rowKeyColIdx >= 0) {
        const keyHit = sessRows.find(r => r.field === rowKeyFieldKey && r.value);
        if (keyHit?.value) {
          const needle = String(keyHit.value).trim().toLowerCase();
          const idx = sourceExcel.rows.findIndex(r => (r[rowKeyColIdx] ?? '').trim().toLowerCase() === needle);
          if (idx >= 0) targetRow = idx;
        }
      }
      if (targetRow === appendCursor) appendCursor++;
      records.push({ sessionId: sid, targetRow, byCol });
    }

    // Flatten for table rendering.
    const pendingByCol = new Map<number, Map<number, string>>();
    const targetRowSet = new Set<number>();
    for (const rec of records) {
      if (!pendingByCol.has(rec.targetRow)) pendingByCol.set(rec.targetRow, new Map());
      const rowMap = pendingByCol.get(rec.targetRow)!;
      for (const [c, v] of rec.byCol) rowMap.set(c, v);
      targetRowSet.add(rec.targetRow);
    }

    return {
      perSession: records,
      pendingByCol,
      targetRows: targetRowSet,
    };
  }, [data, headerMappings, sourceExcel, rowKeyHeader]);

  // Render-row cap so a massive template doesn't lag the preview.
  const rowCount = Math.max(sourceExcel.rows.length, ...[...targetRows].map(r => r + 1), 0);
  const colCount = sourceExcel.headers.length;
  const rows: string[][] = Array.from(
    { length: rowCount },
    (_, i) => sourceExcel.rows[i] ?? Array(colCount).fill(''),
  );

  const anyKeyResolved = rowKeyHeader && perSession.some(r => r.targetRow < sourceExcel.rows.length);

  return (
    <div className="h-full flex flex-col bg-background">
      {/* ── Header ───────────────────────────────────────────────────── */}
      <div className="bg-card border-b border-border px-5 py-3 shrink-0">
        <div className="flex items-center justify-between mb-2">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-foreground truncate">Source Excel preview</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {sourceExcel.sheetName} · {sourceExcel.headers.length} cols · {sourceExcel.rows.length} rows
              {perSession.length > 0 && (
                <> · <span className="text-primary">{perSession.length} row{perSession.length !== 1 ? 's' : ''} pending</span></>
              )}
            </p>
          </div>
          <button
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            onClick={onClose}
            title="Close panel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center gap-2">
          {anyKeyResolved && (
            <span className="flex items-center gap-1 text-[11px] text-amber-600 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-0.5">
              <Key className="w-3 h-3" />
              Row(s) matched via key field
            </span>
          )}
          <Button
            size="sm"
            className="ml-auto h-8 text-xs bg-primary hover:bg-primary/90 text-primary-foreground font-semibold"
            onClick={onDownload}
            disabled={perSession.length === 0}
          >
            <Download className="w-3.5 h-3.5 mr-1.5" /> Download filled Excel
          </Button>
        </div>
      </div>

      {/* ── Table ────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto custom-scrollbar">
        <table className="min-w-full text-xs border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="bg-primary text-primary-foreground text-[11px] font-semibold">
              <th className="text-left px-2 py-2 border-r border-white/10 w-10">#</th>
              {sourceExcel.headers.map((h, i) => (
                <th key={i} className="text-left px-3 py-2 whitespace-nowrap border-l border-white/10">
                  {h || <span className="text-white/40 italic">col {i + 1}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const isTarget = targetRows.has(i);
              const pending = pendingByCol.get(i);
              return (
                <tr
                  key={i}
                  className={`${isTarget ? 'bg-primary/10 ring-2 ring-inset ring-primary/50' : i % 2 === 0 ? 'bg-card' : 'bg-muted/20'}
                              border-b border-border/40`}
                >
                  <td className="px-2 py-2 text-muted-foreground font-medium">{i + 1}</td>
                  {sourceExcel.headers.map((_, c) => {
                    const existing = row[c] ?? '';
                    const p = pending?.get(c) ?? '';
                    const value = p || existing;
                    const isPending = isTarget && !!p && p !== existing;
                    return (
                      <td
                        key={c}
                        className={`px-3 py-2 border-l border-border/40 max-w-[220px] truncate
                          ${isPending ? 'text-primary font-semibold' : 'text-foreground'}`}
                        title={value}
                      >
                        {value || <span className="text-muted-foreground/40 italic">—</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
