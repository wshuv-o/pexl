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
  headers: string[];          // row 1, trimmed
  headerRow: number;          // 0-based row index of the header row (usually 0)
  rows: Record<string, string>[]; // data rows after the header
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

  let headerRow = 0;
  while (headerRow < aoa.length && (!aoa[headerRow] || aoa[headerRow].every(c => c === '' || c == null))) {
    headerRow++;
  }

  const headers = (aoa[headerRow] ?? []).map(h => String(h ?? '').trim());
  const rows: Record<string, string>[] = [];
  for (let r = headerRow + 1; r < aoa.length; r++) {
    const row = aoa[r] ?? [];
    const entry: Record<string, string> = {};
    headers.forEach((h, i) => { entry[h] = String(row[i] ?? ''); });
    rows.push(entry);
  }

  return { workbook, sheetName, headers, headerRow, rows };
};
