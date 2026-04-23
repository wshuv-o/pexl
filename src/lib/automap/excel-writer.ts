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

// Parse a raw string against the destination cell's type / number-format so
// dates stay dates and numbers stay numbers. Returns the fields the caller
// should assign to the cell object. Falls back to string.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function coerceForCell(raw: string, prevCell: any): { t: string; v: number | string | Date; z?: string } {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return { t: 's', v: '' };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prevStyle: any = prevCell?.s ?? {};
  const prevNumFmt: string | undefined = prevStyle.numFmt ?? prevCell?.z;
  const fmt = (prevNumFmt ?? '').toLowerCase();
  const looksLikeDateFormat = /[ymdhs]/.test(fmt);

  if (prevCell?.t === 'd' || looksLikeDateFormat) {
    const parsed = new Date(trimmed);
    if (!isNaN(parsed.getTime())) {
      return { t: 'd', v: parsed, z: prevNumFmt || 'mm/dd/yyyy' };
    }
  }

  if (prevCell?.t === 'n' || /^[-$]?\d[\d,]*(\.\d+)?%?$/.test(trimmed)) {
    const cleaned = trimmed.replace(/[$,\s]/g, '').replace(/%$/, '');
    const n = Number(cleaned);
    if (!isNaN(n) && isFinite(n)) {
      return { t: 'n', v: n, z: prevNumFmt };
    }
  }

  return { t: 's', v: trimmed };
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
    const { t, v, z } = coerceForCell(values[h] ?? '', prev);
    const next: Record<string, unknown> = {
      ...prev,                  // keep s (style), l (hyperlink), comments
      t,
      v,
    };
    if (z) next.z = z;          // preserve or apply number format
    // Drop stale cached formula / formatted-text so Excel recomputes from
    // the new value + number format.
    delete next.f;
    delete next.F;
    delete next.w;
    sheet[addr] = next;
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
