/* eslint-disable no-useless-escape */
/* eslint-disable @typescript-eslint/no-explicit-any */
import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';
import type { ExtractedRow } from '@/types/utilscraper';

// ─── Sheet name helper ───────────────────────────────────────────────────────
const uniqueSheetName = (wb: ExcelJS.Workbook, base: string): string => {
  const existing = new Set(wb.worksheets.map(ws => ws.name));
  let name = base.slice(0, 31).replace(/[[\]:*?/\\]/g, '-') || 'Sheet';
  let n = 2;
  while (existing.has(name)) {
    const suffix = ` (${n})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
    n++;
  }
  return name;
};

// ─── Borders ─────────────────────────────────────────────────────────────────
const thinBorder:   Partial<ExcelJS.Border> = { style: 'thin',   color: { argb: 'FF000000' } };
const mediumBorder: Partial<ExcelJS.Border> = { style: 'medium', color: { argb: 'FF000000' } };
const noBorder:     Partial<ExcelJS.Border> = {};

const allBorders: Partial<ExcelJS.Borders> = {
  top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder,
};

// Trailing table group borders — outer only
const groupBorder = (
  pos: 'left' | 'mid' | 'right' | 'solo',
  top = true,
  bottom = true,
): Partial<ExcelJS.Borders> => ({
  top:    top    ? mediumBorder : noBorder,
  bottom: bottom ? mediumBorder : noBorder,
  left:   (pos === 'left'  || pos === 'solo') ? mediumBorder : noBorder,
  right:  (pos === 'right' || pos === 'solo') ? mediumBorder : noBorder,
});

// ─── Fills ───────────────────────────────────────────────────────────────────
const headerFill:     ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F497D' } };
const propHeaderFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD6E4F0' } };
const totalFill:      ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2F7' } };
const darkBlueFill:   ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F497D' } };
const sagGreenFill:   ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC4D79B' } };
const whiteFill:      ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };

// ─── Fonts ───────────────────────────────────────────────────────────────────
const headerFont: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10, name: 'Arial' };
const whiteFont:  Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10, name: 'Arial' };
const blackFont:  Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FF000000' }, size: 10, name: 'Arial' };
const baseFont:   Partial<ExcelJS.Font> = { name: 'Arial', size: 10 };
const boldFont:   Partial<ExcelJS.Font> = { name: 'Arial', size: 10, bold: true };

// ─── Helpers ─────────────────────────────────────────────────────────────────
const colLetter = (n: number): string => {
  let result = '';
  while (n > 0) { n--; result = String.fromCharCode(65 + (n % 26)) + result; n = Math.floor(n / 26); }
  return result;
};

const applyCell = (
  ws: ExcelJS.Worksheet,
  row: number,
  col: number,
  value: any,
  opts: {
    fill?: ExcelJS.Fill;
    font?: Partial<ExcelJS.Font>;
    borders?: Partial<ExcelJS.Borders>;
    numFmt?: string;
    align?: Partial<ExcelJS.Alignment>;
  } = {},
) => {
  const cell = ws.getCell(row, col);
  cell.value = value;
  if (opts.fill) cell.fill = opts.fill;
  cell.font = { name: 'Arial', size: 10, ...opts.font };
  cell.border = opts.borders ?? allBorders;
  if (opts.numFmt) cell.numFmt = opts.numFmt;
  cell.alignment = { vertical: 'middle', wrapText: false, ...opts.align };
};

const getEndOfMonth = (year: number, month: number) => new Date(year, month + 1, 0);

const fmtDate = (d: Date) =>
  `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;

// Build ordered array of 12 month-end date strings ending at anchorDate
const buildT12Months = (anchorDate: Date): string[] => {
  const months: string[] = [];
  const t12StartMonth = anchorDate.getMonth() - 11;
  const t12StartYear  = anchorDate.getFullYear();
  let cy = t12StartYear + Math.floor(t12StartMonth / 12);
  let cm = ((t12StartMonth % 12) + 12) % 12;
  const ey = anchorDate.getFullYear();
  const em = anchorDate.getMonth();
  while (cy < ey || (cy === ey && cm <= em)) {
    months.push(fmtDate(getEndOfMonth(cy, cm)));
    cm++; if (cm > 11) { cm = 0; cy++; }
  }
  return months;
};

// ─── Similarity detection for merge suggestions ──────────────────────────────
const normalizeText = (s: string): string =>
  s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

const normalizeAccount = (s: string): string => s.replace(/[^0-9]/g, '');

// Levenshtein distance for fuzzy matching
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m: number[][] = [];
  for (let i = 0; i <= b.length; i++) m[i] = [i];
  for (let j = 0; j <= a.length; j++) m[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      m[i][j] = b[i - 1] === a[j - 1]
        ? m[i - 1][j - 1]
        : Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
    }
  }
  return m[b.length][a.length];
}

