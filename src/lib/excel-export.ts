/* eslint-disable @typescript-eslint/no-explicit-any */
import * as XLSX from 'xlsx';
import type { ExtractedRow } from '@/types/utilscraper';
import { getFieldLabelsForType, DOCUMENT_TYPES, type DocumentType } from '@/types/utilscraper';

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------
const C = {
  whiteBg:     'FFFFFF',
  borderColor: '8EA9C1',
};

// Header colors per document type
const HEADER_COLORS: Record<DocumentType, { bg: string; font: string }> = {
  utility_bill:   { bg: '16a34a', font: 'FFFFFF' },  // green
  bank_statement: { bg: '2563eb', font: 'FFFFFF' },  // blue
  appraisal:      { bg: '9333ea', font: 'FFFFFF' },  // purple
  lease_contract: { bg: 'd97706', font: 'FFFFFF' },  // orange
};

function hdr(bg: string, font: string, bold = true, sz = 10): any {
  return {
    font:      { bold, color: { rgb: font }, sz },
    fill:      { fgColor: { rgb: bg } },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    border:    thinBorder(),
  };
}

function cell(bg: string, bold = false, align: 'left' | 'center' | 'right' = 'left', sz = 9): any {
  return {
    font:      { bold, color: { rgb: '000000' }, sz },
    fill:      { fgColor: { rgb: bg } },
    alignment: { horizontal: align, vertical: 'center', wrapText: true },
    border:    thinBorder(),
  };
}

function thinBorder(): any {
  const s = { style: 'thin', color: { rgb: C.borderColor } };
  return { top: s, bottom: s, left: s, right: s };
}

function applyStyles(
  ws: XLSX.WorkSheet,
  wsData: any[][],
  styles: { row: number; col: number; style: any }[],
) {
  for (const { row, col, style } of styles) {
    const ref = XLSX.utils.encode_cell({ r: row, c: col });
    if (!ws[ref]) ws[ref] = { t: 's', v: wsData[row]?.[col] ?? '' };
    ws[ref].s = style;
  }
}

// ---------------------------------------------------------------------------
// Parse a numeric value from an extracted string (strips $, commas, etc.)
// Returns NaN if the string isn't a number.
// ---------------------------------------------------------------------------
function parseNumericValue(val: string): number {
  const cleaned = val.replace(/[$,\s]/g, '').trim();
  if (!cleaned) return NaN;
  const n = Number(cleaned);
  return n;
}

// ---------------------------------------------------------------------------
// Detect document type from the fields present in a set of rows
// ---------------------------------------------------------------------------
function detectDocType(rows: ExtractedRow[]): DocumentType {
  const fieldToType: Record<string, DocumentType> = {};
  for (const dt of DOCUMENT_TYPES) {
    for (const f of getFieldLabelsForType(dt.value)) {
      if (f.value !== 'custom') fieldToType[f.value] = dt.value;
    }
  }
  const typeCounts: Record<string, number> = {};
  for (const row of rows) {
    const dt = fieldToType[row.field];
    if (dt) typeCounts[dt] = (typeCounts[dt] || 0) + 1;
  }
  const detected = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] as DocumentType | undefined;
  return detected || 'utility_bill';
}

// ---------------------------------------------------------------------------
// Sanitize sheet name (XLSX: max 31 chars, no []:*?/\ characters)
// ---------------------------------------------------------------------------
function sanitizeSheetName(name: string, index: number, usedNames: Set<string>): string {
  let clean = name
    .replace(/\.pdf$/i, '')
    .replace(/[[\]:*?/\\]/g, '-')
    .trim();
  if (clean.length > 28) clean = clean.slice(0, 28);
  if (!clean) clean = `Sheet`;

  // Ensure uniqueness
  let final = clean;
  let counter = 2;
  while (usedNames.has(final)) {
    final = `${clean.slice(0, 27)}_${counter++}`;
  }
  usedNames.add(final);
  return final;
}

