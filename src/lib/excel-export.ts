/* eslint-disable @typescript-eslint/no-explicit-any */
import * as XLSX from 'xlsx-js-style';
import type { ExtractedRow } from '@/types/utilscraper';
import { getFieldLabelsForType, DOCUMENT_TYPES, type DocumentType } from '@/types/utilscraper';
import { downloadBankStatementExcel } from './bank-excel-export';

const C = {
  whiteBg:     'FFFFFF',
  borderColor: '000000',
};

// Header colors per document type
const HEADER_COLORS: Record<DocumentType, { bg: string; font: string }> = {
  utility_bill:   { bg: '1F7D3A', font: 'FFFFFF' },  // dark green
  bank_statement: { bg: '1F497D', font: 'FFFFFF' },  // dark navy blue
  appraisal:      { bg: '4B1F7D', font: 'FFFFFF' },  // dark purple
  lease_contract: { bg: '7D4B1F', font: 'FFFFFF' },  // dark orange/brown
  tax:            { bg: '7D1F1F', font: 'FFFFFF' },  // dark red
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

// Lighter border for callout cells (Property / Address header).
function softBorder(): any {
  const s = { style: 'thin', color: { rgb: 'BFBFBF' } };
  return { top: s, bottom: s, left: s, right: s };
}

// Cell variant with a light grey border instead of the harsh black one.
function cellSoft(bg: string, bold = false, align: 'left' | 'center' | 'right' = 'left', sz = 10): any {
  return {
    font:      { name: 'Arial', bold, color: { rgb: '000000' }, sz },
    fill:      { fgColor: { rgb: bg } },
    alignment: { horizontal: align, vertical: 'center', wrapText: true },
    border:    softBorder(),
  };
}

// ─── Per-field cell typing ──────────────────────────────────────────────────
// Keep these in sync with the snap-type sets in src/lib/api.ts so Excel types
// line up with how values were normalized during extraction.
const DATE_FIELDS = new Set([
  'billing_date', 'statement_date', 'appraised_date',
  'lease_date', 'lease_begin_date', 'lease_end_date',
  'tax_bill_date', 'tax_due_date',
]);
const AMOUNT_FIELDS = new Set([
  'total_gas_bill', 'total_electricity_bill', 'total_internet_bill',
  'total_phone_bill', 'total_water_bill', 'total_sewer_bill',
  'total_water_sewer_bill', 'total_trash_bill',
  'beginning_balance', 'ending_balance', 'total_credits', 'total_debits',
  'appraised_as_is_value',
  'security_deposit', 'rent_and_charges', 'monthly_rent',
  'onetime_concession_amount', 'monthly_discount', 'other_discount',
  'total_income_ca', 'total_income_non_ca', 'total_rent',
  'utility_allowance', 'ca_shelter_allowance', 'cityfheps_rent_supplement',
  'household_share', 'utility_payment', 'total_monthly_rent',
  'total_tax_due', 'assessed_value',
]);
// Plain integer counts — stored as numbers with no $ / % format.
const COUNT_FIELDS = new Set(['household_ca_count', 'household_non_ca_count']);
// cap_rate arrives as a plain number (e.g. "6.5") — write it as numeric with
// no % conversion. Listed so the cell type is numeric instead of string.
const NUMBER_FIELDS = new Set(['cap_rate']);
const PERCENT_FIELDS = new Set<string>();
const YEAR_FIELDS = new Set(['tax_year']);

type CellKind = 'date' | 'amount' | 'percent' | 'year' | 'count' | 'number' | 'text';

function cellKindFor(field: string): CellKind {
  if (DATE_FIELDS.has(field))    return 'date';
  if (AMOUNT_FIELDS.has(field))  return 'amount';
  if (PERCENT_FIELDS.has(field)) return 'percent';
  if (YEAR_FIELDS.has(field))    return 'year';
  if (COUNT_FIELDS.has(field))   return 'count';
  if (NUMBER_FIELDS.has(field))  return 'number';
  return 'text';
}

function alignFor(field: string): 'left' | 'center' | 'right' {
  return cellKindFor(field) === 'text' ? 'left' : 'right';
}

function parseDateValue(raw: string): Date | null {
  if (!raw) return null;
  const mdy = raw.match(/^\s*(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\s*$/);
  if (mdy) {
    const mm = parseInt(mdy[1], 10);
    const dd = parseInt(mdy[2], 10);
    let yy   = parseInt(mdy[3], 10);
    if (yy < 100) yy += yy < 50 ? 2000 : 1900;
    const d = new Date(Date.UTC(yy, mm - 1, dd));
    if (!isNaN(d.getTime())) return d;
  }
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

function parseNumberValue(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[$,\s%]/g, '').trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

// Convert a raw extracted string into the appropriate xlsx cell object based
// on the field. Returns the original string if parsing fails, so the user
// still sees something (rather than an empty cell).
function coerceCell(field: string, raw: string): any {
  if (!raw) return '';
  switch (cellKindFor(field)) {
    case 'date': {
      const d = parseDateValue(raw);
      return d ? { t: 'd', v: d, z: 'mm/dd/yyyy' } : raw;
    }
    case 'amount': {
      const n = parseNumberValue(raw);
      return n !== null ? { t: 'n', v: n, z: '"$"#,##0.00' } : raw;
    }
    case 'percent': {
      const n = parseNumberValue(raw);
      if (n === null) return raw;
      // "6.5" (already a percent reading) → 0.065 so Excel's % format renders "6.50%"
      const val = n > 1 ? n / 100 : n;
      return { t: 'n', v: val, z: '0.00%' };
    }
    case 'year': {
      const n = parseInt(raw, 10);
      return !isNaN(n) ? { t: 'n', v: n, z: '0' } : raw;
    }
    case 'count': {
      const n = parseInt(raw, 10);
      return !isNaN(n) ? { t: 'n', v: n, z: '0' } : raw;
    }
    case 'number': {
      const n = parseNumberValue(raw);
      return n !== null ? { t: 'n', v: n } : raw;
    }
    default:
      return raw;
  }
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
  const byPage = new Map<number, Record<string, string[]>>();
  const pageOrder: number[] = [];
  const highlightedFields = new Set<string>();
  for (const row of rows) {
    highlightedFields.add(row.field);
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
  const visibleColumns = allColumns.filter(col => highlightedFields.has(col.key));

  const wsData: any[][] = [];
  const styles: { row: number; col: number; style: any }[] = [];
  let ri = 0;
  const push = (cells: any[]) => { wsData.push(cells); return ri++; };
  const sc = (r: number, c: number, s: any) => styles.push({ row: r, col: c, style: s });

  // Header row: page | field keys (only visible columns)
  const headerCells = ['page', ...visibleColumns.map(c => c.key)];
  const r0 = push(headerCells);
  for (let c = 0; c < headerCells.length; c++) {
    sc(r0, c, hdr(headerColor.bg, headerColor.font));
  }

  // One row per page (first value used if a field has multiple values)
  for (const page of sortedPages) {
    const pageMap = byPage.get(page)!;
    const rowCells: any[] = [
      page,
      ...visibleColumns.map(col => {
        const arr = pageMap[col.key] ?? [];
        const val = arr.length > 0 ? arr[0] : '';
        return coerceCell(col.key, val);
      }),
    ];
    const r = push(rowCells);
    sc(r, 0, cell(C.whiteBg, true, 'center', 10));
    visibleColumns.forEach((col, idx) => {
      sc(r, 1 + idx, cell(C.whiteBg, false, alignFor(col.key), 10));
    });
  }

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  applyStyles(ws, wsData, styles);
  ws['!cols'] = [{ wch: 8 }, ...visibleColumns.map(() => ({ wch: 22 }))];
  ws['!freeze'] = { xSplit: 1, ySplit: 1 };
  return ws;
}

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
      formula: (r, L) => `IFERROR((${L.lease_end_date}${r}-${L.lease_begin_date}${r})/365.25,0)` },
    { key: 'security_deposit',   field: 'security_deposit',   label: 'Security Deposit', width: 15, type: 'money' },
    { key: 'monthly_rent',       field: 'monthly_rent',       label: 'Monthly Rent', width: 13, type: 'money' },
    { key: 'lease_value', field: null, label: 'Lease Value', width: 14,
      formula: (r, L) => `IFERROR(${L.monthly_rent}${r}*${L.lease_term}${r}*12,0)` },
  ];

  const coreFields = new Set(core.map(c => c.field).filter((f): f is string => !!f));
  const extras = new Set<string>();
  for (const rows of fileMap.values()) {
    for (const row of rows) {
      if (coreFields.has(row.field)) continue;
      extras.add(row.field);
    }
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
        const raw = col.field ? values[col.field] ?? '' : '';
        rowCells.push(coerceCell(col.field ?? '', raw));
      }
    }

    const r = push(rowCells);
    sc(r, 0, cell(C.whiteBg, true, 'left', 10));
    for (let c = startExtraIdx; c < startCoreIdx; c++) sc(r, c, cell(C.whiteBg, false, 'left', 10));
    core.forEach((col, i) => {
      const isTyped = col.field ? cellKindFor(col.field) !== 'text' : false;
      const align: 'left' | 'center' | 'right' =
        col.type === 'checkbox' ? 'center' :
        col.type === 'money' || col.formula || isTyped ? 'right' : 'left';
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
function buildUnifiedSheet(fileMap: Map<string, ExtractedRow[]>, docType: DocumentType): XLSX.WorkSheet {
  const headerColor = HEADER_COLORS[docType];

  // Declared appraisal fields (in order), excluding 'custom'
  const fieldDefs = getFieldLabelsForType(docType).filter(f => f.value !== 'custom');

  // Collect any custom fields used across files, preserving first-appearance order
  const knownFields = new Set(fieldDefs.map(f => f.value as string));
  const customFields: string[] = [];
  for (const rows of fileMap.values()) {
    for (const row of rows) {
      if (!knownFields.has(row.field) && !customFields.includes(row.field)) {
        customFields.push(row.field);
      }
    }
  }

  const fieldColumns = [
    ...fieldDefs.map(f => ({ key: f.value, label: f.label })),
    ...customFields.map(f => ({ key: f, label: f })),
  ];

  type PdfRow = {
    pdfNum: number;
    folder: string;
    fileName: string;
    values: Record<string, string>;
  };
  const pdfRows: PdfRow[] = [];
  const highlightedFields = new Set<string>();  // fields that were highlighted in at least one PDF
  let pdfNum = 0;
  for (const [filename, rows] of fileMap.entries()) {
    pdfNum++;
    const values: Record<string, string> = {};
    let folder = '';
    for (const row of rows) {
      highlightedFields.add(row.field);  // presence in rows → user highlighted this field
      if (row.folderName && !folder) folder = row.folderName;
      if (!row.value) continue;
      if (!values[row.field]) values[row.field] = row.value;
    }
    pdfRows.push({
      pdfNum,
      folder,
      fileName: filename.replace(/\.(pdf|docx?)$/i, ''),
      values,
    });
  }

  const visibleColumns = fieldColumns.filter(col => highlightedFields.has(col.key));

  const wsData: any[][] = [];
  const styles: { row: number; col: number; style: any }[] = [];
  let ri = 0;
  const push = (cells: any[]) => { wsData.push(cells); return ri++; };
  const sc = (r: number, c: number, s: any) => styles.push({ row: r, col: c, style: s });

  // Header row
  const headerCells = ['PDF #', 'Folder', 'File Name', ...visibleColumns.map(c => c.label)];
  const r0 = push(headerCells);
  for (let c = 0; c < headerCells.length; c++) {
    sc(r0, c, hdr(headerColor.bg, headerColor.font));
  }

  // Data rows — one per PDF
  for (const pr of pdfRows) {
    const rowCells: any[] = [
      pr.pdfNum,
      pr.folder,
      pr.fileName,
      ...visibleColumns.map(col => coerceCell(col.key, pr.values[col.key] ?? '')),
    ];
    const r = push(rowCells);
    sc(r, 0, cell(C.whiteBg, true,  'center', 10));  // PDF #
    sc(r, 1, cell(C.whiteBg, false, 'left',   10));  // Folder
    sc(r, 2, cell(C.whiteBg, true,  'left',   10));  // File Name
    visibleColumns.forEach((col, idx) => {
      sc(r, 3 + idx, cell(C.whiteBg, false, alignFor(col.key), 10));
    });
  }

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  applyStyles(ws, wsData, styles);
  ws['!cols'] = [
    { wch: 7 },    // PDF #
    { wch: 20 },   // Folder
    { wch: 30 },   // File Name
    ...visibleColumns.map(() => ({ wch: 22 })),
  ];
  ws['!freeze'] = { xSplit: 3, ySplit: 1 };
  return ws;
}

// Utility-type label per total_* field. Drives the per-utility-type grouping.
const UTILITY_TOTAL_FIELDS: Record<string, string> = {
  total_gas_bill:         'Gas',
  total_electricity_bill: 'Electricity',
  total_water_bill:       'Water',
  total_sewer_bill:       'Sewer',
  total_water_sewer_bill: 'Water & Sewer',
  total_internet_bill:    'Internet',
  total_phone_bill:       'Phone',
  total_trash_bill:       'Trash',
};

// Orange/peach color shared by header + total rows in the utility sheet.
const UTILITY_ORANGE = 'FABF8F';
const UTILITY_HEADER = 'D8E4BC';
const UTILITY_PROPERTY = 'FFFFFF';
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Bucket a billing date into the calendar month it covers most.
// Heuristic: bills are issued near the end of the period, so a bill issued
// in the first half of a month covers most of the previous month; bills
// issued in the second half mostly cover the current month.
//   07/08/2025 → 2025-06 (Jun-25)
//   12/30/2025 → 2025-12 (Dec-25)
function billDateToMonthKey(dateStr: string): string | null {
  const d = parseDateValue(dateStr);
  if (!d) return null;
  let m = d.getUTCMonth();
  let y = d.getUTCFullYear();
  if (d.getUTCDate() < 15) {
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
  }
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}

function monthKeyLabel(key: string): string {  // "2025-06" → "Jun-25"
  const [y, m] = key.split('-');
  return `${MONTH_NAMES[parseInt(m, 10) - 1]}-${y.slice(2)}`;
}

// Per-export merge options (kept for backward compat — currently unused since
// merging is done via the bank-style merge dialog before export).
export interface UtilityMergeOptions {
  property: boolean;
  provider: boolean;
  account:  boolean;
}

// Pick the most-common non-empty value from a list. Ties broken by first-seen.
function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) { best = v; bestN = n; }
  }
  return best;
}

