import * as XLSX from 'xlsx-js-style';
import type { SourceExcel } from './excel-reader';
import type { HeaderToField } from './header-mapping';
import type { ExtractedRow } from '@/types/utilscraper';

// ───────────────────────────────────────────────────────────────────────────
// Write the confirmed values back into the original workbook without
// destroying the cell styles the user set up in their template. We mutate
// the existing sheet in place and return a Blob ready for download.
//
// `rowIndex0` is 0-based, relative to the FIRST data row (i.e. the row
// immediately under the headers). So rowIndex0 = 0 fills the first data row.
// ───────────────────────────────────────────────────────────────────────────

export interface WriteOptions {
  source: SourceExcel;
  rowIndex0: number;
  values: Record<string, string>;  // header → value
}

export const writeValuesToWorkbook = ({ source, rowIndex0, values }: WriteOptions): XLSX.WorkBook => {
  const { workbook, sheetName, headers, headerRow, sheetColumns } = source;
  const sheet = workbook.Sheets[sheetName];
  const targetRow = headerRow + 1 + rowIndex0; // 0-based in the sheet

  let maxSheetCol = 0;
  headers.forEach((h, i) => {
    if (!(h in values)) return;
    // Map the panel-local index back to the column it came from in the
    // actual sheet (hidden / empty columns were skipped by the reader).
    const sheetCol = sheetColumns[i] ?? i;
    if (sheetCol > maxSheetCol) maxSheetCol = sheetCol;
    const addr = XLSX.utils.encode_cell({ r: targetRow, c: sheetCol });
    const prev = sheet[addr] ?? {};
    sheet[addr] = {
      ...prev,
      t: 's',
      v: values[h] ?? '',
      w: values[h] ?? '',
    };
  });

  // Extend the sheet's !ref if we wrote past its existing range.
  const ref = sheet['!ref'];
  if (ref) {
    const range = XLSX.utils.decode_range(ref);
    if (targetRow > range.e.r) range.e.r = targetRow;
    if (maxSheetCol > range.e.c) range.e.c = maxSheetCol;
    sheet['!ref'] = XLSX.utils.encode_range(range);
  }

  return workbook;
};

export const workbookToBlob = (wb: XLSX.WorkBook): Blob => {
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx', cellStyles: true });
  return new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
};

export const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

// ───────────────────────────────────────────────────────────────────────────
// High-level: take every extracted row, group by session (one PDF → one
// Excel row), resolve the target row via the row-key header when set
// (else append), write each PDF's values into its resolved row, and
// download the filled workbook. Preserves cell styles via
// writeValuesToWorkbook.
// ───────────────────────────────────────────────────────────────────────────
export function fillAndDownloadSourceExcel(
  rows: ExtractedRow[],
  source: SourceExcel,
  mappings: HeaderToField[],
  rowKeyHeader: string | null,
): void {
  // Group ExtractedRows by session (one session = one PDF = one row).
  const bySession = new Map<string, ExtractedRow[]>();
  const sessionOrder: string[] = [];
  for (const r of rows) {
    if (!r.value) continue;
    const key = r.sessionId || r.filename || 'unknown';
    if (!bySession.has(key)) { bySession.set(key, []); sessionOrder.push(key); }
    bySession.get(key)!.push(r);
  }
  if (bySession.size === 0) return;

  // Lookup: excelHeader → fieldKey. Only mapped headers land in the sheet.
  const headerFieldKey = new Map<string, string>();
  for (const m of mappings) {
    if (m.fieldKey) headerFieldKey.set(m.excelHeader, m.fieldKey);
  }
  const rowKeyColIdx  = rowKeyHeader ? source.headers.indexOf(rowKeyHeader) : -1;
  const rowKeyFieldKey = rowKeyHeader ? headerFieldKey.get(rowKeyHeader) ?? null : null;

  // Track the next append row so unmatched PDFs don't overwrite each other.
  let nextAppendRow = source.rows.length;

  for (const sid of sessionOrder) {
    const sessRows = bySession.get(sid)!;
    const values: Record<string, string> = {};
    for (const [excelHeader, fieldKey] of headerFieldKey) {
      const matches = sessRows.filter(r => r.field === fieldKey && r.value);
      if (matches.length === 0) continue;
      values[excelHeader] = matches.length === 1
        ? String(matches[0].value)
        : matches.map(m => String(m.value)).join('; ');
    }
    if (Object.keys(values).length === 0) continue;

    // Resolve target row via the row-key header when possible.
    let targetRow0 = nextAppendRow;
    if (rowKeyHeader && rowKeyFieldKey && rowKeyColIdx >= 0) {
      const keyHit = sessRows.find(r => r.field === rowKeyFieldKey && r.value);
      if (keyHit?.value) {
        const needle = String(keyHit.value).trim().toLowerCase();
        const idx = source.rows.findIndex(r => (r[rowKeyColIdx] ?? '').trim().toLowerCase() === needle);
        if (idx >= 0) targetRow0 = idx;
      }
    }

    writeValuesToWorkbook({ source, rowIndex0: targetRow0, values });
    if (targetRow0 === nextAppendRow) nextAppendRow++;
  }

  const blob = workbookToBlob(source.workbook);
  const baseName = source.sheetName.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'filled';
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  downloadBlob(blob, `${baseName}_filled_${stamp}.xlsx`);
}