// ---------------------------------------------------------------------------
// Build a sheet for a single PDF file
//
// Layout:
//   Row 0 (header): field1 label | field2 label | ...
//   Row 1:          value        | value        | ...
//
// Same-label fields with numeric values are SUMMED.
// Same-label fields with non-numeric values are joined with " | ".
// ---------------------------------------------------------------------------
function buildSheetForFile(
  rows: ExtractedRow[],
  docType: DocumentType,
): XLSX.WorkSheet {
  const headerColor = HEADER_COLORS[docType];

  // Get field columns for this doc type (exclude 'custom')
  const fieldDefs = getFieldLabelsForType(docType).filter(f => f.value !== 'custom');

  // Collect any custom field names used in the data
  const knownFields = new Set(fieldDefs.map(f => f.value as string));
  const customFields: string[] = [];
  for (const row of rows) {
    if (!knownFields.has(row.field) && !customFields.includes(row.field)) {
      customFields.push(row.field);
    }
  }

  // All column keys: known fields + custom fields
  const allColumns = [
    ...fieldDefs.map(f => ({ key: f.value, label: f.label })),
    ...customFields.map(f => ({ key: f, label: f })),
  ];

  // Build field → values map, summing numeric values
  const valMap: Record<string, string> = {};
  const numAccum: Record<string, number> = {};
  const numCount: Record<string, number> = {};
  const strAccum: Record<string, string[]> = {};

  for (const row of rows) {
    if (!row.value) continue;
    const num = parseNumericValue(row.value);
    if (!isNaN(num)) {
      numAccum[row.field] = (numAccum[row.field] || 0) + num;
      numCount[row.field] = (numCount[row.field] || 0) + 1;
    } else {
      if (!strAccum[row.field]) strAccum[row.field] = [];
      if (!strAccum[row.field].includes(row.value)) {
        strAccum[row.field].push(row.value);
      }
    }
  }

  // Merge: numeric fields get formatted sum, string fields get joined
  for (const col of allColumns) {
    const hasNum = numCount[col.key] > 0;
    const hasStr = strAccum[col.key]?.length > 0;

    if (hasNum && !hasStr) {
      // Pure numeric — show sum. Format with 2 decimal places if has decimals
      const sum = numAccum[col.key];
      valMap[col.key] = sum % 1 === 0 ? String(sum) : sum.toFixed(2);
    } else if (hasStr && !hasNum) {
      // Pure string — join unique values
      valMap[col.key] = strAccum[col.key].join(' | ');
    } else if (hasNum && hasStr) {
      // Mixed — show sum + strings
      const sum = numAccum[col.key];
      const sumStr = sum % 1 === 0 ? String(sum) : sum.toFixed(2);
      valMap[col.key] = [sumStr, ...strAccum[col.key]].join(' | ');
    }
  }

  const wsData: any[][] = [];
  const styles: { row: number; col: number; style: any }[] = [];
  let ri = 0;
  const push = (cells: any[]) => { wsData.push(cells); return ri++; };
  const sc = (r: number, c: number, s: any) => styles.push({ row: r, col: c, style: s });

  // Header row
  const headerCells = allColumns.map(c => c.label);
  const r0 = push(headerCells);
  for (let c = 0; c < headerCells.length; c++) {
    sc(r0, c, hdr(headerColor.bg, headerColor.font));
  }

  // Single data row with values
  const rowCells = allColumns.map(col => valMap[col.key] || '');
  const r1 = push(rowCells);
  for (let c = 0; c < rowCells.length; c++) {
    sc(r1, c, cell(C.whiteBg, false, 'left', 9));
  }

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  applyStyles(ws, wsData, styles);
  ws['!cols'] = allColumns.map(() => ({ wch: 22 }));
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  return ws;
}

// ---------------------------------------------------------------------------
// Main export — one sheet per PDF, named after the file
// ---------------------------------------------------------------------------
export function exportToExcel(
  data: ExtractedRow[],
  _filename: string,
  provider: string,
) {
  const now     = new Date();
  const dateStr = now.toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const wb      = XLSX.utils.book_new();

  // Group data by filename
  const fileMap = new Map<string, ExtractedRow[]>();
  for (const row of data) {
    const key = row.filename || 'Unknown';
    if (!fileMap.has(key)) fileMap.set(key, []);
    fileMap.get(key)!.push(row);
  }

  const usedNames = new Set<string>();
  let sheetIndex = 0;

  for (const [filename, rows] of fileMap.entries()) {
    const docType   = detectDocType(rows);
    const sheetName = sanitizeSheetName(filename, sheetIndex++, usedNames);
    const ws        = buildSheetForFile(rows, docType);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  if (fileMap.size === 0) {
    // Fallback: empty workbook shouldn't happen, but just in case
    const ws = XLSX.utils.aoa_to_sheet([['No data extracted']]);
    XLSX.utils.book_append_sheet(wb, ws, 'Empty');
  }

  XLSX.writeFile(wb, `Pexl_${provider.replace(/\s+/g, '')}_${dateStr}.xlsx`);
}
