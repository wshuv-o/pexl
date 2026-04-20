/* eslint-disable @typescript-eslint/no-explicit-any */
import * as XLSX from 'xlsx-js-style';
import type { ExtractedRow } from '@/types/utilscraper';
import { getFieldLabelsForType, DOCUMENT_TYPES, type DocumentType } from '@/types/utilscraper';
import { downloadBankStatementExcel } from './bank-excel-export';

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------
const C = {
  whiteBg:     'FFFFFF',
  borderColor: '8EA9C1',
};

// Header colors per document type
const HEADER_COLORS: Record<DocumentType, { bg: string; font: string }> = {
  utility_bill:   { bg: '1F7D3A', font: 'FFFFFF' },  // dark green
  bank_statement: { bg: '1F497D', font: 'FFFFFF' },  // dark navy blue
  appraisal:      { bg: '4B1F7D', font: 'FFFFFF' },  // dark purple
  lease_contract: { bg: '7D4B1F', font: 'FFFFFF' },  // dark orange/brown
};

function hdr(bg: string, font: string, bold = true, sz = 10): any {
  return {
    font:      { name: 'Arial', bold, color: { rgb: font }, sz },
    fill:      { fgColor: { rgb: bg } },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    border:    thinBorder(),
  };
}

function cell(bg: string, bold = false, align: 'left' | 'center' | 'right' = 'left', sz = 10): any {
  return {
    font:      { name: 'Arial', bold, color: { rgb: '000000' }, sz },
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
function sanitizeSheetName(name: string, usedNames: Set<string>): string {
  let clean = name
    .replace(/\.(pdf|docx?)$/i, '')
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
//   Row 0 (header): page | field1 | field2 | ...
//   Row 1+:         1    | value  | value  | ...   (one row per extracted page)
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

  const allColumns = [
    ...fieldDefs.map(f => ({ key: f.value, label: f.label })),
    ...customFields.map(f => ({ key: f, label: f })),
  ];

  // Group rows by page, keeping ALL values per field (no merging)
  // Preserve first-appearance order so caller-side sorting carries through.
  const byPage = new Map<number, Record<string, string[]>>();
  const pageOrder: number[] = [];
  for (const row of rows) {
    if (!row.value) continue;
    if (!byPage.has(row.page)) {
      byPage.set(row.page, {});
      pageOrder.push(row.page);
    }
    const pageMap = byPage.get(row.page)!;
    if (!pageMap[row.field]) pageMap[row.field] = [];
    pageMap[row.field].push(row.value);
  }

  const sortedPages = pageOrder;

  const wsData: any[][] = [];
  const styles: { row: number; col: number; style: any }[] = [];
  let ri = 0;
  const push = (cells: any[]) => { wsData.push(cells); return ri++; };
  const sc = (r: number, c: number, s: any) => styles.push({ row: r, col: c, style: s });

  // Header row: page | field keys
  const headerCells = ['page', ...allColumns.map(c => c.key)];
  const r0 = push(headerCells);
  for (let c = 0; c < headerCells.length; c++) {
    sc(r0, c, hdr(headerColor.bg, headerColor.font));
  }

  // One row per page (first value used if a field has multiple values)
  for (const page of sortedPages) {
    const pageMap = byPage.get(page)!;
    const rowCells: any[] = [
      page,
      ...allColumns.map(col => {
        const arr = pageMap[col.key] ?? [];
        return arr.length > 0 ? arr[0] : '';
      }),
    ];
    const r = push(rowCells);
    sc(r, 0, cell(C.whiteBg, true, 'center', 10));
    for (let c = 1; c < rowCells.length; c++) {
      sc(r, c, cell(C.whiteBg, false, 'left', 10));
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  applyStyles(ws, wsData, styles);
  ws['!cols'] = [{ wch: 8 }, ...allColumns.map(() => ({ wch: 22 }))];
  ws['!freeze'] = { xSplit: 1, ySplit: 1 };
  return ws;
}

// (Bank statement export now lives in bank-excel-export.ts using ExcelJS,
//  with formulas, T-12 trailing metrics, gap-fill, and roll-up sheets.)

// ---------------------------------------------------------------------------
// Lease contract sheet — fixed 10-column "Lease" template on the right side
// of the sheet. One row per PDF. Any non-template fields (custom labels or
// the older `rent_and_charges`/concession/discount keys) are inserted to the
// LEFT of the core columns, preserving the template on the right.
//
//   file_name │ [extras…] │ Contract Date │ Executed? │ Tenant Name(s) │
//   Utilities included in Rent │ Lease Start │ Lease End │ Lease Term* │
//   Security Deposit │ Monthly Rent │ Lease Value*
//
//   *Lease Term  = (Lease End − Lease Start) / 365.25
//   *Lease Value = Monthly Rent × Lease Term × 12
// ---------------------------------------------------------------------------
function buildLeaseSheet(fileMap: Map<string, ExtractedRow[]>): XLSX.WorkSheet {
  const docType: DocumentType = 'lease_contract';
  const headerColor = HEADER_COLORS[docType];

  const parseMoney = (s: string): number | null => {
    const n = parseFloat(s.replace(/[$,\s]/g, ''));
    return isNaN(n) ? null : n;
  };

  type CoreKey =
    | 'lease_date' | 'executed' | 'parties' | 'utilities_included'
    | 'lease_begin_date' | 'lease_end_date' | 'lease_term'
    | 'security_deposit' | 'monthly_rent' | 'lease_value';

  interface CoreCol {
    key: CoreKey;
    field: string | null;   // ExtractedRow.field value (null = computed column)
    label: string;
    width: number;
    type?: 'checkbox' | 'money';
    formula?: (row1: number, L: Record<CoreKey, string>) => string;
  }

  const core: CoreCol[] = [
    { key: 'lease_date',         field: 'lease_date',         label: 'Contract Date', width: 13 },
    { key: 'executed',           field: 'executed',           label: 'Executed?', width: 10, type: 'checkbox' },
    { key: 'parties',            field: 'parties',            label: 'Tenant Name(s)', width: 20 },
    { key: 'utilities_included', field: 'utilities_included', label: 'Utilities included in Rent', width: 24 },
    { key: 'lease_begin_date',   field: 'lease_begin_date',   label: 'Lease Start', width: 12 },
    { key: 'lease_end_date',     field: 'lease_end_date',     label: 'Lease End', width: 12 },
    { key: 'lease_term', field: null, label: 'Lease Term', width: 10,
      formula: (r, L) => `IFERROR((DATEVALUE(${L.lease_end_date}${r})-DATEVALUE(${L.lease_begin_date}${r}))/365.25,0)` },
    { key: 'security_deposit',   field: 'security_deposit',   label: 'Security Deposit', width: 15, type: 'money' },
    { key: 'monthly_rent',       field: 'monthly_rent',       label: 'Monthly Rent', width: 13, type: 'money' },
    { key: 'lease_value', field: null, label: 'Lease Value', width: 14,
      formula: (r, L) => `IFERROR(${L.monthly_rent}${r}*${L.lease_term}${r}*12,0)` },
  ];

  // Any field key not in `core` is treated as an "extra" and goes left of the template.
  const coreFields = new Set(core.map(c => c.field).filter((f): f is string => !!f));
  const extras = new Set<string>();
  for (const rows of fileMap.values()) {
    for (const row of rows) if (!coreFields.has(row.field)) extras.add(row.field);
  }
  const extraFields = Array.from(extras);

  const startExtraIdx = 1;
  const startCoreIdx  = startExtraIdx + extraFields.length;
  const totalCols     = startCoreIdx + core.length;

  // Column letter for each core key, for formula references.
  const L = {} as Record<CoreKey, string>;
  core.forEach((c, i) => { L[c.key] = XLSX.utils.encode_col(startCoreIdx + i); });

  const wsData: any[][] = [];
  const styles: { row: number; col: number; style: any }[] = [];
  const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = [];
  let ri = 0;
  const push = (cells: any[]) => { wsData.push(cells); return ri++; };
  const sc   = (r: number, c: number, s: any) => styles.push({ row: r, col: c, style: s });

  // Row 0 — "Lease" title merged over the core columns.
  const titleRow = Array(totalCols).fill('');
  titleRow[startCoreIdx] = 'Lease';
  const titleR = push(titleRow);
  merges.push({ s: { r: titleR, c: startCoreIdx }, e: { r: titleR, c: totalCols - 1 } });
  sc(titleR, startCoreIdx, hdr(headerColor.bg, headerColor.font, true, 11));
  for (let c = 0; c < startCoreIdx; c++) sc(titleR, c, cell(C.whiteBg, false, 'left', 10));

  // Row 1 — column headers.
  const headerCells = [
    'file_name',
    ...extraFields,
    ...core.map(c => c.label),
  ];
  const hr = push(headerCells);
  for (let c = 0; c < totalCols; c++) sc(hr, c, hdr(headerColor.bg, headerColor.font));

  // One data row per PDF.
  for (const [filename, rows] of fileMap.entries()) {
    const values: Record<string, string> = {};
    for (const row of rows) {
      if (!row.value) continue;
      if (values[row.field]) continue; // first-wins
      values[row.field] = row.value;
    }

    const row1 = ri + 1;
    const rowCells: any[] = [
      filename.replace(/\.(pdf|docx?)$/i, ''),
      ...extraFields.map(k => values[k] ?? ''),
    ];

    for (const col of core) {
      if (col.formula) {
        rowCells.push({ t: 'n', v: 0, f: col.formula(row1, L) });
      } else if (col.type === 'checkbox') {
        const raw = (col.field ? values[col.field] : '') ?? '';
        const checked = /^(y|yes|true|executed|signed|checked|x|✓|☒|☑|1)$/i.test(raw.trim());
        rowCells.push(checked ? '☒' : '☐');
      } else if (col.type === 'money') {
        const raw = col.field ? values[col.field] : '';
        const n = raw ? parseMoney(raw) : null;
        if (n !== null) rowCells.push({ t: 'n', v: n, z: '"$"#,##0.00' });
        else rowCells.push(raw ?? '');
      } else {
        rowCells.push(col.field ? values[col.field] ?? '' : '');
      }
    }

    const r = push(rowCells);
    sc(r, 0, cell(C.whiteBg, true, 'left', 10));
    for (let c = startExtraIdx; c < startCoreIdx; c++) sc(r, c, cell(C.whiteBg, false, 'left', 10));
    core.forEach((col, i) => {
      const align: 'left' | 'center' | 'right' =
        col.type === 'checkbox' ? 'center' :
        col.type === 'money' || col.formula ? 'right' : 'left';
      sc(r, startCoreIdx + i, cell(C.whiteBg, false, align, col.type === 'checkbox' ? 12 : 10));
    });
  }

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  applyStyles(ws, wsData, styles);
  if (merges.length > 0) ws['!merges'] = merges;
  ws['!cols'] = [
    { wch: 30 },
    ...extraFields.map(() => ({ wch: 18 })),
    ...core.map(c => ({ wch: c.width })),
  ];
  ws['!freeze'] = { xSplit: 1, ySplit: 2 };
  return ws;
}

// ---------------------------------------------------------------------------
// Build a stacked-tables sheet — one table per PDF on a single sheet.
// Used for appraisal exports.
// ---------------------------------------------------------------------------
function buildStackedTablesSheet(
  fileMap: Map<string, ExtractedRow[]>,
  docType: DocumentType,
  fileLabelBg: string,
): XLSX.WorkSheet {
  const headerColor = HEADER_COLORS[docType];

  // Field columns for this doc type (excluding 'custom')
  const fieldDefs = getFieldLabelsForType(docType).filter(f => f.value !== 'custom');

  // Collect any custom fields used across all files
  const knownFields = new Set(fieldDefs.map(f => f.value as string));
  const customFields: string[] = [];
  for (const rows of fileMap.values()) {
    for (const row of rows) {
      if (!knownFields.has(row.field) && !customFields.includes(row.field)) {
        customFields.push(row.field);
      }
    }
  }

  const allColumns = [
    ...fieldDefs.map(f => ({ key: f.value, label: f.label })),
    ...customFields.map(f => ({ key: f, label: f })),
  ];

  const wsData: any[][] = [];
  const styles: { row: number; col: number; style: any }[] = [];
  let ri = 0;
  const push = (cells: any[]) => { wsData.push(cells); return ri++; };
  const sc = (r: number, c: number, s: any) => styles.push({ row: r, col: c, style: s });

  const totalCols = 2 + allColumns.length; // file_name + page + fields

  let first = true;
  for (const [filename, rows] of fileMap.entries()) {
    if (!first) {
      // Three blank separator rows between tables
      wsData.push([]);
      wsData.push([]);
      wsData.push([]);
      ri += 3;
    }
    first = false;

    const cleanName = filename.replace(/\.(pdf|docx?)$/i, '');

    // ── File header row (light tinted color) ──────────────────────────────
    const fileRow = [`File: ${cleanName}`, ...Array(totalCols - 1).fill('')];
    const fr = push(fileRow);
    for (let c = 0; c < totalCols; c++) {
      sc(fr, c, cell(fileLabelBg, true, 'left', 10));
    }

    // ── Column header row (dark colored) ──────────────────────────────────
    const headerCells = ['file_name', 'page', ...allColumns.map(c => c.key)];
    const hr = push(headerCells);
    for (let c = 0; c < totalCols; c++) {
      sc(hr, c, hdr(headerColor.bg, headerColor.font));
    }

    // ── Group rows by page (preserving first-appearance order) ────────────
    const byPage = new Map<number, Record<string, string[]>>();
    const pageOrder: number[] = [];
    for (const row of rows) {
      if (!row.value) continue;
      if (!byPage.has(row.page)) {
        byPage.set(row.page, {});
        pageOrder.push(row.page);
      }
      const pageMap = byPage.get(row.page)!;
      if (!pageMap[row.field]) pageMap[row.field] = [];
      pageMap[row.field].push(row.value);
    }

    // ── Data rows: one per page ───────────────────────────────────────────
    for (const page of pageOrder) {
      const pageMap = byPage.get(page)!;
      const rowCells: any[] = [
        cleanName,
        page,
        ...allColumns.map(col => {
          const arr = pageMap[col.key] ?? [];
          return arr.length > 0 ? arr[0] : '';
        }),
      ];
      const r = push(rowCells);
      sc(r, 0, cell(C.whiteBg, true, 'left',   10));
      sc(r, 1, cell(C.whiteBg, true, 'center', 10));
      for (let c = 2; c < totalCols; c++) {
        sc(r, c, cell(C.whiteBg, false, 'left', 10));
      }
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  applyStyles(ws, wsData, styles);
  ws['!cols'] = [{ wch: 30 }, { wch: 8 }, ...allColumns.map(() => ({ wch: 22 }))];
  return ws;
}

// ---------------------------------------------------------------------------
// Main export
//   - bank_statement → single combined sheet, file_name as first column
//   - appraisal      → stacked tables, one per PDF
//   - lease_contract → fixed "Lease" template (right-aligned), extras on left
//   - other types    → one sheet per PDF
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

  // Detect overall doc type from first file
  const allRows = Array.from(fileMap.values()).flat();
  const overallType = detectDocType(allRows);

  if (overallType === 'bank_statement') {
    // Bank statement uses the dedicated ExcelJS-based exporter with formulas,
    // running balance chain, T-12 trailing metrics, and roll-up sheet.
    // It downloads the workbook itself — early return.
    downloadBankStatementExcel(data, provider).catch(err => {
      console.error('Bank statement export failed:', err);
    });
    return;
  } else if (overallType === 'appraisal') {
    // One sheet, one table per PDF stacked vertically
    const ws = buildStackedTablesSheet(fileMap, 'appraisal', 'E5D6F0'); // light purple
    XLSX.utils.book_append_sheet(wb, ws, 'Appraisals');
  } else if (overallType === 'lease_contract') {
    // Fixed "Lease" template — 10 core columns on the right, extras on
    // the left, computed Lease Term / Lease Value columns.
    const ws = buildLeaseSheet(fileMap);
    XLSX.utils.book_append_sheet(wb, ws, 'Lease Contracts');
  } else {
    // Per-file sheets (utility)
    const usedNames = new Set<string>();
    for (const [filename, rows] of fileMap.entries()) {
      const docType   = detectDocType(rows);
      const sheetName = sanitizeSheetName(filename, usedNames);
      const ws        = buildSheetForFile(rows, docType);
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    }
  }

  if (fileMap.size === 0) {
    const ws = XLSX.utils.aoa_to_sheet([['No data extracted']]);
    XLSX.utils.book_append_sheet(wb, ws, 'Empty');
  }

  XLSX.writeFile(wb, `Pexl_${provider.replace(/\s+/g, '')}_${dateStr}.xlsx`);
}
