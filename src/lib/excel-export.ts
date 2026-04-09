/* eslint-disable @typescript-eslint/no-explicit-any */
import * as XLSX from 'xlsx-js-style';
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
  utility_bill:   { bg: '1F7D3A', font: 'FFFFFF' },  // dark green
  bank_statement: { bg: '1F497D', font: 'FFFFFF' },  // dark navy blue
  appraisal:      { bg: '4B1F7D', font: 'FFFFFF' },  // dark purple
  lease_contract: { bg: '7D4B1F', font: 'FFFFFF' },  // dark orange/brown
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
function sanitizeSheetName(name: string, usedNames: Set<string>): string {
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
    sc(r, 0, cell(C.whiteBg, true, 'center', 9));
    for (let c = 1; c < rowCells.length; c++) {
      sc(r, c, cell(C.whiteBg, false, 'left', 9));
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  applyStyles(ws, wsData, styles);
  ws['!cols'] = [{ wch: 8 }, ...allColumns.map(() => ({ wch: 22 }))];
  ws['!freeze'] = { xSplit: 1, ySplit: 1 };
  return ws;
}

// ---------------------------------------------------------------------------
// Build a flat per-file value map from extracted rows.
// Returns a single { fieldName: stringValue } map per file.
// ---------------------------------------------------------------------------
function flattenFileRows(rows: ExtractedRow[]): Record<string, string> {
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

  const allKeys = new Set([...Object.keys(numCount), ...Object.keys(strAccum)]);
  for (const key of allKeys) {
    const hasNum = numCount[key] > 0;
    const hasStr = strAccum[key]?.length > 0;
    if (hasNum && !hasStr) {
      const sum = numAccum[key];
      valMap[key] = sum % 1 === 0 ? String(sum) : sum.toFixed(2);
    } else if (hasStr && !hasNum) {
      valMap[key] = strAccum[key].join(' | ');
    } else if (hasNum && hasStr) {
      const sum = numAccum[key];
      const sumStr = sum % 1 === 0 ? String(sum) : sum.toFixed(2);
      valMap[key] = [sumStr, ...strAccum[key]].join(' | ');
    }
  }
  return valMap;
}

// ---------------------------------------------------------------------------
// Build the bank statement sheet — matches the screenshot layout:
//
//   Row 0: Property Name | <propName> | Account: <num>          (light blue)
//   Row 1: Date | Deposits | Withdrawals | Unadj Bal | Adj Bal |
//          Adjustments | Actual Deposits | T-12 |
//          Deposits vs. Op Stmt. Diff. | Comments               (dark blue header)
//   Row 2+: One row per PDF
//   Total row | Average row
//
// No formulas — just placed values from the extraction.
// ---------------------------------------------------------------------------
// Bank statement column headers (shared by all groups)
const BANK_STMT_COLS = [
  'Date',
  'Deposits',
  'Withdrawals',
  'Unadjusted Balance',
  'Adjusted Balance',
  'Adjustments',
  'Actual Deposits',
  'T-12',
  'Deposits vs. Op Stmt. Diff.',
  'Comments',
];

// Group key — files with the same property + account go in the same table
function groupKey(map: Record<string, string>): string {
  const prop = (map.property_name || '').trim().toLowerCase();
  const acct = (map.account_number || '').trim().toLowerCase();
  return `${prop}|||${acct}`;
}

interface BankFileEntry {
  name: string;
  map: Record<string, string>;                                          // merged across pages (for property/account + grouping)
  pages: Array<{ page: number; multi: Record<string, string[]> }>;       // per-page multi-value maps
}

// Build pages for a file: group rows by page number, keeping all values per field.
// Preserves first-appearance order so caller-side sorting carries through.
function buildFilePages(rows: ExtractedRow[]): Array<{ page: number; multi: Record<string, string[]> }> {
  const byPage = new Map<number, Record<string, string[]>>();
  const order: number[] = [];
  for (const row of rows) {
    if (!row.value) continue;
    if (!byPage.has(row.page)) {
      byPage.set(row.page, {});
      order.push(row.page);
    }
    const pageMap = byPage.get(row.page)!;
    if (!pageMap[row.field]) pageMap[row.field] = [];
    pageMap[row.field].push(row.value);
  }
  return order.map(page => ({ page, multi: byPage.get(page)! }));
}

// Append one property/account block (header + data + total + average) into wsData.
// Returns the next available row index after the block.
function appendBankStatementGroup(
  wsData: any[][],
  styles: { row: number; col: number; style: any }[],
  startRow: number,
  files: BankFileEntry[],
): number {
  const headerColor = HEADER_COLORS.bank_statement;
  const propBlueBg  = 'D6E4F0';
  const totalRowBg  = 'EEF2F7';
  const NUM_COLS    = BANK_STMT_COLS.length;

  let ri = startRow;
  const push = (cells: any[]) => {
    while (wsData.length <= ri) wsData.push([]);
    wsData[ri] = cells;
    return ri++;
  };
  const sc = (r: number, c: number, s: any) => styles.push({ row: r, col: c, style: s });

  // Property/account meta from the first file in this group
  const firstWithMeta = files.find(f => f.map.property_name || f.map.account_number) ?? files[0];
  const propertyName  = firstWithMeta?.map.property_name  || '';
  const accountNumber = firstWithMeta?.map.account_number || '';

  const parseNum = (s: string) => {
    const n = parseFloat(s.replace(/[$,\s]/g, ''));
    return isNaN(n) ? null : n;
  };
  const fmtMoney = (n: number) =>
    `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // Preserve caller order (so ExcelPanel sorting carries through to export)
  const sorted = files;

  // ── Row 0: Property header ──────────────────────────────────────────────
  const propRow: any[] = [
    'Property Name',
    propertyName,
    accountNumber ? `Account: ${accountNumber}` : '',
    '', '', '', '', '', '', '',
  ];
  const r0 = push(propRow);
  for (let c = 0; c < NUM_COLS; c++) {
    sc(r0, c, cell(propBlueBg, true, 'left', 10));
  }

  // ── Row 1: Dark blue column headers ─────────────────────────────────────
  const r1 = push(BANK_STMT_COLS);
  for (let c = 0; c < NUM_COLS; c++) {
    sc(r1, c, hdr(headerColor.bg, headerColor.font));
  }

  // ── Data rows — one per (file, page) ────────────────────────────────────
  let totalDeposits = 0;
  let totalWithdrawals = 0;
  let totalActualDeposits = 0;
  let depositCount = 0;
  let actualDepositCount = 0;

  const fmtVal = (s: string) => {
    const n = parseNum(s);
    return n !== null ? fmtMoney(n) : s;
  };

  for (const file of sorted) {
    const pages = file.pages.length > 0
      ? file.pages
      : [{ page: 1, multi: {} as Record<string, string[]> }];

    for (const { multi } of pages) {
      // One row per page — first value if multi, fall back to file-level map.
      const getField = (key: string): string => {
        const arr = multi[key];
        if (arr && arr.length > 0) return arr[0];
        return file.map[key] || '';
      };

      const date        = getField('statement_date');
      const depositsStr = getField('total_credits');
      const withdrawStr = getField('total_debits');
      const endingBal   = getField('ending_balance');

      const dn = parseNum(depositsStr);
      const wn = parseNum(withdrawStr);
      if (dn !== null) { totalDeposits += dn; depositCount++; totalActualDeposits += dn; actualDepositCount++; }
      if (wn !== null) { totalWithdrawals += wn; }

      const row: any[] = [
        date,
        depositsStr ? fmtVal(depositsStr) : '',
        withdrawStr ? fmtVal(withdrawStr) : '',
        endingBal   ? fmtVal(endingBal)   : '',
        endingBal   ? fmtVal(endingBal)   : '',
        '',
        depositsStr ? fmtVal(depositsStr) : '',
        '', '', '',
      ];
      const r = push(row);
      for (let c = 0; c < NUM_COLS; c++) {
        sc(r, c, cell(C.whiteBg, false, c === 0 ? 'left' : 'right', 9));
      }
    }
  }

  // ── Total row ───────────────────────────────────────────────────────────
  const totalRow: any[] = [
    'Total',
    fmtMoney(totalDeposits),
    fmtMoney(totalWithdrawals),
    '', '', '',
    fmtMoney(totalActualDeposits),
    '', '', '',
  ];
  const tr = push(totalRow);
  for (let c = 0; c < NUM_COLS; c++) {
    sc(tr, c, cell(totalRowBg, true, c === 0 ? 'left' : 'right', 9));
  }

  // ── Average row ─────────────────────────────────────────────────────────
  const avgDeposits       = depositCount > 0       ? totalDeposits / depositCount             : 0;
  const avgActualDeposits = actualDepositCount > 0 ? totalActualDeposits / actualDepositCount : 0;
  const avgRow: any[] = [
    'Average',
    depositCount > 0       ? fmtMoney(avgDeposits)       : '',
    '',
    '', '', '',
    actualDepositCount > 0 ? fmtMoney(avgActualDeposits) : '',
    '', '', '',
  ];
  const ar = push(avgRow);
  for (let c = 0; c < NUM_COLS; c++) {
    sc(ar, c, cell(totalRowBg, true, c === 0 ? 'left' : 'right', 9));
  }

  return ri;
}

function buildBankStatementSheet(
  fileMap: Map<string, ExtractedRow[]>,
): XLSX.WorkSheet {
  const NUM_COLS = BANK_STMT_COLS.length;

  // Flatten + group by property/account
  const groups = new Map<string, BankFileEntry[]>();
  for (const [name, rows] of fileMap.entries()) {
    const entry: BankFileEntry = {
      name,
      map: flattenFileRows(rows),
      pages: buildFilePages(rows),
    };
    const key = groupKey(entry.map);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(entry);
  }

  const wsData: any[][] = [];
  const styles: { row: number; col: number; style: any }[] = [];
  let nextRow = 0;

  let first = true;
  for (const files of groups.values()) {
    if (!first) {
      // Three blank separator rows between tables
      wsData.push([]);
      wsData.push([]);
      wsData.push([]);
      nextRow += 3;
    }
    nextRow = appendBankStatementGroup(wsData, styles, nextRow, files);
    first = false;
  }

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  applyStyles(ws, wsData, styles);
  ws['!cols'] = [
    { wch: 14 },  // Date
    { wch: 18 },  // Deposits
    { wch: 18 },  // Withdrawals
    { wch: 20 },  // Unadj Bal
    { wch: 20 },  // Adj Bal
    { wch: 14 },  // Adjustments
    { wch: 18 },  // Actual Deposits
    { wch: 12 },  // T-12
    { wch: 26 },  // Deposits vs. Op Stmt. Diff
    { wch: 16 },  // Comments
  ];
  // Suppress unused-var warning for NUM_COLS in case future edits use it
  void NUM_COLS;
  return ws;
}

// ---------------------------------------------------------------------------
// Build a stacked-tables sheet — one table per PDF on a single sheet.
// Used for appraisal and lease contract exports.
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

    const cleanName = filename.replace(/\.pdf$/i, '');

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
      sc(r, 0, cell(C.whiteBg, true, 'left',   9));
      sc(r, 1, cell(C.whiteBg, true, 'center', 9));
      for (let c = 2; c < totalCols; c++) {
        sc(r, c, cell(C.whiteBg, false, 'left', 9));
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
//   - appraisal      → single sheet, one table per PDF stacked vertically
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
    // Combined single-sheet layout
    const ws = buildBankStatementSheet(fileMap);
    XLSX.utils.book_append_sheet(wb, ws, 'Bank Statements');
  } else if (overallType === 'appraisal') {
    // One sheet, one table per PDF stacked vertically
    const ws = buildStackedTablesSheet(fileMap, 'appraisal', 'E5D6F0'); // light purple
    XLSX.utils.book_append_sheet(wb, ws, 'Appraisals');
  } else if (overallType === 'lease_contract') {
    // One sheet, one table per PDF stacked vertically
    const ws = buildStackedTablesSheet(fileMap, 'lease_contract', 'F5E0C5'); // light orange
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