const propertySimilar = (a: string, b: string): boolean => {
  if (!a || !b) return false;
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return true;
  if (na.length < 3 || nb.length < 3) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  // Allow small typos: distance ≤ 2 or ≤20% of length
  const dist = levenshtein(na, nb);
  const limit = Math.max(2, Math.floor(Math.min(na.length, nb.length) * 0.2));
  return dist <= limit;
};

const accountSimilar = (a: string, b: string): boolean => {
  if (!a || !b) return false;
  const da = normalizeAccount(a);
  const db = normalizeAccount(b);
  if (!da || !db) return false;
  if (da === db) return true;
  // Same last 4 digits is a strong indicator (masked accounts)
  if (da.length >= 4 && db.length >= 4 && da.slice(-4) === db.slice(-4)) return true;
  // One contains the other
  if (da.includes(db) || db.includes(da)) return true;
  return false;
};

const addressSimilar = (a: string, b: string): boolean => {
  if (!a || !b) return false;
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return true;
  if (na.length < 5 || nb.length < 5) return false;
  // Substring match for partial addresses
  if (na.includes(nb) || nb.includes(na)) return true;
  // Levenshtein for OCR-style differences
  const dist = levenshtein(na, nb);
  return dist <= Math.max(3, Math.floor(Math.min(na.length, nb.length) * 0.15));
};

// Generic group builder — clusters values that pass the similarity check
function findSimilarGroups(values: string[], similarFn: (a: string, b: string) => boolean): string[][] {
  const groups: string[][] = [];
  const used = new Set<number>();
  for (let i = 0; i < values.length; i++) {
    if (used.has(i)) continue;
    const group = [values[i]];
    used.add(i);
    for (let j = i + 1; j < values.length; j++) {
      if (used.has(j)) continue;
      if (similarFn(values[i], values[j])) {
        group.push(values[j]);
        used.add(j);
      }
    }
    if (group.length > 1) groups.push(group);
  }
  return groups;
}

export interface MergeGroup {
  field: 'property_name' | 'account_number' | 'address';
  fieldLabel: string;
  values: string[];        // distinct similar values found
}

export interface MergeChoice {
  field: 'property_name' | 'account_number' | 'address';
  values: string[];        // values to merge
  canonical: string;       // chosen canonical value
}

// Scan extracted bank statement data for merge opportunities
export function findMergeOpportunities(data: ExtractedRow[]): MergeGroup[] {
  // Group rows by file → flatten each file
  const fileMap = new Map<string, ExtractedRow[]>();
  for (const row of data) {
    const key = row.filename || 'Unknown';
    if (!fileMap.has(key)) fileMap.set(key, []);
    fileMap.get(key)!.push(row);
  }

  const props = new Set<string>();
  const accts = new Set<string>();
  const addrs = new Set<string>();

  for (const rows of fileMap.values()) {
    const item = flattenToItem('', rows);
    if (item.propertyName)  props.add(item.propertyName);
    if (item.accountNumber) accts.add(item.accountNumber);
    if (item.address)       addrs.add(item.address);
  }

  const groups: MergeGroup[] = [];
  const propGroups = findSimilarGroups(Array.from(props), propertySimilar);
  for (const g of propGroups) groups.push({ field: 'property_name', fieldLabel: 'Property Name', values: g });

  const acctGroups = findSimilarGroups(Array.from(accts), accountSimilar);
  for (const g of acctGroups) groups.push({ field: 'account_number', fieldLabel: 'Account Number', values: g });

  const addrGroups = findSimilarGroups(Array.from(addrs), addressSimilar);
  for (const g of addrGroups) groups.push({ field: 'address', fieldLabel: 'Address', values: g });

  return groups;
}

// Apply user-confirmed merges by replacing values in the data
export function applyMerges(data: ExtractedRow[], choices: MergeChoice[]): ExtractedRow[] {
  if (choices.length === 0) return data;
  // Build a per-field replacement map
  const replaceMap: Record<string, Map<string, string>> = {
    property_name:  new Map(),
    account_number: new Map(),
    address:        new Map(),
  };
  for (const c of choices) {
    for (const v of c.values) {
      if (v !== c.canonical) replaceMap[c.field].set(v, c.canonical);
    }
  }
  return data.map(row => {
    const m = replaceMap[row.field];
    if (m && row.value && m.has(row.value)) {
      return { ...row, value: m.get(row.value)! };
    }
    return row;
  });
}

