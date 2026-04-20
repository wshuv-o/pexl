/* eslint-disable @typescript-eslint/no-explicit-any */
import * as XLSX from 'xlsx-js-style';

// ───────────────────────────────────────────────────────────────────────────
// Read a user-uploaded source Excel. Returns headers + existing rows from the
// first sheet, plus the workbook object so the writer can rewrite it later
// without losing styles.
// ───────────────────────────────────────────────────────────────────────────
export interface SourceExcel {
  workbook: XLSX.WorkBook;
  sheetName: string;
  headers: string[];          // the visible header row, trimmed (hidden cols filtered)
  headerRow: number;          // 0-based row index of the header row
  sheetColumns: number[];     // for each entry in `headers`, the original 0-based
                              // column index in the source sheet — the writer uses
                              // this to put values back into the right cell even
                              // though hidden / empty columns have been skipped
  rows: string[][];           // data rows after the header — column-indexed so
                              // duplicate / empty headers don't collide
}

export const readSourceExcel = async (file: File): Promise<SourceExcel> => {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array', cellStyles: true });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // Grab raw rows as arrays so we can treat the first non-empty row as headers.
  const aoa = XLSX.utils.sheet_to_json<any[]>(sheet, {
    header: 1,
    defval: '',
    blankrows: false,
  });

  // Smart header-row detection: templates often have a merged title row
  // (or a few) above the actual header row. Scan the first 15 rows and
  // pick the one whose string-valued-cell count is the largest; ties go
  // to the earlier row. A row must have at least 2 string cells to be
  // eligible, so "319 data rows of numbers" doesn't out-vote a 10-header
  // label row.
  const countStringCells = (row: any[]) =>
    row.filter(v => typeof v === 'string' && v.trim() !== '').length;

  const scanLimit = Math.min(aoa.length, 15);
  let headerRow = 0;
  let bestScore = -1;
  for (let r = 0; r < scanLimit; r++) {
    const score = countStringCells(aoa[r] ?? []);
    if (score >= 2 && score > bestScore) {
      bestScore = score;
      headerRow = r;
    }
  }
  // Fallback: if we never saw a row with ≥2 string cells, just take the
  // first non-empty row (old behaviour).
  if (bestScore < 0) {
    while (headerRow < aoa.length && (!aoa[headerRow] || aoa[headerRow].every(c => c === '' || c == null))) {
      headerRow++;
    }
  }

  const rawHeaders = (aoa[headerRow] ?? []).map(h => String(h ?? '').trim());
  const rawColCount = rawHeaders.length;

  // ── Drop columns that the user hid in Excel, plus any columns where the
  // header is blank AND no data row has a value. Keeps the panel focused on
  // the actual working columns of the template.
  const cols = (sheet['!cols'] ?? []) as Array<{ hidden?: boolean } | undefined>;
  const keep: number[] = [];
  for (let c = 0; c < rawColCount; c++) {
    if (cols[c]?.hidden) continue;
    const hasHeader = rawHeaders[c] !== '';
    let hasData = false;
    if (!hasHeader) {
      for (let r = headerRow + 1; r < aoa.length; r++) {
        const v = aoa[r]?.[c];
        if (v !== '' && v != null) { hasData = true; break; }
      }
    }
    if (hasHeader || hasData) keep.push(c);
  }

  const headers = keep.map(c => rawHeaders[c]);
  const rows: string[][] = [];
  for (let r = headerRow + 1; r < aoa.length; r++) {
    const row = aoa[r] ?? [];
    rows.push(keep.map(c => String(row[c] ?? '')));
  }

  return { workbook, sheetName, headers, headerRow, sheetColumns: keep, rows };
};