// Excel column letter (1-indexed): 1→A, 27→AA
function colLetter(n: number): string {
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

// Layout: one table per utility type (Water, Gas, Electricity, …). Inside
// each table, rows are (provider × account) tuples. Columns are month
// buckets (Jun-25, Jul-25, …) with year-total columns inserted between
// year boundaries (Dec-25 → 2025 → Jan-26). Total row at the bottom of
// each table sums each column. Property + address shown once at the
// top-right of the sheet. Orange (FABF8F) header / total fills.
function buildUtilityPivotSheet(
  fileMap: Map<string, ExtractedRow[]>,
  _merge: UtilityMergeOptions = { property: false, provider: false, account: false },
): XLSX.WorkSheet {

  // ─── Step 1: collect per-page data with carry-forward provider/account ──
  type PageData = {
    fileNum: number;
    folder: string;
    fileName: string;
    page: number;
    provider: string;
    account: string;
    property: string;
    address: string;
    monthKey: string;          // bucketed YYYY-MM
    fieldValues: Record<string, string>;
  };
  const pages: PageData[] = [];
  let pdfNum = 0;
  for (const [filename, rows] of fileMap.entries()) {
    pdfNum++;
    const cleanedFilename = filename.replace(/\.(pdf|docx?)$/i, '');
    let folder = '';
    const byPage = new Map<number, Record<string, string>>();
    for (const row of rows) {
      if (row.folderName && !folder) folder = row.folderName;
      if (!row.value) continue;
      if (!byPage.has(row.page)) byPage.set(row.page, {});
      const m = byPage.get(row.page)!;
      if (!m[row.field]) m[row.field] = row.value;
    }
    let lastProvider = '';
    let lastAccount = '';
    let lastProperty = '';
    let lastAddress = '';
    const sortedPages = Array.from(byPage.keys()).sort((a, b) => a - b);
    for (const page of sortedPages) {
      const vals = byPage.get(page)!;
      if (vals.provider_name)  lastProvider = vals.provider_name;
      if (vals.account_number) lastAccount  = vals.account_number;
      if (vals.property_name)  lastProperty = vals.property_name;
      if (vals.address)        lastAddress  = vals.address;
      pages.push({
        fileNum: pdfNum,
        folder,
        fileName: cleanedFilename,
        page,
        provider: lastProvider,
        account: lastAccount,
        property: lastProperty,
        address: lastAddress,
        monthKey: vals.billing_date ? (billDateToMonthKey(vals.billing_date) ?? '') : '',
        fieldValues: vals,
      });
    }
  }

  // ─── Step 2: representative property + address (shown once at top) ───
  const allProps = pages.map(p => p.property).filter(Boolean);
  const allAddrs = pages.map(p => p.address ).filter(Boolean);
  const headerProperty = mostCommon(allProps);
  const headerAddress  = mostCommon(allAddrs);

  // ─── Step 3: build per-utility-type tables ───
  type TableRow = {
    folder: string;
    fileName: string;
    provider: string;
    account: string;
    monthValues: Map<string, number>;   // monthKey → numeric amount
  };
  type Table = {
    utilityField: string;
    utilityLabel: string;
    rows: Map<string, TableRow>;        // key = `${provider}__${account||fileName}`
    monthKeys: Set<string>;
    // Actual scraped billing dates that fell into each month bucket.
    // Used for the sub-header row under each month label.
    monthScrapedDates: Map<string, Set<string>>;
  };
  const tables = new Map<string, Table>();

  for (const p of pages) {
    for (const [field, label] of Object.entries(UTILITY_TOTAL_FIELDS)) {
      const raw = p.fieldValues[field];
      if (!raw) continue;
      const num = parseFloat(raw.replace(/[$,\s]/g, ''));
      if (isNaN(num)) continue;
      let table = tables.get(field);
      if (!table) {
        table = {
          utilityField: field, utilityLabel: label,
          rows: new Map(), monthKeys: new Set(),
          monthScrapedDates: new Map(),
        };
        tables.set(field, table);
      }
      const rowKey = `${p.provider}__${p.account || p.fileName}`;
      let tr = table.rows.get(rowKey);
      if (!tr) {
        tr = {
          folder: p.folder,
          fileName: p.fileName,
          provider: p.provider,
          account: p.account,
          monthValues: new Map(),
        };
        table.rows.set(rowKey, tr);
      } else {
        // Multiple PDFs feeding the same (provider, account) row — keep the
        // first non-empty folder, and join file names with " · " so all
        // sources are visible.
        if (!tr.folder && p.folder) tr.folder = p.folder;
        if (tr.fileName !== p.fileName && !tr.fileName.split(' · ').includes(p.fileName)) {
          tr.fileName = `${tr.fileName} · ${p.fileName}`;
        }
      }
      if (p.monthKey) {
        tr.monthValues.set(p.monthKey, (tr.monthValues.get(p.monthKey) ?? 0) + num);
        table.monthKeys.add(p.monthKey);
        const rawDate = p.fieldValues.billing_date;
        if (rawDate) {
          if (!table.monthScrapedDates.has(p.monthKey)) {
            table.monthScrapedDates.set(p.monthKey, new Set());
          }
          table.monthScrapedDates.get(p.monthKey)!.add(rawDate.trim());
        }
      }
    }
  }

  // ─── Step 4: build a unified column timeline (months + year totals) ───
  const allMonths = new Set<string>();
  for (const t of tables.values()) for (const k of t.monthKeys) allMonths.add(k);
  const sortedMonths = Array.from(allMonths).sort();   // YYYY-MM sorts naturally

  type ColSpec =
    | { kind: 'month'; key: string; label: string }
    | { kind: 'year';  key: string; label: string };
  const timeline: ColSpec[] = [];
  let lastYear = '';
  for (const mk of sortedMonths) {
    const y = mk.slice(0, 4);
    if (lastYear && y !== lastYear) {
      timeline.push({ kind: 'year', key: lastYear, label: lastYear });
    }
    timeline.push({ kind: 'month', key: mk, label: monthKeyLabel(mk) });
    lastYear = y;
  }
  if (lastYear) timeline.push({ kind: 'year', key: lastYear, label: lastYear });

  // ─── Step 5: emit the worksheet ───
  const wsData: any[][] = [];
  const styles: { row: number; col: number; style: any }[] = [];
  const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = [];
  let ri = 0;
  const push = (cells: any[]) => { wsData.push(cells); return ri++; };
  const sc   = (r: number, c: number, s: any) => styles.push({ row: r, col: c, style: s });

  // Fixed columns: 0:Utility Items · 1:Folder · 2:File Name ·
  //                3:Utility Provider · 4:Account Number
  const UTIL_COL    = 0;
  const FOLDER_COL  = 1;
  const FILE_COL    = 2;
  const PROV_COL    = 3;
  const ACCT_COL    = 4;
  const FIXED_COLS  = 5;
  const totalCols   = FIXED_COLS + timeline.length;

  // Property + address block (top-LEFT, stacked, soft grey borders).
  if (headerProperty || headerAddress) {
    const propRow = Array(totalCols).fill('');
    propRow[0] = 'Property:';
    propRow[1] = headerProperty;
    const pr = push(propRow);
    sc(pr, 0, cellSoft(UTILITY_PROPERTY, true, 'left', 10));
    sc(pr, 1, cellSoft(UTILITY_PROPERTY, true, 'left', 10));

    const addrRow = Array(totalCols).fill('');
    addrRow[0] = 'Address:';
    addrRow[1] = headerAddress;
    const ar = push(addrRow);
    sc(ar, 0, cellSoft(UTILITY_PROPERTY, true, 'left', 10));
    sc(ar, 1, cellSoft(UTILITY_PROPERTY, true, 'left', 10));

    push(Array(totalCols).fill(''));   // spacer
  }

  // Sort utility tables by their natural label order
  const utilityOrder = Object.keys(UTILITY_TOTAL_FIELDS);
  const sortedTables = Array.from(tables.values()).sort(
    (a, b) => utilityOrder.indexOf(a.utilityField) - utilityOrder.indexOf(b.utilityField),
  );

  for (const table of sortedTables) {
    // Header row 1 — month bucket / year labels
    const headerCells: any[] = [
      'Utility Items', 'Folder Path', 'File Name', 'Utility Provider', 'Account Number',
    ];
    for (const col of timeline) headerCells.push(col.label);
    const hr = push(headerCells);
    for (let c = 0; c < headerCells.length; c++) {
      sc(hr, c, hdr(UTILITY_HEADER, '000000', true, 10));
    }

    // Header row 2 — actual scraped billing date(s) for each month bucket.
    // Year-total columns get an empty sub-header. If multiple distinct
    // billing dates fell into the same bucket, they're joined with " · ".
    const subHeader: any[] = ['', '', '', '', ''];
    for (const col of timeline) {
      if (col.kind === 'month') {
        const dates = table.monthScrapedDates.get(col.key);
        if (!dates || dates.size === 0) {
          subHeader.push('');
        } else {
          subHeader.push(Array.from(dates).join(' · '));
        }
      } else {
        subHeader.push('');
      }
    }
    const shr = push(subHeader);
    for (let c = 0; c < subHeader.length; c++) {
      sc(shr, c, hdr(UTILITY_ORANGE, '000000', false, 9));
    }

    // Sort rows for stable output: by provider then account
    const sortedRows = Array.from(table.rows.values()).sort((a, b) => {
      if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
      return a.account.localeCompare(b.account);
    });

    const dataStartRow = ri;
    for (const row of sortedRows) {
      const dataCells: any[] = [
        table.utilityLabel,
        row.folder,
        row.fileName,
        row.provider,
        row.account,
      ];
      for (const col of timeline) {
        if (col.kind === 'month') {
          const v = row.monthValues.get(col.key);
          dataCells.push(v !== undefined ? { t: 'n', v, z: '"$"#,##0.00' } : '');
        } else {
          // Year-total: SUM of this row's month columns within this year.
          const monthCols: number[] = [];
          for (let i = 0; i < timeline.length; i++) {
            const t = timeline[i];
            if (t.kind === 'month' && t.key.startsWith(col.key + '-')) {
              monthCols.push(FIXED_COLS + i);
            }
          }
          if (monthCols.length === 0) {
            dataCells.push('');
          } else {
            const rowExcel = ri + 1;   // current data row, 1-indexed
            const refs = monthCols.map(c => `${colLetter(c + 1)}${rowExcel}`);
            dataCells.push({ t: 'n', v: 0, f: `SUM(${refs.join(',')})`, z: '"$"#,##0.00' });
          }
        }
      }
      const r = push(dataCells);
      sc(r, UTIL_COL,   hdr(UTILITY_ORANGE,  '000000', true,  10));   // utility label — bold orange
      sc(r, FOLDER_COL, cell(UTILITY_ORANGE, false, 'left',   10));
      sc(r, FILE_COL,   cell(UTILITY_ORANGE, false, 'left',   10));
      sc(r, PROV_COL,   cell(UTILITY_ORANGE, false, 'left',   10));
      sc(r, ACCT_COL,   cell(UTILITY_ORANGE, false, 'center', 10));
      for (let c = FIXED_COLS; c < dataCells.length; c++) {
        sc(r, c, cell(UTILITY_ORANGE, false, 'right', 10));
      }
    }
    const dataEndRow = ri - 1;

    // Total row — label spans across the FIXED_COLS columns.
    const totalCells: any[] = [`Total ${table.utilityLabel}`, '', '', '', ''];
    for (let i = 0; i < timeline.length; i++) {
      const colIdx = FIXED_COLS + i;
      if (sortedRows.length === 0) {
        totalCells.push('');
        continue;
      }
      const startRowExcel = dataStartRow + 1;   // 1-indexed
      const endRowExcel   = dataEndRow   + 1;
      const letter = colLetter(colIdx + 1);
      totalCells.push({
        t: 'n', v: 0,
        f: `SUM(${letter}${startRowExcel}:${letter}${endRowExcel})`,
        z: '"$"#,##0.00',
      });
    }
    const tr = push(totalCells);
    merges.push({ s: { r: tr, c: 0 }, e: { r: tr, c: FIXED_COLS - 1 } });
    for (let c = 0; c < totalCells.length; c++) {
      sc(tr, c, hdr(UTILITY_ORANGE, '000000', true, 10));
    }

    // Three-row gap before the next table for visual breathing room.
    push(Array(totalCols).fill(''));
    push(Array(totalCols).fill(''));
    push(Array(totalCols).fill(''));
  }

  if (wsData.length === 0) {
    push(['No utility totals were highlighted']);
  }

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  applyStyles(ws, wsData, styles);
  if (merges.length > 0) ws['!merges'] = merges;

  const cols: { wch: number }[] = [
    { wch: 16 },   // Utility Items
    { wch: 22 },   // Folder Path
    { wch: 28 },   // File Name
    { wch: 24 },   // Utility Provider
    { wch: 16 },   // Account Number
  ];
  for (let i = 0; i < timeline.length; i++) {
    cols.push({ wch: timeline[i].kind === 'year' ? 11 : 11 });
  }
  ws['!cols'] = cols;
  ws['!freeze'] = { xSplit: FIXED_COLS, ySplit: 0 };
  return ws;
}


export function exportToExcel(
  data: ExtractedRow[],
  _filename: string,
  provider: string,
  options: { utilityMerge?: UtilityMergeOptions } = {},
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
    const ws = buildUnifiedSheet(fileMap, 'appraisal');
    XLSX.utils.book_append_sheet(wb, ws, 'Appraisals');
  } else if (overallType === 'tax') {
    const ws = buildUnifiedSheet(fileMap, 'tax');
    XLSX.utils.book_append_sheet(wb, ws, 'Tax');

  } else if (overallType === 'utility_bill') {
    // One pivot table per (provider, utility-type), with billing dates as
    // columns. Same provider + same type are merged into one table; rows
    // are per (file × account); different providers get separate blocks.
    const ws = buildUtilityPivotSheet(fileMap, options.utilityMerge);
    XLSX.utils.book_append_sheet(wb, ws, 'Utility Bills');

  } else if (overallType === 'lease_contract') {
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

  // Turn off Excel's default gridlines on every sheet — workbook-level
  // and per-sheet so it renders cleanly in any viewer.
  if (!wb.Workbook) wb.Workbook = {};
  wb.Workbook.Views = [{ RTL: false }];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    (ws as any)['!view']      = { showGridLines: false };
    (ws as any)['!sheetView'] = { showGridLines: false };
  }

  XLSX.writeFile(wb, `Pexl_${provider.replace(/\s+/g, '')}_${dateStr}.xlsx`);
}