// ─── Pexl → bank statement item adapter ──────────────────────────────────────
interface BankStatementItem {
  filename: string;
  propertyName: string;
  accountNumber: string;
  accountName: string;
  address: string;
  statementDate: string;       // raw extracted (formatted later)
  beginningBalance: number;
  endingBalance: number;
  totalCredits: number;        // → Deposits
  totalDebits: number;         // → Withdrawals
}

const parseNum = (s: string | undefined): number => {
  if (!s) return 0;
  const n = parseFloat(String(s).replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
};

// Flatten ExtractedRow[] for one PDF into a BankStatementItem.
// First-occurrence wins for each field.
const flattenToItem = (filename: string, rows: ExtractedRow[]): BankStatementItem => {
  const map: Record<string, string> = {};
  for (const r of rows) {
    if (!r.value) continue;
    if (!map[r.field]) map[r.field] = r.value;
  }
  return {
    filename,
    propertyName:     map.property_name      || '',
    accountNumber:    map.account_number     || '',
    accountName:      map.account_name       || '',
    address:          map.address            || '',
    statementDate:    map.statement_date     || '',
    beginningBalance: parseNum(map.beginning_balance),
    endingBalance:    parseNum(map.ending_balance),
    totalCredits:     parseNum(map.total_credits),
    totalDebits:      parseNum(map.total_debits),
  };
};

// ─── Clear borders outside the table columns (B–K and N–U) ───────────────────
const clearOutsideBorders = (ws: ExcelJS.Worksheet) => {
  const inTable = (col: number) =>
    (col >= 2 && col <= 11) || (col >= 14 && col <= 21);

  ws.eachRow(row => {
    row.eachCell({ includeEmpty: true }, (cell, colNum) => {
      if (!inTable(colNum)) cell.border = {};
    });
  });
};

// ─── Trailing metrics table (T1, T3, T6, T9, T12) ────────────────────────────
const addTrailingTable = (ws: ExcelJS.Worksheet, lastDataRn: number, startRow: number) => {
  if (!lastDataRn || lastDataRn === 0) return;

  const N = 14, O = 15, P = 16;
  const Q = 17, R = 18, S = 19, T = 20, U = 21;
  const gb = groupBorder;
  const currencyFmt = '"$"#,##0.00';
  const pctFmt      = '0.00%';

  // Header row
  applyCell(ws, startRow, N, 'Bank Statement Actual',  { fill: darkBlueFill, font: { ...whiteFont, size: 11 }, borders: gb('left',  true, true), align: { horizontal: 'center', vertical: 'middle' } });
  applyCell(ws, startRow, O, 'Operating Stmts Actual', { fill: darkBlueFill, font: { ...whiteFont, size: 11 }, borders: gb('mid',   true, true), align: { horizontal: 'center', vertical: 'middle' } });
  applyCell(ws, startRow, P, 'Diff %',                 { fill: darkBlueFill, font: { ...whiteFont, size: 11 }, borders: gb('right', true, true), align: { horizontal: 'center', vertical: 'middle' } });

  ws.mergeCells(startRow, Q, startRow, R);
  applyCell(ws, startRow, Q, 'Bank Statement',  { fill: sagGreenFill, font: { ...blackFont, size: 11, italic: true }, borders: gb('left', true, true), align: { horizontal: 'center', vertical: 'middle' } });
  ws.mergeCells(startRow, S, startRow, T);
  applyCell(ws, startRow, S, 'Operating Stmts', { fill: sagGreenFill, font: { ...blackFont, size: 11, italic: true }, borders: gb('left', true, true), align: { horizontal: 'center', vertical: 'middle' } });
  applyCell(ws, startRow, U, 'Diff %',          { fill: sagGreenFill, font: { ...blackFont, size: 11, italic: true }, borders: gb('solo', true, true), align: { horizontal: 'center', vertical: 'middle' } });

  // Extra empty colored row below header
  const extraRow = startRow + 1;
  applyCell(ws, extraRow, N, '', { fill: darkBlueFill, borders: gb('left',  true, true) });
  applyCell(ws, extraRow, O, '', { fill: darkBlueFill, borders: gb('mid',   true, true) });
  applyCell(ws, extraRow, P, '', { fill: darkBlueFill, borders: gb('right', true, true) });
  applyCell(ws, extraRow, Q, '', { fill: sagGreenFill, borders: gb('left',  true, true) });
  applyCell(ws, extraRow, R, '', { fill: sagGreenFill, borders: gb('right', true, true) });
  applyCell(ws, extraRow, S, '', { fill: sagGreenFill, borders: gb('left',  true, true) });
  applyCell(ws, extraRow, T, '', { fill: sagGreenFill, borders: gb('right', true, true) });
  applyCell(ws, extraRow, U, '', { fill: sagGreenFill, borders: gb('solo',  true, true) });

  // Column widths
  ws.getColumn(12).width = 4;
  ws.getColumn(13).width = 4;
  ws.getColumn(N).width  = 22;
  ws.getColumn(O).width  = 22;
  ws.getColumn(P).width  = 12;
  ws.getColumn(Q).width  = 14;
  ws.getColumn(R).width  = 16;
  ws.getColumn(S).width  = 14;
  ws.getColumn(T).width  = 16;
  ws.getColumn(U).width  = 12;

  const periods = [
    { n: 1,  label: 'Trailing - 1',  annLabel: 'T1 Annualized',
      ann:   (_s: number, e: number) => `IFERROR(H${e}*12,0)`,
      annOp: (_s: number, e: number) => `IFERROR(I${e}*12,0)` },
    { n: 3,  label: 'Trailing - 3',  annLabel: 'T3 Annualized',
      ann:   (s: number, e: number) => `IFERROR(SUM(H${s}:H${e})*4,0)`,
      annOp: (s: number, e: number) => `IFERROR(SUM(I${s}:I${e})*4,0)` },
    { n: 6,  label: 'Trailing - 6',  annLabel: 'T6 Annualized',
      ann:   (s: number, e: number) => `IFERROR(SUM(H${s}:H${e})*2,0)`,
      annOp: (s: number, e: number) => `IFERROR(SUM(I${s}:I${e})*2,0)` },
    { n: 9,  label: 'Trailing - 9',  annLabel: 'T9 Annualized',
      ann:   (s: number, e: number) => `IFERROR(SUM(H${s}:H${e})/9*12,0)`,
      annOp: (s: number, e: number) => `IFERROR(SUM(I${s}:I${e})/9*12,0)` },
    { n: 12, label: 'Trailing - 12', annLabel: 'T12 Annualized',
      ann:   (s: number, e: number) => `IFERROR(SUM(H${s}:H${e}),0)`,
      annOp: (s: number, e: number) => `IFERROR(SUM(I${s}:I${e}),0)` },
  ];

  periods.forEach(({ n, label, annLabel, ann, annOp }, idx) => {
    const labelRow = startRow + 2 + idx * 3;
    const valueRow = labelRow + 1;
    const emptyRow = labelRow + 2;
    const isFirst  = idx === 0;
    const isLast   = idx === periods.length - 1;
    const startR   = Math.max(lastDataRn - n + 1, 1);
    const endR     = lastDataRn;
    const NL = colLetter(N), OL = colLetter(O);
    const RL = colLetter(R), TL = colLetter(T);

    // Label row
    applyCell(ws, labelRow, N, label, { fill: whiteFill, font: { ...boldFont, color: { argb: 'FF1F3864' } }, borders: gb('left',  isFirst, false), align: { horizontal: 'center', vertical: 'middle' } });
    applyCell(ws, labelRow, O, label, { fill: whiteFill, font: { ...boldFont, color: { argb: 'FF1F3864' } }, borders: gb('mid',   isFirst, false), align: { horizontal: 'center', vertical: 'middle' } });
    applyCell(ws, labelRow, P, '',    { fill: whiteFill, borders: gb('right', isFirst, false) });
    applyCell(ws, labelRow, Q, '',    { fill: whiteFill, borders: gb('left',  isFirst, false) });
    applyCell(ws, labelRow, R, '',    { fill: whiteFill, borders: gb('right', isFirst, false) });
    applyCell(ws, labelRow, S, '',    { fill: whiteFill, borders: gb('left',  isFirst, false) });
    applyCell(ws, labelRow, T, '',    { fill: whiteFill, borders: gb('right', isFirst, false) });
    applyCell(ws, labelRow, U, '',    { fill: whiteFill, borders: gb('solo',  isFirst, false) });

    // Value row
    const bsFormula = n === 1 ? `H${endR}` : `SUM(H${startR}:H${endR})`;
    const opFormula = n === 1 ? `I${endR}` : `SUM(I${startR}:I${endR})`;

    applyCell(ws, valueRow, N, { formula: bsFormula },
      { fill: whiteFill, font: baseFont, numFmt: currencyFmt, borders: gb('left',  false, isLast), align: { horizontal: 'center', vertical: 'middle' } });
    applyCell(ws, valueRow, O, { formula: opFormula },
      { fill: whiteFill, font: baseFont, numFmt: currencyFmt, borders: gb('mid',   false, isLast), align: { horizontal: 'center', vertical: 'middle' } });
    applyCell(ws, valueRow, P, { formula: `IFERROR((${OL}${valueRow}-${NL}${valueRow})/${NL}${valueRow},0)` },
      { fill: whiteFill, font: baseFont, numFmt: pctFmt, borders: gb('right', false, isLast), align: { horizontal: 'right', vertical: 'middle' } });
    applyCell(ws, valueRow, Q, annLabel,
      { fill: whiteFill, font: boldFont, borders: gb('left',  false, isLast), align: { horizontal: 'center', vertical: 'middle' } });
    applyCell(ws, valueRow, R, { formula: ann(startR, endR) },
      { fill: whiteFill, font: baseFont, numFmt: currencyFmt, borders: gb('right', false, isLast), align: { horizontal: 'right', vertical: 'middle' } });
    applyCell(ws, valueRow, S, annLabel,
      { fill: whiteFill, font: boldFont, borders: gb('left',  false, isLast), align: { horizontal: 'center', vertical: 'middle' } });
    applyCell(ws, valueRow, T, { formula: annOp(startR, endR) },
      { fill: whiteFill, font: baseFont, numFmt: currencyFmt, borders: gb('right', false, isLast), align: { horizontal: 'right', vertical: 'middle' } });
    applyCell(ws, valueRow, U, { formula: `IFERROR((${TL}${valueRow}-${RL}${valueRow})/${RL}${valueRow},0)` },
      { fill: whiteFill, font: baseFont, numFmt: pctFmt, borders: gb('solo', false, isLast), align: { horizontal: 'right', vertical: 'middle' } });

    // Separator row (skip for last period)
    if (!isLast) {
      applyCell(ws, emptyRow, N, '', { fill: whiteFill, borders: gb('left',  false, false) });
      applyCell(ws, emptyRow, O, '', { fill: whiteFill, borders: gb('mid',   false, false) });
      applyCell(ws, emptyRow, P, '', { fill: whiteFill, borders: gb('right', false, false) });
      applyCell(ws, emptyRow, Q, '', { fill: whiteFill, borders: gb('left',  false, false) });
      applyCell(ws, emptyRow, R, '', { fill: whiteFill, borders: gb('right', false, false) });
      applyCell(ws, emptyRow, S, '', { fill: whiteFill, borders: gb('left',  false, false) });
      applyCell(ws, emptyRow, T, '', { fill: whiteFill, borders: gb('right', false, false) });
      applyCell(ws, emptyRow, U, '', { fill: whiteFill, borders: gb('solo',  false, false) });
    }
  });
};

// ─── Roll-up table ───────────────────────────────────────────────────────────
const addRollupTable = (
  ws: ExcelJS.Worksheet,
  propertyName: string,
  mainHeaders: string[],
  dateMap: Map<string, { deposits: number; withdrawals: number }>,
  startAtRow1 = false,
): { lastDataRn: number; headerRn: number } => {
  const currencyFmt          = '"$"#,##0.00';
  const blankZeroCurrencyFmt = '"$"#,##0.00;"$"#,##0.00;';

  if (!startAtRow1) {
    ws.addRow(Array(11).fill(''));
    ws.addRow(Array(11).fill(''));
    ws.addRow(Array(11).fill(''));
  }

  const metaLabels = ['', propertyName ? `Property: ${propertyName}` : 'Roll-Up', 'Roll-Up (All Accounts)', '', '', '', '', '', '', '', ''];
  let metaRow: ExcelJS.Row;
  if (startAtRow1) {
    metaRow = ws.getRow(1);
    metaLabels.forEach((v, i) => { metaRow.getCell(i + 1).value = v; });
    metaRow.commit();
  } else {
    metaRow = ws.addRow(metaLabels);
  }
  metaRow.eachCell(cell => { cell.fill = propHeaderFill; cell.font = boldFont; cell.border = allBorders; });

  const fullHeaders = ['', ...mainHeaders];
  let hRow: ExcelJS.Row;
  if (startAtRow1) {
    hRow = ws.getRow(2);
    fullHeaders.forEach((v, i) => { hRow.getCell(i + 1).value = v; });
    hRow.commit();
  } else {
    hRow = ws.addRow(fullHeaders);
  }
  hRow.eachCell(cell => { cell.fill = headerFill; cell.font = headerFont; cell.border = allBorders; });
  const headerRn = hRow.number;

  const allDates = Array.from(dateMap.keys())
    .map(d => new Date(d))
    .filter(d => !isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());

  const anchorDate = allDates.length > 0 ? allDates[allDates.length - 1] : new Date();
  const t12Months  = buildT12Months(anchorDate);

  let firstDataRn: number | null = null;
  let lastDataRn   = 0;
  let totalDeposits    = 0;
  let totalWithdrawals = 0;

  t12Months.forEach(monthKey => {
    const entry       = dateMap.get(monthKey);
    const deposits    = entry?.deposits    ?? 0;
    const withdrawals = entry?.withdrawals ?? 0;

    const dataRow = ws.addRow(['', monthKey, deposits || '', withdrawals || '', '', '', '', '', '', '', '']);
    const rn = dataRow.number;
    if (firstDataRn === null) firstDataRn = rn;
    lastDataRn = rn;

    dataRow.getCell(3).numFmt = blankZeroCurrencyFmt;
    dataRow.getCell(4).numFmt = blankZeroCurrencyFmt;
    dataRow.getCell(8).value  = { formula: `C${rn}` };
    dataRow.getCell(8).numFmt = currencyFmt;
    dataRow.eachCell((cell, colNum) => {
      if (colNum === 1) { cell.border = {}; return; }
      cell.font = baseFont;
      cell.border = allBorders;
    });

    totalDeposits    += deposits;
    totalWithdrawals += withdrawals;
  });

  const totRow = ws.addRow(['', 'Total', totalDeposits || '', totalWithdrawals || '', '', '', '', '', '', '', '']);
  totRow.getCell(3).numFmt = blankZeroCurrencyFmt;
  totRow.getCell(4).numFmt = blankZeroCurrencyFmt;
  totRow.eachCell((cell, colNum) => {
    if (colNum === 1) { cell.border = {}; return; }
    cell.fill = totalFill; cell.font = boldFont; cell.border = allBorders;
  });

  const avgRow = ws.addRow(['', 'Average', '', '', '', '', '', '', '', '', '']);
  avgRow.eachCell((cell, colNum) => {
    if (colNum === 1) { cell.border = {}; return; }
    cell.fill = totalFill; cell.font = boldFont; cell.border = allBorders;
  });
  if (firstDataRn !== null && lastDataRn > 0) {
    avgRow.getCell(3).value  = { formula: `IFERROR(AVERAGEIF(C${firstDataRn}:C${lastDataRn},"<>",C${firstDataRn}:C${lastDataRn}),0)` };
    avgRow.getCell(3).numFmt = blankZeroCurrencyFmt;
    avgRow.getCell(8).value  = { formula: `IFERROR(AVERAGEIF(H${firstDataRn}:H${lastDataRn},"<>0",H${firstDataRn}:H${lastDataRn}),0)` };
    avgRow.getCell(8).numFmt = currencyFmt;
  }

  return { lastDataRn, headerRn };
};

// ─── Main: Build the bank statement workbook from Pexl data ──────────────────
export const downloadBankStatementExcel = async (data: ExtractedRow[], baseFilename: string) => {
  const wb = new ExcelJS.Workbook();

  // Group ExtractedRow[] by file → ExtractedRow[]
  const fileMap = new Map<string, ExtractedRow[]>();
  for (const row of data) {
    const key = row.filename || 'Unknown';
    if (!fileMap.has(key)) fileMap.set(key, []);
    fileMap.get(key)!.push(row);
  }

  // Build BankStatementItems
  const items: BankStatementItem[] = [];
  for (const [filename, rows] of fileMap.entries()) {
    items.push(flattenToItem(filename, rows));
  }

  // Group by property → account
  const groupedByProperty = new Map<string, Map<string, BankStatementItem[]>>();
  for (const item of items) {
    const propKey = item.propertyName || 'Unknown Property';
    const acctKey = item.accountNumber || 'Unknown Account';
    if (!groupedByProperty.has(propKey)) groupedByProperty.set(propKey, new Map());
    const acctMap = groupedByProperty.get(propKey)!;
    if (!acctMap.has(acctKey)) acctMap.set(acctKey, []);
    acctMap.get(acctKey)!.push(item);
  }

  const isMultipleProperties   = groupedByProperty.size > 1;
  const hasAnyMultipleAccounts = Array.from(groupedByProperty.values()).some(m => m.size > 1);
  const shouldCreateRollup     = isMultipleProperties || hasAnyMultipleAccounts;

  const headers = [
    'Date', 'Deposits', 'Withdrawals', 'Unadjusted Balance', 'Adjusted Balance',
    'Adjustments', 'Actual Deposits', 'T-12', 'Deposits vs. Op Stmt. Diff.', 'Comments',
  ];

  const globalDateMap = new Map<string, { deposits: number; withdrawals: number }>();

  let rollupSheet: ExcelJS.Worksheet | null = null;
  if (shouldCreateRollup) {
    rollupSheet = wb.addWorksheet('Roll-Up');
    rollupSheet.views = [{ showGridLines: false }];
  }

  const currencyFmt          = '"$"#,##0.00';
  const blankZeroCurrencyFmt = '"$"#,##0.00;"$"#,##0.00;';

  groupedByProperty.forEach((accountMap, propertyKey) => {
    const sheetName = uniqueSheetName(wb, propertyKey);
    const ws        = wb.addWorksheet(sheetName);
    ws.views = [{ showGridLines: false }];
    const isMultipleAccounts = accountMap.size > 1;
    const propertyDateMap    = new Map<string, { deposits: number; withdrawals: number }>();

    let firstAccount    = true;
    let sheetLastDataRn = 0;
    let sheetHeaderRn   = 0;

    accountMap.forEach((acctItems, accountNumber) => {
      // Sort by statement_date (year-aware via Date)
      acctItems.sort((a, b) => {
        const da = new Date(a.statementDate || '');
        const db = new Date(b.statementDate || '');
        return (isNaN(da.getTime()) ? 0 : da.getTime()) - (isNaN(db.getTime()) ? 0 : db.getTime());
      });

      const propertyName         = acctItems[0]?.propertyName || '';
      const accountName          = acctItems[0]?.accountName  || '';
      const displayAccountNumber = acctItems[0]?.accountNumber || accountNumber || '';

      if (!firstAccount) {
        ws.addRow(Array(11).fill(''));
        ws.addRow(Array(11).fill(''));
        ws.addRow(Array(11).fill(''));
      }

      // Row 1: light blue "Property Name" label in col B
      const propRow1 = ws.addRow(['', 'Property Name', '', '', '', '', '', '', '', '', '']);
      propRow1.eachCell((cell, colNum) => {
        cell.border = {};
        if (colNum === 2) { cell.fill = propHeaderFill; cell.font = boldFont; cell.border = allBorders; }
      });

      // Row 2: bold property + account info
      const propRow2 = ws.addRow([
        '',
        propertyName || '',
        displayAccountNumber ? `Account: ${displayAccountNumber}` : '',
        accountName ? `Account Name: ${accountName}` : '',
        '', '', '', '', '', '', '',
      ]);
      propRow2.eachCell((cell, colNum) => {
        cell.border = {};
        if (colNum >= 2 && colNum <= 4) { cell.font = boldFont; cell.border = allBorders; }
      });

      // Row 3: dark blue header (cols B–K)
      const hRow = ws.addRow(['', ...headers]);
      hRow.eachCell((cell, colNum) => {
        if (colNum === 1) { cell.border = {}; return; }
        cell.fill = headerFill; cell.font = headerFont; cell.border = allBorders;
      });
      const headerRn = hRow.number;
      if (firstAccount) sheetHeaderRn = headerRn;

      // Row 4: dark blue anchor row (white text), G/I = 0
      const adjRow = ws.addRow(['', '', '', '', '', '', 0, '', 0, '', '']);
      adjRow.eachCell((cell, colNum) => {
        if (colNum === 1) { cell.border = {}; return; }
        cell.fill   = headerFill;
        cell.font   = { name: 'Arial', size: 10, color: { argb: 'FFFFFFFF' } };
        cell.border = allBorders;
      });

      // Row formula helper
      const applyRowFormulas = (row: ExcelJS.Row, rn: number) => {
        row.getCell(3).numFmt  = blankZeroCurrencyFmt;
        row.getCell(4).numFmt  = blankZeroCurrencyFmt;
        // E (Unadjusted Balance), F (Adjusted Balance), J (Deposits vs. Op Stmt. Diff.) — left empty
        row.getCell(7).numFmt  = blankZeroCurrencyFmt;
        row.getCell(8).value   = { formula: `IFERROR(C${rn}-G${rn},0)` };
        row.getCell(8).numFmt  = currencyFmt;
        row.getCell(9).numFmt  = blankZeroCurrencyFmt;
        row.eachCell((cell, colNum) => {
          if (colNum === 1) { cell.border = {}; return; }
          cell.font = baseFont;
          cell.border = allBorders;
        });
      };

      // Statement date range
      const parsedStatementDates = acctItems
        .map(it => new Date(it.statementDate || ''))
        .filter(d => !isNaN(d.getTime()));
      const lastStatementDate  = parsedStatementDates.length > 0 ? parsedStatementDates[parsedStatementDates.length - 1] : null;
      const firstStatementDate = parsedStatementDates.length > 0 ? parsedStatementDates[0] : null;

      // Gap-fill placeholder rows for months before first statement (within T-12 window)
      if (lastStatementDate && firstStatementDate) {
        const t12StartMonth = lastStatementDate.getMonth() - 11;
        const t12StartYear  = lastStatementDate.getFullYear();
        let curYear  = t12StartYear + Math.floor(t12StartMonth / 12);
        let curMonth = ((t12StartMonth % 12) + 12) % 12;
        while (
          curYear < firstStatementDate.getFullYear() ||
          (curYear === firstStatementDate.getFullYear() && curMonth < firstStatementDate.getMonth())
        ) {
          if (!parsedStatementDates.some(d => d.getMonth() === curMonth && d.getFullYear() === curYear)) {
            const pRow = ws.addRow(['', fmtDate(getEndOfMonth(curYear, curMonth)), '', '', '', '', 0, '', 0, '', '']);
            applyRowFormulas(pRow, pRow.number);
          }
          curMonth++; if (curMonth > 11) { curMonth = 0; curYear++; }
        }
      }

      // Main data rows — one per statement (PDF)
      let sumDeposits = 0, sumWithdrawals = 0;
      let firstDataRn: number | null = null, lastDataRn = 0;

      for (const it of acctItems) {
        const deposits    = it.totalCredits;
        const withdrawals = it.totalDebits;

        sumDeposits    += deposits;
        sumWithdrawals += withdrawals;

        // Format date to end-of-month
        let formattedDate = it.statementDate;
        const parsed = new Date(it.statementDate);
        if (!isNaN(parsed.getTime())) {
          formattedDate = fmtDate(getEndOfMonth(parsed.getFullYear(), parsed.getMonth()));
        }

        const dataRow = ws.addRow(['', formattedDate, deposits || '', withdrawals || '', '', '', 0, '', 0, '', '']);
        const rn = dataRow.number;
        if (firstDataRn === null) firstDataRn = rn;
        lastDataRn = rn;
        applyRowFormulas(dataRow, rn);

        if (formattedDate) {
          const pe = propertyDateMap.get(formattedDate) ?? { deposits: 0, withdrawals: 0 };
          pe.deposits += deposits; pe.withdrawals += withdrawals;
          propertyDateMap.set(formattedDate, pe);

          const ge = globalDateMap.get(formattedDate) ?? { deposits: 0, withdrawals: 0 };
          ge.deposits += deposits; ge.withdrawals += withdrawals;
          globalDateMap.set(formattedDate, ge);
        }
      }

      sheetLastDataRn = lastDataRn;
      firstAccount    = false;

      // Total row
      const totRow = ws.addRow(['', 'Total', sumDeposits || '', sumWithdrawals || '', '', '', '', '', '', '', '']);
      totRow.getCell(3).numFmt = blankZeroCurrencyFmt;
      totRow.getCell(4).numFmt = blankZeroCurrencyFmt;
      totRow.getCell(8).numFmt = currencyFmt;
      totRow.eachCell((cell, colNum) => {
        if (colNum === 1) { cell.border = {}; return; }
        cell.fill = totalFill; cell.font = boldFont; cell.border = allBorders;
      });

      // Average row
      const avgRow = ws.addRow(['', 'Average', '', '', '', '', '', '', '', '', '']);
      avgRow.eachCell((cell, colNum) => {
        if (colNum === 1) { cell.border = {}; return; }
        cell.fill = totalFill; cell.font = boldFont; cell.border = allBorders;
      });
      if (firstDataRn !== null && lastDataRn > 0) {
        avgRow.getCell(3).value  = { formula: `IFERROR(AVERAGEIF(C${firstDataRn}:C${lastDataRn},"<>",C${firstDataRn}:C${lastDataRn}),0)` };
        avgRow.getCell(3).numFmt = blankZeroCurrencyFmt;
        avgRow.getCell(8).value  = { formula: `IFERROR(AVERAGEIF(H${firstDataRn}:H${lastDataRn},"<>0",H${firstDataRn}:H${lastDataRn}),0)` };
        avgRow.getCell(8).numFmt = currencyFmt;
      }
    }); // end accountMap.forEach

    let trailingRefRow = sheetLastDataRn;
    if (isMultipleAccounts) {
      const rollup = addRollupTable(ws, propertyKey, headers, propertyDateMap, false);
      trailingRefRow = rollup.lastDataRn;
    }

    addTrailingTable(ws, trailingRefRow, sheetHeaderRn);
    clearOutsideBorders(ws);

    ws.getColumn(1).width = 4;
    for (let i = 2; i <= 11; i++) ws.getColumn(i).width = 22;
  }); // end groupedByProperty.forEach

  if (shouldCreateRollup && rollupSheet) {
    const { lastDataRn: rollupLastDataRn, headerRn: rollupHeaderRn } =
      addRollupTable(rollupSheet, 'All Properties', headers, globalDateMap, true);
    addTrailingTable(rollupSheet, rollupLastDataRn, rollupHeaderRn);
    clearOutsideBorders(rollupSheet);
    rollupSheet.getColumn(1).width = 4;
    for (let i = 2; i <= 11; i++) rollupSheet.getColumn(i).width = 22;
  }

  const buffer = await wb.xlsx.writeBuffer();
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const filename = `Pexl_${baseFilename.replace(/\s+/g, '')}_${dateStr}.xlsx`;
  saveAs(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
};
