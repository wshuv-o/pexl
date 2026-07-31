import { useMemo } from 'react';
import type ExcelJS from 'exceljs';

/**
 * Renders a built ExcelJS worksheet as an HTML table.
 *
 * Used by the batch preview so "Template" shows the actual exported workbook
 * — the same sheets, headers, merged title bars, month columns and totals —
 * rather than an approximation of it. Styling is read straight off the cells
 * (fills, fonts, alignment, number formats) so the preview tracks whatever
 * the export templates do without needing to be kept in sync by hand.
 *
 * Formula cells are the one unavoidable gap: nothing has calculated them yet
 * (Excel does that on open), so we show ExcelJS's cached result when there is
 * one and otherwise leave the cell blank, marked so the user knows a value
 * will appear in the real file.
 */

interface Props {
  worksheet: ExcelJS.Worksheet;
  /** Hard cap so a pathological sheet can't lock up the browser. */
  maxRows?: number;
}

interface Span { rowSpan: number; colSpan: number }

/** "B12" → { r: 12, c: 2 } */
function decodeAddress(addr: string): { r: number; c: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(addr.replace(/\$/g, '').toUpperCase());
  if (!m) return { r: 1, c: 1 };
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: parseInt(m[2], 10), c };
}

/** ExcelJS ARGB ("FF1F497D") → CSS hex. Returns undefined when absent. */
function argbToCss(argb?: string): string | undefined {
  if (!argb || argb.length < 6) return undefined;
  const hex = argb.length === 8 ? argb.slice(2) : argb;
  return `#${hex}`;
}

/** Approximate Excel's display for the formats these templates actually use. */
function formatValue(raw: unknown, numFmt?: string): string {
  if (raw === null || raw === undefined) return '';

  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (raw instanceof Date) return raw.toLocaleDateString();
    if ('formula' in o) {
      const res = o.result;
      return res === undefined || res === null ? '' : formatValue(res, numFmt);
    }
    if ('richText' in o) {
      return (o.richText as { text: string }[]).map(t => t.text).join('');
    }
    if ('text' in o) return String(o.text);
    if ('error' in o) return String(o.error);
    return '';
  }

  if (typeof raw === 'number' && numFmt) {
    if (numFmt.includes('%')) return `${(raw * 100).toFixed(2)}%`;
    if (numFmt.includes('$')) {
      return raw.toLocaleString(undefined, {
        style: 'currency', currency: 'USD',
        minimumFractionDigits: 2, maximumFractionDigits: 2,
      });
    }
    if (numFmt.includes('0.00')) return raw.toFixed(2);
  }
  return String(raw);
}

export default function SheetGrid({ worksheet, maxRows = 400 }: Props) {
  const { spans, covered } = useMemo(() => {
    const spanMap = new Map<string, Span>();
    const coveredSet = new Set<string>();
    // ExcelJS keeps merges on the worksheet model as "A1:C1" ranges.
    const merges = ((worksheet.model as { merges?: string[] } | undefined)?.merges ?? []);
    for (const range of merges) {
      const [from, to] = range.split(':');
      if (!from || !to) continue;
      const a = decodeAddress(from);
      const b = decodeAddress(to);
      spanMap.set(`${a.r},${a.c}`, { rowSpan: b.r - a.r + 1, colSpan: b.c - a.c + 1 });
      for (let r = a.r; r <= b.r; r++) {
        for (let c = a.c; c <= b.c; c++) {
          if (r !== a.r || c !== a.c) coveredSet.add(`${r},${c}`);
        }
      }
    }
    return { spans: spanMap, covered: coveredSet };
  }, [worksheet]);

  const colCount = Math.max(worksheet.columnCount ?? 0, 1);
  const rowCount = Math.min(worksheet.rowCount ?? 0, maxRows);
  const truncated = (worksheet.rowCount ?? 0) > rowCount;

  const rows = [];
  for (let r = 1; r <= rowCount; r++) {
    const row = worksheet.getRow(r);
    const cells = [];
    for (let c = 1; c <= colCount; c++) {
      if (covered.has(`${r},${c}`)) continue;
      const cell = row.getCell(c);
      const span = spans.get(`${r},${c}`);

      const fill = cell.fill as { fgColor?: { argb?: string }; pattern?: string } | undefined;
      const bg = fill?.pattern === 'solid' ? argbToCss(fill.fgColor?.argb) : undefined;
      const font = cell.font as
        { bold?: boolean; italic?: boolean; size?: number; color?: { argb?: string } } | undefined;
      const align = cell.alignment as { horizontal?: string } | undefined;

      const isFormula = typeof cell.value === 'object'
        && cell.value !== null
        && 'formula' in (cell.value as object);
      const text = formatValue(cell.value, cell.numFmt);

      cells.push(
        <td
          key={c}
          rowSpan={span?.rowSpan}
          colSpan={span?.colSpan}
          title={isFormula && !text
            ? `Calculated in Excel: =${(cell.value as { formula: string }).formula}`
            : text || undefined}
          style={{
            backgroundColor: bg,
            color: argbToCss(font?.color?.argb),
            fontWeight: font?.bold ? 700 : undefined,
            fontStyle: font?.italic ? 'italic' : undefined,
            textAlign: (align?.horizontal as 'left' | 'center' | 'right') ?? undefined,
            border: '1px solid rgba(128,128,128,0.28)',
            padding: '3px 8px',
            whiteSpace: 'nowrap',
            fontSize: 11,
          }}
        >
          {text || (isFormula ? <span className="opacity-30 italic">ƒ</span> : '')}
        </td>,
      );
    }
    rows.push(<tr key={r}>{cells}</tr>);
  }

  return (
    <div className="overflow-auto">
      <table className="border-collapse" style={{ background: '#fff', color: '#111' }}>
        <tbody>{rows}</tbody>
      </table>
      {truncated && (
        <p className="text-[10px] text-muted-foreground px-3 py-2">
          Showing the first {maxRows} rows — the downloaded file contains all of them.
        </p>
      )}
    </div>
  );
}
