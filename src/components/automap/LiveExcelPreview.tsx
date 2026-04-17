import { Download, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { SourceExcel } from '@/lib/automap/excel-reader';
import type { MappingState } from './MappingReview';

interface Props {
  source: SourceExcel;
  mappings: MappingState[];
  targetRow0: number;
  onTargetRowChange: (r: number) => void;
  onDownload: () => void;
}

export default function LiveExcelPreview({
  source, mappings, targetRow0, onTargetRowChange, onDownload,
}: Props) {
  // Pending values, keyed by the column INDEX (not header string) so that
  // duplicate or empty headers in the template don't cause values to
  // collide on the same key. We look up each mapping's Excel header in
  // source.headers to find its column index.
  const live: Record<number, string> = {};
  for (const m of mappings) {
    if (m.status === 'rejected') continue;
    const v = m.override ?? m.chosenBox?.value ?? m.match.box?.value ?? '';
    if (!v) continue;
    const colIdx = source.headers.indexOf(m.mapping.excelHeader);
    if (colIdx >= 0) live[colIdx] = v;
  }

  // Build a virtual row list — if targetRow0 is past the existing data,
  // pad empty rows so the preview scrolls far enough to reveal it.
  const rowCount = Math.max(source.rows.length, targetRow0 + 1);
  const colCount = source.headers.length;
  const rows: string[][] = Array.from({ length: rowCount }, (_, i) => source.rows[i] ?? Array(colCount).fill(''));

  return (
    <div className="flex flex-col h-full bg-card">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-bold text-foreground">Live Excel preview</h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {source.sheetName} · header row {source.headerRow + 1} · {source.headers.length} columns · {source.rows.length} data rows
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <label className="text-[11px] text-muted-foreground">Write to row</label>
          <div className="flex items-center gap-0.5 bg-muted rounded">
            <button
              className="px-1.5 py-0.5 text-xs hover:bg-muted/80"
              onClick={() => onTargetRowChange(Math.max(0, targetRow0 - 1))}
            >−</button>
            <input
              type="number"
              min={1}
              value={targetRow0 + 1}
              onChange={e => onTargetRowChange(Math.max(0, (parseInt(e.target.value) || 1) - 1))}
              className="w-12 text-center bg-transparent text-xs outline-none"
            />
            <button
              className="px-1.5 py-0.5 text-xs hover:bg-muted/80"
              onClick={() => onTargetRowChange(targetRow0 + 1)}
            >+</button>
          </div>
          <ChevronsUpDown className="w-3.5 h-3.5 text-muted-foreground" />
        </div>
        <Button size="sm" className="gap-1.5" onClick={onDownload}>
          <Download className="w-3.5 h-3.5" /> Download
        </Button>
      </div>

      <div className="flex-1 overflow-auto custom-scrollbar">
        <table className="min-w-full text-xs border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="bg-primary text-primary-foreground text-[11px] font-semibold">
              <th className="text-left px-2 py-2 border-r border-white/10 w-10">#</th>
              {source.headers.map((h, i) => (
                <th key={i} className="text-left px-3 py-2 whitespace-nowrap border-l border-white/10">
                  {h || <span className="text-white/40 italic">col {i + 1}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const isTarget = i === targetRow0;
              return (
                <tr
                  key={i}
                  className={`${isTarget ? 'bg-primary/10 ring-2 ring-inset ring-primary/50'
                                        : i % 2 === 0 ? 'bg-card' : 'bg-muted/20'}
                              border-b border-border/40`}
                >
                  <td className="px-2 py-2 text-muted-foreground font-medium">{i + 1}</td>
                  {source.headers.map((_, c) => {
                    const existing = row[c] ?? '';
                    const pending  = isTarget ? live[c] ?? '' : '';
                    const value     = pending || existing;
                    const isPending = isTarget && !!pending && pending !== existing;
                    return (
                      <td
                        key={c}
                        className={`px-3 py-2 border-l border-border/40 max-w-[220px] truncate
                          ${isPending ? 'text-primary font-medium' : 'text-foreground'}`}
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
