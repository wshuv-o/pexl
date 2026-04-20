import * as XLSX from 'xlsx-js-style';
import type { SourceExcel } from './excel-reader';

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
