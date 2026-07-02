import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';
import type { ExtractedRow } from '@/types/utilscraper';

// ─── Constants ───────────────────────────────────────────────────────────────

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

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ─── Fills ───────────────────────────────────────────────────────────────────

const greenHeaderFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD8E4BC' } };
const navyFill:        ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F497D' } };
const orangeFill:      ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFABF8F' } };
const yellowFill:      ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
const whiteFill:       ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };

// ─── Borders ─────────────────────────────────────────────────────────────────

const thin:   Partial<ExcelJS.Border> = { style: 'thin',   color: { argb: 'FF000000' } };
const medium: Partial<ExcelJS.Border> = { style: 'medium', color: { argb: 'FF000000' } };

// boldLeftCols: columns that always get a medium left border (visual separators)
function blockBorder(
  r: number, c: number,
  startRow: number, endRow: number,
  startCol: number, endCol: number,
  boldLeftCols: Set<number> = new Set(),
): Partial<ExcelJS.Borders> {
  return {
    top:    r === startRow ? medium : thin,
    bottom: r === endRow   ? medium : thin,
    left:   (c === startCol || boldLeftCols.has(c)) ? medium : thin,
    right:  c === endCol   ? medium : thin,
  };
}

function applyBlockBorders(
  ws: ExcelJS.Worksheet,
  startRow: number, endRow: number,
  startCol: number, endCol: number,
  boldLeftCols: Set<number> = new Set(),
) {
  for (let r = startRow; r <= endRow; r++) {
    for (let c = startCol; c <= endCol; c++) {
      ws.getCell(r, c).border = blockBorder(r, c, startRow, endRow, startCol, endCol, boldLeftCols);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const colLetter = (n: number): string => {
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
};

function parseDateValue(raw: string): Date | null {
  if (!raw) return null;
  const mdy = raw.match(/^\s*(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\s*$/);
  if (mdy) {
    const mm = parseInt(mdy[1], 10);
    const dd = parseInt(mdy[2], 10);
    let   yy = parseInt(mdy[3], 10);
    if (yy < 100) yy += yy < 50 ? 2000 : 1900;
    const d = new Date(Date.UTC(yy, mm - 1, dd));
    if (!isNaN(d.getTime())) return d;
  }
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Convert a date string to a YYYY-MM month key used to bucket bills into
 * timeline columns.
 *
 * Two modes:
 *  - ``adjustToPeriod=true`` (default, for ``billing_date``): bills dated
 *    before the 15th roll into the *previous* month, because utility
 *    bills usually cover most of the period before their issue date.
 *  - ``adjustToPeriod=false`` (for the explicit ``date`` field): take the
 *    month off the date as-is. The user wants the date to land in the
 *    month it actually names, with no inference about service period.
 */
function billDateToMonthKey(dateStr: string, adjustToPeriod: boolean = true): string | null {
  const d = parseDateValue(dateStr);
  if (!d) return null;
  let m = d.getUTCMonth();
  let y = d.getUTCFullYear();
  if (adjustToPeriod && d.getUTCDate() < 15) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}

function monthKeyLabel(key: string): string {
  const [y, m] = key.split('-');
  return `${MONTH_NAMES[parseInt(m, 10) - 1]}-${y.slice(2)}`;
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) { if (v) counts.set(v, (counts.get(v) ?? 0) + 1); }
  let best = '', bestN = 0;
  for (const [v, n] of counts) { if (n > bestN) { best = v; bestN = n; } }
  return best;
}

// ─── Types ───────────────────────────────────────────────────────────────────

type TableRow = {
  folder: string; fileName: string;
  provider: string; account: string;
  monthValues:     Map<string, number>;
  monthValuesList: Map<string, number[]>;
  otherCharges:    Map<string, number[]>;
  taxes:           Map<string, number[]>;
};
type UtilityTable = {
  utilityField: string; utilityLabel: string;
  rows: Map<string, TableRow>;
  monthKeys: Set<string>;
  monthScrapedDates: Map<string, Set<string>>;
};
type SheetParams = {
  sortedTables:   UtilityTable[];
  /**
   * Optional list of utility fields to render in the *summary* tables
   * (Utility Bills / Operating Statement / Variance). When omitted,
   * defaults to ``sortedTables`` (existing single-property behavior).
   *
   * For portfolio mode we pass the union of utility fields seen across
   * every property here so each property sheet shows the same set of
   * summary rows — missing fields appear as empty rows on that
   * property's sheet.
   */
  summaryTables?: UtilityTable[];
  sortedMonths:   string[];
  headerProperty: string;
  headerAddress:  string;
  isRecon:        boolean;
};

/**
 * Row positions of summary-table cells inside a built sheet. Used by the
 * portfolio roll-up to create cross-sheet aggregation formulas that point
 * back at each property sheet's Utility Recon page.
 */
type BuildSheetResult = {
  ubRowByField:  Map<string, number>;
  osRowByField:  Map<string, number>;
  varRowByField: Map<string, number>;
  ubTotalRow:    number;
  osTotalRow:    number;
  varTotalRow:   number;
};

// ─── Sheet builder (called once per output sheet) ────────────────────────────

function buildSheet(wb: ExcelJS.Workbook, sheetName: string, p: SheetParams): BuildSheetResult {
  const { sortedTables, sortedMonths, headerProperty, headerAddress, isRecon } = p;
  // For single-property exports this is the same list as sortedTables, so
  // behavior is byte-identical. Portfolio exports pass the union of utility
  // fields seen across the whole portfolio so every per-property sheet has
  // matching summary rows.
  const summaryTables = p.summaryTables ?? sortedTables;

  // Recon: B=UtilityItems, C=Provider, D=Account (FIXED_COLS=4)
  // Raw:   B=Folder, C=File, D=UtilityItems, E=Provider, F=Account (FIXED_COLS=6)
  const FIXED_COLS      = isRecon ? 4 : 6;
  const MONTH_COUNT     = sortedMonths.length;
  const TOTAL_COL       = FIXED_COLS + MONTH_COUNT + 1;
  const COMMENTS_COL    = TOTAL_COL + 1;
  const LAST_COL        = COMMENTS_COL;
  const utilityItemsCol = isRecon ? 2 : 4;
  const providerCol     = isRecon ? 3 : 5;
  const accountCol      = isRecon ? 4 : 6;

  // Total and Comments columns always get a bold (medium) left border
  const boldLeftSet = new Set([COMMENTS_COL]);

  const ws = wb.addWorksheet(sheetName);

  ws.views = [{ state: 'frozen', xSplit: 4, ySplit: 6, showGridLines: false, zoomScale: 85 }];

  // ── Column widths ────────────────────────────────────────────────────────────
  ws.getColumn(1).width = 2.5;
  if (isRecon) {
    ws.getColumn(2).width = 30;    // utility items
    ws.getColumn(3).width = 33;    // utility provider
    ws.getColumn(4).width = 23;    // account number
  } else {
    ws.getColumn(2).width = 33.57; // folder path
    ws.getColumn(3).width = 37.71; // file name
    ws.getColumn(4).width = 20;    // utility items
    ws.getColumn(5).width = 24;    // utility provider
    ws.getColumn(6).width = 23;    // account number
  }
  for (let i = 0; i < MONTH_COUNT; i++) ws.getColumn(FIXED_COLS + 1 + i).width = 13.14;
  ws.getColumn(TOTAL_COL).width    = 11.43;
  ws.getColumn(COMMENTS_COL).width = 16.43;

  const G = (row: number, col: number) => ws.getCell(row, col);

  // ── Row 1: Property ───────────────────────────────────────────────────────────
  ws.getRow(1).height = 18.75;
  G(1,2).value = 'Property:';
  G(1,2).font  = { name: 'Calibri', size: 14, bold: true, italic: true, underline: true };
  G(1,3).value = headerProperty;
  G(1,3).font  = { name: 'Calibri', size: 14, bold: true, italic: true, underline: true };

  // ── Row 2: Address + month numbers ───────────────────────────────────────────
  ws.getRow(2).height = 12.75;
  G(2,2).value = 'Address:';
  G(2,2).font  = { name: 'Calibri', size: 10, bold: true, italic: true, underline: true };
  G(2,3).value = headerAddress;
  G(2,3).font  = { name: 'Calibri', size: 10, italic: true, underline: true };
  for (let i = 0; i < MONTH_COUNT; i++) {
    const cell = G(2, FIXED_COLS + 1 + i);
    cell.value     = parseInt(sortedMonths[i].split('-')[1], 10);
    cell.font      = { name: 'Calibri', size: 10 };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  }

  // ── Row 3: full year numbers ─────────────────────────────────────────────────
  ws.getRow(3).height = 12.75;
  for (let i = 0; i < MONTH_COUNT; i++) {
    const cell = G(3, FIXED_COLS + 1 + i);
    cell.value     = parseInt(sortedMonths[i].split('-')[0], 10);
    cell.font      = { name: 'Calibri', size: 10 };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  }

  // ── Row 4: blank ─────────────────────────────────────────────────────────────
  ws.getRow(4).height = 12.75;

  // ── Row 5: bold-bordered decoration ──────────────────────────────────────────
  // Right border at each merged-group boundary: B:C | D (recon) or D:E (raw) | rest
  ws.getRow(5).height = 13.5;
  for (let c = 2; c <= LAST_COL; c++) {
    G(5, c).border = {
      top: medium, bottom: medium,
      left:  c === 2 ? medium : undefined,
      right: medium,
    };
  }
  ws.mergeCells('B5:C5');
  if (isRecon) {
    if (LAST_COL >= 5) ws.mergeCells(5, 5, 5, LAST_COL);
  } else {
    ws.mergeCells('D5:E5');
    if (LAST_COL >= 6) ws.mergeCells(5, 6, 5, LAST_COL);
  }

  // ── Row 6: column headers — all green ────────────────────────────────────────
  ws.getRow(6).height = 16.5;
  const hdrLabels: [number, string][] = isRecon
    ? [[2, 'Utility Items'], [3, 'Utility Provider'], [4, 'Account Number']]
    : [[2, 'Folder Path'], [3, 'File Name'], [4, 'Utility Items'], [5, 'Utility Provider'], [6, 'Account Number']];

  for (const [c, label] of hdrLabels) {
    const cell = G(6, c);
    cell.value     = label;
    cell.fill      = greenHeaderFill;
    cell.font      = { name: 'Calibri', size: 12, bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  }
  for (let i = 0; i < MONTH_COUNT; i++) {
    const cell = G(6, FIXED_COLS + 1 + i);
    cell.value     = monthKeyLabel(sortedMonths[i]);
    cell.fill      = greenHeaderFill;
    cell.font      = { name: 'Calibri', size: 12, bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  }
  G(6, TOTAL_COL).value     = 'Total';
  G(6, TOTAL_COL).fill      = greenHeaderFill;
  G(6, TOTAL_COL).font      = { name: 'Calibri', size: 12, bold: true, italic: true };
  G(6, TOTAL_COL).alignment = { horizontal: 'center', vertical: 'middle' };
  G(6, COMMENTS_COL).value     = 'Comments';
  G(6, COMMENTS_COL).fill      = greenHeaderFill;
  G(6, COMMENTS_COL).font      = { name: 'Calibri', size: 12, bold: true };
  G(6, COMMENTS_COL).alignment = { horizontal: 'center', vertical: 'middle' };
  applyBlockBorders(ws, 6, 6, 2, LAST_COL, boldLeftSet);

  ws.autoFilter = { from: { row: 6, column: 2 }, to: { row: 6, column: LAST_COL } };

  // ── Row 7: empty buffer row ───────────────────────────────────────────────────
  ws.getRow(7).height = 12.75;

  // ── Row 8: scraped bill dates (raw data only, orange) ────────────────────────
  if (!isRecon) {
    ws.getRow(8).height = 13.5;
    const allDates = new Map<string, Set<string>>();
    for (const t of sortedTables) {
      for (const [mk, dateSet] of t.monthScrapedDates) {
        if (!allDates.has(mk)) allDates.set(mk, new Set());
        for (const d of dateSet) allDates.get(mk)!.add(d);
      }
    }
    for (let c = 2; c <= LAST_COL; c++) {
      G(8, c).fill = orangeFill;
      G(8, c).font = { name: 'Calibri', size: 10 };
    }
    G(8, utilityItemsCol).value = 'Bill Dates';
    G(8, utilityItemsCol).font  = { name: 'Calibri', size: 10, bold: true };
    for (let i = 0; i < MONTH_COUNT; i++) {
      const mk    = sortedMonths[i];
      const dates = allDates.get(mk);
      const cell  = G(8, FIXED_COLS + 1 + i);
      cell.value     = dates && dates.size > 0 ? Array.from(dates).sort().join(' · ') : '';
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    }
    // Box the entire date row with the same thin/medium border treatment
    // used elsewhere — without this the orange band runs edge-to-edge
    // with no visual separation.
    applyBlockBorders(ws, 8, 8, 2, LAST_COL, boldLeftSet);
  }

  // ── Per-utility-type data tables ──────────────────────────────────────────────
  // Iterate ``summaryTables`` (= globalSortedTables in portfolio mode,
  // sortedTables in single-property mode). For each utility field we look
  // up the *local* data table; if this sheet has no bills for that field
  // we still render a "shell" orange table — header, an empty data row,
  // and an empty Total row — so all property sheets in a portfolio line
  // up with the same set of utility tables in the same order.
  const tableTotalRows = new Map<string, number>();
  let currentRow = isRecon ? 8 : 9;

  const localTablesByField = new Map<string, UtilityTable>();
  for (const t of sortedTables) localTablesByField.set(t.utilityField, t);

  for (const table of summaryTables) {
    // Use only THIS property's rows for the orange table — globalSortedTables
    // contains rows pooled from every property, which would leak other
    // properties' bills onto this sheet if used directly. When the local
    // map has no entry for this field, sortedRows is just empty and the
    // table renders as a labelled shell with no data row.
    const localTable = localTablesByField.get(table.utilityField);
    const sortedRows = localTable
      ? Array.from(localTable.rows.values()).sort((a, b) =>
          a.provider !== b.provider
            ? a.provider.localeCompare(b.provider)
            : a.account.localeCompare(b.account),
        )
      : [];

    const tableStartRow = currentRow;

    // Sub-header row: raw data only — section divider with utility label
    if (!isRecon) {
      ws.getRow(currentRow).height = 13.5;
      for (let c = 2; c <= LAST_COL; c++) {
        G(currentRow, c).fill = whiteFill;
        G(currentRow, c).font = { name: 'Calibri', size: 10 };
      }
      G(currentRow, utilityItemsCol).value = table.utilityLabel;
      G(currentRow, utilityItemsCol).font  = { name: 'Calibri', size: 10, bold: true };
      currentRow++;
    }

    // Extra group label row (recon only): utility label bolded, orange only on utility items → provider
    if (isRecon) {
      ws.getRow(currentRow).height = 12.75;
      for (let c = 2; c <= LAST_COL; c++) {
        G(currentRow, c).fill = (c >= utilityItemsCol && c <= providerCol) ? orangeFill : whiteFill;
        G(currentRow, c).font = { name: 'Calibri', size: 10 };
      }
      G(currentRow, utilityItemsCol).value = table.utilityLabel;
      G(currentRow, utilityItemsCol).font  = { name: 'Calibri', size: 10, bold: true };
      currentRow++;
    }

    // Data rows
    // Recon: month cell = bills + otherCharges + taxes combined (one formula/value)
    // Raw:   month cell = bills only; sub-rows show otherCharges / taxes with breakdown
    const dataBlockStart = currentRow;
    for (const row of sortedRows) {
      ws.getRow(currentRow).height = isRecon ? 12.75 : 13.5;
      if (!isRecon) {
        G(currentRow, 2).value = row.folder;
        G(currentRow, 3).value = row.fileName;
      }
      G(currentRow, utilityItemsCol).value = table.utilityLabel;
      G(currentRow, providerCol).value     = row.provider;
      G(currentRow, accountCol).value      = row.account;
      for (let c = 2; c <= FIXED_COLS; c++) {
        G(currentRow, c).fill = (isRecon && c >= utilityItemsCol && c <= providerCol) ? orangeFill : whiteFill;
        G(currentRow, c).font = { name: 'Calibri', size: 10, bold: !isRecon && c === 4 };
        const isCenter = (c === providerCol || c === accountCol);
        G(currentRow, c).alignment = { horizontal: isCenter ? 'center' : 'left', vertical: 'middle' };
      }
      for (let i = 0; i < MONTH_COUNT; i++) {
        const mk      = sortedMonths[i];
        const cell    = G(currentRow, FIXED_COLS + 1 + i);
        const bills   = row.monthValuesList.get(mk) ?? [];
        const oc      = isRecon ? (row.otherCharges.get(mk) ?? []) : [];
        const tax     = isRecon ? (row.taxes.get(mk)        ?? []) : [];
        const allVals = [...bills, ...oc, ...tax];
        if (allVals.length > 1) {
          cell.value  = { formula: allVals.map(n => n.toFixed(2)).join('+'), result: allVals.reduce((a, b) => a + b, 0) };
          cell.numFmt = '"$"#,##0.00';
        } else if (allVals.length === 1) {
          cell.value  = allVals[0];
          cell.numFmt = '"$"#,##0.00';
        }
        cell.fill      = (isRecon && allVals.length > 1) ? yellowFill : whiteFill;
        cell.font      = { name: 'Calibri', size: 10 };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      }
      if (MONTH_COUNT > 0) {
        const tc = G(currentRow, TOTAL_COL);
        tc.value   = { formula: `SUM(${colLetter(FIXED_COLS+1)}${currentRow}:${colLetter(FIXED_COLS+MONTH_COUNT)}${currentRow})` };
        tc.numFmt  = '"$"#,##0.00';
        tc.fill    = whiteFill;
        tc.font    = { name: 'Calibri', size: 10, bold: true };
        tc.alignment = { horizontal: 'center', vertical: 'middle' };
      }
      G(currentRow, COMMENTS_COL).fill = whiteFill;
      G(currentRow, COMMENTS_COL).font = { name: 'Calibri', size: 10 };
      currentRow++;

      // Other Charges / Taxes sub-rows (raw data only)
      if (!isRecon) {
        for (const [subLabel, subList] of [['Other Charges', row.otherCharges], ['Taxes', row.taxes]] as [string, Map<string, number[]>][]) {
          if (subList.size === 0) continue;
          ws.getRow(currentRow).height = 13.5;
          for (let c = 2; c <= LAST_COL; c++) {
            G(currentRow, c).fill = whiteFill;
            G(currentRow, c).font = { name: 'Calibri', size: 10, italic: true };
          }
          G(currentRow, utilityItemsCol).value     = `  ${subLabel}`;
          G(currentRow, utilityItemsCol).alignment = { horizontal: 'left', vertical: 'middle' };
          for (let i = 0; i < MONTH_COUNT; i++) {
            const mk   = sortedMonths[i];
            const vals = subList.get(mk);
            if (vals && vals.length > 0) {
              const cell = G(currentRow, FIXED_COLS + 1 + i);
              if (vals.length > 1) {
                cell.value = { formula: vals.map(n => n.toFixed(2)).join('+'), result: vals.reduce((a, b) => a + b, 0) };
              } else {
                cell.value = vals[0];
              }
              cell.numFmt    = '"$"#,##0.00';
              cell.fill      = whiteFill;
              cell.font      = { name: 'Calibri', size: 10, italic: true };
              cell.alignment = { horizontal: 'center', vertical: 'middle' };
            }
          }
          if (MONTH_COUNT > 0) {
            const tc     = G(currentRow, TOTAL_COL);
            tc.value     = { formula: `SUM(${colLetter(FIXED_COLS+1)}${currentRow}:${colLetter(FIXED_COLS+MONTH_COUNT)}${currentRow})` };
            tc.numFmt    = '"$"#,##0.00';
            tc.fill      = whiteFill;
            tc.font      = { name: 'Calibri', size: 10, italic: true };
            tc.alignment = { horizontal: 'center', vertical: 'middle' };
          }
          currentRow++;
        }
      }
    }
    const dataBlockEnd = currentRow - 1;
    // Spacer row — same height as data rows
    ws.getRow(currentRow).height = isRecon ? 12.75 : 13.5;
    for (let c = 2; c <= FIXED_COLS;         c++) G(currentRow, c).fill = (isRecon && c >= utilityItemsCol && c <= providerCol) ? orangeFill : whiteFill;
    for (let c = FIXED_COLS + 1; c <= LAST_COL; c++) G(currentRow, c).fill = whiteFill;
    currentRow++;

    // Total row
    ws.getRow(currentRow).height = isRecon ? 12.75 : 13.5;
    G(currentRow, utilityItemsCol).value = `Total ${table.utilityLabel}`;
    for (let c = 2; c <= LAST_COL; c++) {
      G(currentRow, c).font = { name: 'Calibri', size: 10, bold: true };
    }
    if (sortedRows.length > 0) {
      for (let i = 0; i < MONTH_COUNT; i++) {
        const L    = colLetter(FIXED_COLS + 1 + i);
        const cell = G(currentRow, FIXED_COLS + 1 + i);
        cell.value  = { formula: `SUM(${L}${dataBlockStart}:${L}${dataBlockEnd})` };
        cell.numFmt = '"$"#,##0.00';
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      }
      if (MONTH_COUNT > 0) {
        const L  = colLetter(TOTAL_COL);
        const tc = G(currentRow, TOTAL_COL);
        tc.value  = { formula: `SUM(${L}${dataBlockStart}:${L}${dataBlockEnd})` };
        tc.numFmt = '"$"#,##0.00';
        tc.alignment = { horizontal: 'center', vertical: 'middle' };
      }
    }
    tableTotalRows.set(table.utilityField, currentRow);
    const tableEndRow = currentRow;
    currentRow++;

    applyBlockBorders(ws, tableStartRow, tableEndRow, 2, LAST_COL, boldLeftSet);
    currentRow += 1;  // 1 gap row between orange tables
  }

  // 1 extra gap row so total gap between last orange table and first summary table = 2
  currentRow += 1;

  // ── Three summary tables: Utility Bills / Operating Statement / Variance ──────
  const monthLabels = sortedMonths.map(mk => monthKeyLabel(mk));
  type Section = 'Utility Bills' | 'Operating Statement' | 'Variance';
  const sections: Section[] = ['Utility Bills', 'Operating Statement', 'Variance'];

  const ubRows:  Map<string, number> = new Map();
  const osRows:  Map<string, number> = new Map();
  const varRows: Map<string, number> = new Map();
  let ubTotalRow  = 0;
  let osTotalRow  = 0;
  let varTotalRow = 0;

  // Variance cells use red-bracket format for negatives
  const varFmt = '"$"#,##0.00;[Red]("$"#,##0.00)';

  for (let si = 0; si < sections.length; si++) {
    const section      = sections[si];
    const summaryStart = currentRow;
    const isVariance   = section === 'Variance';

    // Header row: 12.75 height, size 10; recon=blue/green split, raw=all navy; Comments col no fill
    ws.getRow(currentRow).height = 12.75;
    for (let c = 2; c <= LAST_COL; c++) {
      if (c === COMMENTS_COL || (isRecon && c === accountCol)) {
        G(currentRow, c).fill = whiteFill;
        G(currentRow, c).font = { name: 'Calibri', size: 10, bold: true };
        G(currentRow, c).alignment = { horizontal: 'center', vertical: 'middle' };
        continue;
      }
      const isNavy = !isRecon || (c === utilityItemsCol || c === providerCol);
      G(currentRow, c).fill      = isNavy ? navyFill : greenHeaderFill;
      G(currentRow, c).font      = {
        name: 'Calibri', size: 10, bold: true,
        color: { argb: isNavy ? 'FFFFFFFF' : 'FF000000' },
      };
      G(currentRow, c).alignment = { horizontal: c > FIXED_COLS ? 'center' : 'left', vertical: 'middle' };
    }
    G(currentRow, 2).value = section;
    for (let i = 0; i < MONTH_COUNT; i++) G(currentRow, FIXED_COLS + 1 + i).value = monthLabels[i];
    G(currentRow, TOTAL_COL).value = 'Total';
    currentRow++;

    // Per-utility rows. Loop summaryTables (= globalTables in portfolio
    // mode, sortedTables otherwise) so portfolio property sheets show a
    // matching row for every global utility — empty when this property
    // has no bills for that utility.
    for (const table of summaryTables) {
      ws.getRow(currentRow).height = 12.75;
      for (let c = 2; c <= LAST_COL; c++) G(currentRow, c).font = { name: 'Calibri', size: 10 };
      G(currentRow, utilityItemsCol).value = table.utilityLabel;

      if (section === 'Utility Bills') {
        const mainRow = tableTotalRows.get(table.utilityField);
        if (mainRow !== undefined) {
          for (let i = 0; i < MONTH_COUNT; i++) {
            const L    = colLetter(FIXED_COLS + 1 + i);
            const cell = G(currentRow, FIXED_COLS + 1 + i);
            cell.value  = { formula: `${L}${mainRow}` };
            cell.numFmt = '"$"#,##0.00';
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
          }
          const tc = G(currentRow, TOTAL_COL);
          tc.value   = { formula: `${colLetter(TOTAL_COL)}${mainRow}` };
          tc.numFmt  = '"$"#,##0.00';
          tc.alignment = { horizontal: 'center', vertical: 'middle' };
        }
        ubRows.set(table.utilityField, currentRow);

      } else if (section === 'Operating Statement') {
        for (let i = 0; i < MONTH_COUNT; i++) {
          G(currentRow, FIXED_COLS + 1 + i).numFmt    = '"$"#,##0.00';
          G(currentRow, FIXED_COLS + 1 + i).alignment = { horizontal: 'center', vertical: 'middle' };
        }
        G(currentRow, TOTAL_COL).numFmt    = '"$"#,##0.00';
        G(currentRow, TOTAL_COL).alignment = { horizontal: 'center', vertical: 'middle' };
        osRows.set(table.utilityField, currentRow);

      } else {
        const ubR = ubRows.get(table.utilityField);
        const osR = osRows.get(table.utilityField);
        if (ubR !== undefined && osR !== undefined) {
          for (let i = 0; i < MONTH_COUNT; i++) {
            const L    = colLetter(FIXED_COLS + 1 + i);
            const cell = G(currentRow, FIXED_COLS + 1 + i);
            cell.value  = { formula: `${L}${osR}-${L}${ubR}` };
            cell.numFmt = varFmt;
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
          }
          const L  = colLetter(TOTAL_COL);
          const tc = G(currentRow, TOTAL_COL);
          tc.value  = { formula: `${L}${osR}-${L}${ubR}` };
          tc.numFmt = varFmt;
          tc.alignment = { horizontal: 'center', vertical: 'middle' };
        }
        varRows.set(table.utilityField, currentRow);
      }
      currentRow++;
    }

    // Total Utilities row — bold, NOT italic, 12.75 height
    ws.getRow(currentRow).height = 12.75;
    for (let c = 2; c <= LAST_COL; c++) {
      G(currentRow, c).font = { name: 'Calibri', size: 10, bold: true };
    }
    G(currentRow, utilityItemsCol).value = 'Total Utilities';
    const perRows = section === 'Utility Bills' ? ubRows : section === 'Operating Statement' ? osRows : varRows;
    const rowNums = Array.from(perRows.values());
    for (let i = 0; i < MONTH_COUNT; i++) {
      const L    = colLetter(FIXED_COLS + 1 + i);
      const cell = G(currentRow, FIXED_COLS + 1 + i);
      if (rowNums.length > 0) cell.value = { formula: rowNums.map(rn => `${L}${rn}`).join('+') };
      cell.numFmt    = isVariance ? varFmt : '"$"#,##0.00';
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    }
    {
      const L  = colLetter(TOTAL_COL);
      const tc = G(currentRow, TOTAL_COL);
      if (rowNums.length > 0) tc.value = { formula: rowNums.map(rn => `${L}${rn}`).join('+') };
      tc.numFmt    = isVariance ? varFmt : '"$"#,##0.00';
      tc.alignment = { horizontal: 'center', vertical: 'middle' };
    }
    const summaryEnd = currentRow;
    if (section === 'Utility Bills')        ubTotalRow  = currentRow;
    else if (section === 'Operating Statement') osTotalRow = currentRow;
    else                                     varTotalRow = currentRow;
    currentRow++;

    applyBlockBorders(ws, summaryStart, summaryEnd, 2, LAST_COL, boldLeftSet);
    if (si < sections.length - 1) currentRow += 1;
  }

  return {
    ubRowByField:  ubRows,
    osRowByField:  osRows,
    varRowByField: varRows,
    ubTotalRow, osTotalRow, varTotalRow,
  };
}

// ─── Roll-up sheet builder (portfolio mode) ──────────────────────────────────

type RollupProperty = {
  /** Exact worksheet name of the property's Utility Recon sheet. */
  sheetName: string;
  /** Row positions returned from that sheet's buildSheet call. */
  result:    BuildSheetResult;
};

/**
 * Render the portfolio Roll-up sheet. Visually identical to a Utility Recon
 * sheet (same column widths, header rows, fills, fonts, borders) but the
 * orange per-utility tables are omitted and the 3 summary tables reference
 * cells on each property sheet via cross-sheet formulas instead of using
 * local table rows.
 *
 * Sheet contents:
 *   • Row 1-6: standard property/address/month header block.
 *   • Row 7  : empty buffer row.
 *   • Row 8+ : the 3 summary tables (Utility Bills / Operating Statement
 *              / Variance), each with one row per global utility field and
 *              a final "Total Utilities" row.
 *
 * Each cell value is a SUM formula across every property's matching cell:
 *   ='Prop A'!K8+'Prop B'!K8+'Prop C'!K8
 * Properties that don't have data for a given utility have an empty cell
 * at that position, which SUM correctly treats as zero — no special
 * handling needed for missing fields.
 */
function buildRollupSheet(
  wb: ExcelJS.Workbook,
  sheetName: string,
  p: {
    summaryTables: UtilityTable[];
    sortedMonths:  string[];
    headerProperty: string;
    headerAddress:  string;
    perProperty:   RollupProperty[];
  },
): void {
  const { summaryTables, sortedMonths, headerProperty, headerAddress, perProperty } = p;

  // Same column layout as the recon sheet (FIXED_COLS = 4).
  const FIXED_COLS      = 4;
  const MONTH_COUNT     = sortedMonths.length;
  const TOTAL_COL       = FIXED_COLS + MONTH_COUNT + 1;
  const COMMENTS_COL    = TOTAL_COL + 1;
  const LAST_COL        = COMMENTS_COL;
  const utilityItemsCol = 2;
  const providerCol     = 3;
  const accountCol      = 4;
  const boldLeftSet     = new Set([COMMENTS_COL]);

  const ws = wb.addWorksheet(sheetName);
  ws.views = [{ state: 'frozen', xSplit: 4, ySplit: 6, showGridLines: false, zoomScale: 85 }];

  // ── Column widths (mirror recon) ─────────────────────────────────────────────
  ws.getColumn(1).width = 2.5;
  ws.getColumn(2).width = 30;
  ws.getColumn(3).width = 33;
  ws.getColumn(4).width = 23;
  for (let i = 0; i < MONTH_COUNT; i++) ws.getColumn(FIXED_COLS + 1 + i).width = 13.14;
  ws.getColumn(TOTAL_COL).width    = 11.43;
  ws.getColumn(COMMENTS_COL).width = 16.43;

  const G = (row: number, col: number) => ws.getCell(row, col);

  // ── Row 1: Property ──────────────────────────────────────────────────────────
  ws.getRow(1).height = 18.75;
  G(1,2).value = 'Property:';
  G(1,2).font  = { name: 'Calibri', size: 14, bold: true, italic: true, underline: true };
  G(1,3).value = headerProperty;
  G(1,3).font  = { name: 'Calibri', size: 14, bold: true, italic: true, underline: true };

  // ── Row 2: Address + month numbers ───────────────────────────────────────────
  ws.getRow(2).height = 12.75;
  G(2,2).value = 'Address:';
  G(2,2).font  = { name: 'Calibri', size: 10, bold: true, italic: true, underline: true };
  G(2,3).value = headerAddress;
  G(2,3).font  = { name: 'Calibri', size: 10, italic: true, underline: true };
  for (let i = 0; i < MONTH_COUNT; i++) {
    const cell = G(2, FIXED_COLS + 1 + i);
    cell.value     = parseInt(sortedMonths[i].split('-')[1], 10);
    cell.font      = { name: 'Calibri', size: 10 };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  }

  // ── Row 3: years ─────────────────────────────────────────────────────────────
  ws.getRow(3).height = 12.75;
  for (let i = 0; i < MONTH_COUNT; i++) {
    const cell = G(3, FIXED_COLS + 1 + i);
    cell.value     = parseInt(sortedMonths[i].split('-')[0], 10);
    cell.font      = { name: 'Calibri', size: 10 };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  }

  // ── Rows 4-5: blank + decoration ─────────────────────────────────────────────
  ws.getRow(4).height = 12.75;
  ws.getRow(5).height = 13.5;
  for (let c = 2; c <= LAST_COL; c++) {
    G(5, c).border = {
      top: medium, bottom: medium,
      left:  c === 2 ? medium : undefined,
      right: medium,
    };
  }
  ws.mergeCells('B5:C5');
  if (LAST_COL >= 5) ws.mergeCells(5, 5, 5, LAST_COL);

  // ── Row 6: green column headers ──────────────────────────────────────────────
  ws.getRow(6).height = 16.5;
  for (const [c, label] of [[2,'Utility Items'],[3,'Utility Provider'],[4,'Account Number']] as [number,string][]) {
    const cell = G(6, c);
    cell.value = label;
    cell.fill  = greenHeaderFill;
    cell.font  = { name: 'Calibri', size: 12, bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  }
  for (let i = 0; i < MONTH_COUNT; i++) {
    const cell = G(6, FIXED_COLS + 1 + i);
    cell.value     = monthKeyLabel(sortedMonths[i]);
    cell.fill      = greenHeaderFill;
    cell.font      = { name: 'Calibri', size: 12, bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  }
  G(6, TOTAL_COL).value = 'Total';
  G(6, TOTAL_COL).fill  = greenHeaderFill;
  G(6, TOTAL_COL).font  = { name: 'Calibri', size: 12, bold: true, italic: true };
  G(6, TOTAL_COL).alignment = { horizontal: 'center', vertical: 'middle' };
  G(6, COMMENTS_COL).value = 'Comments';
  G(6, COMMENTS_COL).fill  = greenHeaderFill;
  G(6, COMMENTS_COL).font  = { name: 'Calibri', size: 12, bold: true };
  G(6, COMMENTS_COL).alignment = { horizontal: 'center', vertical: 'middle' };
  applyBlockBorders(ws, 6, 6, 2, LAST_COL, boldLeftSet);
  ws.autoFilter = { from: { row: 6, column: 2 }, to: { row: 6, column: LAST_COL } };

  // ── Row 7: empty buffer ──────────────────────────────────────────────────────
  ws.getRow(7).height = 12.75;
  let currentRow = 8;

  // ── 3 summary tables with cross-sheet aggregation formulas ──────────────────
  const monthLabels = sortedMonths.map(mk => monthKeyLabel(mk));
  type Section = 'Utility Bills' | 'Operating Statement' | 'Variance';
  const sections: Section[] = ['Utility Bills', 'Operating Statement', 'Variance'];
  const varFmt = '"$"#,##0.00;[Red]("$"#,##0.00)';

  // Build a cross-sheet SUM formula for a given utility row across all
  // properties. Returns an empty string if no property contributed a row
  // for this field (which means we leave the cell blank).
  const sumAcross = (rowGetter: (r: BuildSheetResult) => number | undefined, colL: string): string => {
    const parts: string[] = [];
    for (const prop of perProperty) {
      const row = rowGetter(prop.result);
      if (row !== undefined && row > 0) {
        // Single-quote the sheet name only if it contains spaces or non-word chars.
        const ref = /[^A-Za-z0-9_]/.test(prop.sheetName)
          ? `'${prop.sheetName.replace(/'/g, "''")}'!${colL}${row}`
          : `${prop.sheetName}!${colL}${row}`;
        parts.push(ref);
      }
    }
    return parts.length ? parts.join('+') : '';
  };

  for (let si = 0; si < sections.length; si++) {
    const section = sections[si];
    const summaryStart = currentRow;
    const isVariance = section === 'Variance';

    // Header row
    ws.getRow(currentRow).height = 12.75;
    for (let c = 2; c <= LAST_COL; c++) {
      if (c === COMMENTS_COL || c === accountCol) {
        G(currentRow, c).fill = whiteFill;
        G(currentRow, c).font = { name: 'Calibri', size: 10, bold: true };
        G(currentRow, c).alignment = { horizontal: 'center', vertical: 'middle' };
        continue;
      }
      const isNavy = (c === utilityItemsCol || c === providerCol);
      G(currentRow, c).fill      = isNavy ? navyFill : greenHeaderFill;
      G(currentRow, c).font      = {
        name: 'Calibri', size: 10, bold: true,
        color: { argb: isNavy ? 'FFFFFFFF' : 'FF000000' },
      };
      G(currentRow, c).alignment = { horizontal: c > FIXED_COLS ? 'center' : 'left', vertical: 'middle' };
    }
    G(currentRow, 2).value = section;
    for (let i = 0; i < MONTH_COUNT; i++) G(currentRow, FIXED_COLS + 1 + i).value = monthLabels[i];
    G(currentRow, TOTAL_COL).value = 'Total';
    currentRow++;

    // Per-utility rows
    const sectionRows = new Map<string, number>();
    for (const table of summaryTables) {
      ws.getRow(currentRow).height = 12.75;
      for (let c = 2; c <= LAST_COL; c++) G(currentRow, c).font = { name: 'Calibri', size: 10 };
      G(currentRow, utilityItemsCol).value = table.utilityLabel;

      const rowGetter =
        section === 'Utility Bills'        ? (r: BuildSheetResult) => r.ubRowByField.get(table.utilityField)
        : section === 'Operating Statement' ? (r: BuildSheetResult) => r.osRowByField.get(table.utilityField)
        :                                     (r: BuildSheetResult) => r.varRowByField.get(table.utilityField);

      for (let i = 0; i < MONTH_COUNT; i++) {
        const colL = colLetter(FIXED_COLS + 1 + i);
        const formula = sumAcross(rowGetter, colL);
        const cell = G(currentRow, FIXED_COLS + 1 + i);
        if (formula) cell.value = { formula };
        cell.numFmt    = isVariance ? varFmt : '"$"#,##0.00';
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      }
      {
        const colL = colLetter(TOTAL_COL);
        const formula = sumAcross(rowGetter, colL);
        const tc = G(currentRow, TOTAL_COL);
        if (formula) tc.value = { formula };
        tc.numFmt    = isVariance ? varFmt : '"$"#,##0.00';
        tc.alignment = { horizontal: 'center', vertical: 'middle' };
      }
      sectionRows.set(table.utilityField, currentRow);
      currentRow++;
    }

    // Total Utilities row — sum across properties of each property's section total
    ws.getRow(currentRow).height = 12.75;
    for (let c = 2; c <= LAST_COL; c++) G(currentRow, c).font = { name: 'Calibri', size: 10, bold: true };
    G(currentRow, utilityItemsCol).value = 'Total Utilities';

    const totalRowGetter =
      section === 'Utility Bills'        ? (r: BuildSheetResult) => r.ubTotalRow
      : section === 'Operating Statement' ? (r: BuildSheetResult) => r.osTotalRow
      :                                     (r: BuildSheetResult) => r.varTotalRow;

    for (let i = 0; i < MONTH_COUNT; i++) {
      const colL = colLetter(FIXED_COLS + 1 + i);
      const formula = sumAcross(totalRowGetter, colL);
      const cell = G(currentRow, FIXED_COLS + 1 + i);
      if (formula) cell.value = { formula };
      cell.numFmt    = isVariance ? varFmt : '"$"#,##0.00';
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    }
    {
      const colL = colLetter(TOTAL_COL);
      const formula = sumAcross(totalRowGetter, colL);
      const tc = G(currentRow, TOTAL_COL);
      if (formula) tc.value = { formula };
      tc.numFmt    = isVariance ? varFmt : '"$"#,##0.00';
      tc.alignment = { horizontal: 'center', vertical: 'middle' };
    }

    const summaryEnd = currentRow;
    currentRow++;

    applyBlockBorders(ws, summaryStart, summaryEnd, 2, LAST_COL, boldLeftSet);
    if (si < sections.length - 1) currentRow += 1;
  }
}

// ─── Main export function ─────────────────────────────────────────────────────

/** Which scraped field decides the month a bill lands under. */
export type UtilityDateField = 'billing_date' | 'date' | 'auto';

export async function downloadUtilityExcel(
  fileMap: Map<string, ExtractedRow[]>,
  /**
   * Controls how each page is bucketed into a month column.
   *  - ``'billing_date'``: use scraped ``billing_date`` with the
   *    before-the-15th roll-back rule (existing default).
   *  - ``'date'``: use scraped ``date`` with no day adjustment — the
   *    month named on the date is the month the bill lands under.
   *  - ``'auto'`` (default): use ``billing_date`` when present anywhere
   *    in the data; otherwise fall back to ``date`` with no adjustment.
   */
  dateField: UtilityDateField = 'auto',
): Promise<void> {

  // ── Decide which scraped field to consult for each page ─────────────────────
  // For 'auto', look at the whole dataset once: if anything has billing_date
  // we use that across the board; otherwise we fall back to 'date'.
  const allRows = Array.from(fileMap.values()).flat();
  const anyBilling = allRows.some(r => r.field === 'billing_date' && r.value);
  let effectiveField: 'billing_date' | 'date';
  if      (dateField === 'billing_date') effectiveField = 'billing_date';
  else if (dateField === 'date')         effectiveField = 'date';
  else                                    effectiveField = anyBilling ? 'billing_date' : 'date';
  const adjustToPeriod = effectiveField === 'billing_date';

  const monthKeyFor = (vals: Record<string, string>): string => {
    const raw = vals[effectiveField];
    if (!raw) return '';
    return billDateToMonthKey(raw, adjustToPeriod) ?? '';
  };
  const rawDateFor = (vals: Record<string, string>): string =>
    (vals[effectiveField] ?? '').trim();

  // ── Step 1: collect per-page data with carry-forward provider/account ─────────
  type PageData = {
    fileNum: number; folder: string; fileName: string; page: number;
    provider: string; account: string; property: string; address: string;
    monthKey: string; fieldValues: Record<string, string>;
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
    let lastProvider = '', lastAccount = '', lastProperty = '', lastAddress = '';
    for (const page of Array.from(byPage.keys()).sort((a, b) => a - b)) {
      const vals = byPage.get(page)!;
      if (vals.provider_name)  lastProvider = vals.provider_name;
      if (vals.account_number) lastAccount  = vals.account_number;
      if (vals.property_name)  lastProperty = vals.property_name;
      if (vals.address)        lastAddress  = vals.address;
      pages.push({
        fileNum: pdfNum, folder, fileName: cleanedFilename, page,
        provider: lastProvider, account: lastAccount,
        property: lastProperty, address: lastAddress,
        monthKey: monthKeyFor(vals),
        fieldValues: vals,
      });
    }
  }

  // ── Step 2: representative property + address ─────────────────────────────────
  const headerProperty = mostCommon(pages.map(p => p.property).filter(Boolean));
  const headerAddress  = mostCommon(pages.map(p => p.address ).filter(Boolean));

  // ── Step 3: build per-utility-type tables ─────────────────────────────────────
  type TableRowL = {
    folder: string; fileName: string; provider: string; account: string;
    monthValues:     Map<string, number>;
    monthValuesList: Map<string, number[]>;
    otherCharges:    Map<string, number[]>;
    taxes:           Map<string, number[]>;
  };
  type UtilityTableL = {
    utilityField: string; utilityLabel: string;
    rows: Map<string, TableRowL>;
    monthKeys: Set<string>;
    monthScrapedDates: Map<string, Set<string>>;
  };

  /** Build the {tables, sortedMonths, sortedTables} bundle for a subset of pages. */
  const buildTablesFor = (pagesSubset: PageData[]) => {
    const tables = new Map<string, UtilityTableL>();
    for (const pg of pagesSubset) {
      for (const [field, label] of Object.entries(UTILITY_TOTAL_FIELDS)) {
        const raw = pg.fieldValues[field];
        if (!raw) continue;
        const num = parseFloat(raw.replace(/[$,\s]/g, ''));
        if (isNaN(num)) continue;
        let table = tables.get(field);
        if (!table) {
          table = { utilityField: field, utilityLabel: label, rows: new Map(), monthKeys: new Set(), monthScrapedDates: new Map() };
          tables.set(field, table);
        }
        const rowKey = `${pg.provider}__${pg.account || pg.fileName}`;
        let tr = table.rows.get(rowKey);
        if (!tr) {
          tr = { folder: pg.folder, fileName: pg.fileName, provider: pg.provider, account: pg.account, monthValues: new Map(), monthValuesList: new Map(), otherCharges: new Map(), taxes: new Map() };
          table.rows.set(rowKey, tr);
        } else {
          if (!tr.folder && pg.folder) tr.folder = pg.folder;
          if (tr.fileName !== pg.fileName && !tr.fileName.split(' · ').includes(pg.fileName))
            tr.fileName = `${tr.fileName} · ${pg.fileName}`;
        }
        if (pg.monthKey) {
          tr.monthValues.set(pg.monthKey, (tr.monthValues.get(pg.monthKey) ?? 0) + num);
          if (!tr.monthValuesList.has(pg.monthKey)) tr.monthValuesList.set(pg.monthKey, []);
          tr.monthValuesList.get(pg.monthKey)!.push(num);
          table.monthKeys.add(pg.monthKey);
          const ocRaw  = pg.fieldValues['other_charges'];
          if (ocRaw)  { const v = parseFloat(ocRaw.replace(/[$,\s]/g,  '')); if (!isNaN(v)) { if (!tr.otherCharges.has(pg.monthKey)) tr.otherCharges.set(pg.monthKey, []); tr.otherCharges.get(pg.monthKey)!.push(v); } }
          const taxRaw = pg.fieldValues['taxes'];
          if (taxRaw) { const v = parseFloat(taxRaw.replace(/[$,\s]/g, '')); if (!isNaN(v)) { if (!tr.taxes.has(pg.monthKey)) tr.taxes.set(pg.monthKey, []); tr.taxes.get(pg.monthKey)!.push(v); } }
          // Use whichever date field the user selected so the
          // "Bill Dates" row in Raw Data matches the bucketing logic.
          const rawDate = rawDateFor(pg.fieldValues);
          if (rawDate) {
            if (!table.monthScrapedDates.has(pg.monthKey)) table.monthScrapedDates.set(pg.monthKey, new Set());
            table.monthScrapedDates.get(pg.monthKey)!.add(rawDate);
          }
        }
      }
    }
    const utilityOrder = Object.keys(UTILITY_TOTAL_FIELDS);
    const sortedTables = Array.from(tables.values()).sort(
      (a, b) => utilityOrder.indexOf(a.utilityField) - utilityOrder.indexOf(b.utilityField),
    );
    return { tables, sortedTables };
  };

  // ── Step 4: group pages by property; if 2+ properties → portfolio mode ───────
  const pagesByProperty = new Map<string, PageData[]>();
  for (const pg of pages) {
    const key = (pg.property || '').trim() || 'Unknown Property';
    if (!pagesByProperty.has(key)) pagesByProperty.set(key, []);
    pagesByProperty.get(key)!.push(pg);
  }

  const propertyNames = Array.from(pagesByProperty.keys());
  const isPortfolio   = propertyNames.length > 1;

  // ── Step 5: global month timeline + global utility-field list ────────────────
  // Both per-property sheets and the roll-up share these so dates and field
  // rows line up across every sheet.
  const { sortedTables: globalSortedTables } = buildTablesFor(pages);
  const allMonths = new Set<string>();
  for (const t of globalSortedTables) for (const k of t.monthKeys) allMonths.add(k);
  const sortedMonths = Array.from(allMonths).sort();

  // ── Step 6: build workbook ───────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();

  // Sheet names must be ≤31 chars and exclude \ / ? * [ ] :
  const sanitizeSheetName = (name: string): string => {
    const safe = name.replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim();
    return (safe || 'Property').slice(0, 31);
  };
  const ensureUnique = (used: Set<string>, base: string): string => {
    if (!used.has(base)) { used.add(base); return base; }
    for (let i = 2; i < 9999; i++) {
      const cand = `${base.slice(0, 28)} ${i}`;
      if (!used.has(cand)) { used.add(cand); return cand; }
    }
    return base;
  };

  if (!isPortfolio) {
    // ── Single-property path (byte-identical to the prior implementation) ─────
    buildSheet(wb, 'Utility Recon', {
      sortedTables: globalSortedTables, sortedMonths, headerProperty, headerAddress, isRecon: true,
    });
    buildSheet(wb, 'Raw Data', {
      sortedTables: globalSortedTables, sortedMonths, headerProperty, headerAddress, isRecon: false,
    });
  } else {
    // ── Portfolio path ────────────────────────────────────────────────────────
    // Per-property: one Utility Recon + one Raw Data sheet (existing template).
    // Final: a Roll-up sheet that references each property sheet's totals.
    const usedNames = new Set<string>();
    const perProperty: RollupProperty[] = [];

    for (const propName of propertyNames) {
      const propPages = pagesByProperty.get(propName) ?? [];
      const { sortedTables: localTables } = buildTablesFor(propPages);

      const propAddress = mostCommon(propPages.map(p => p.address).filter(Boolean));

      const reconName = ensureUnique(usedNames, sanitizeSheetName(propName));
      const rawName   = ensureUnique(usedNames, sanitizeSheetName(`${propName} Raw`));

      const result = buildSheet(wb, reconName, {
        sortedTables:  localTables,
        summaryTables: globalSortedTables,  // align field rows across all property sheets
        sortedMonths,
        headerProperty: propName,
        headerAddress:  propAddress,
        isRecon:        true,
      });
      buildSheet(wb, rawName, {
        sortedTables:  localTables,
        summaryTables: globalSortedTables,
        sortedMonths,
        headerProperty: propName,
        headerAddress:  propAddress,
        isRecon:        false,
      });

      perProperty.push({ sheetName: reconName, result });
    }

    // Roll-up: 3 summary tables, cross-sheet SUM formulas, NO raw data sheet.
    const rollupName = ensureUnique(usedNames, 'Roll-up');
    buildRollupSheet(wb, rollupName, {
      summaryTables:  globalSortedTables,
      sortedMonths,
      headerProperty: 'Portfolio Roll-up',
      headerAddress:  '',
      perProperty,
    });

    // Reorder so the Roll-up is the first tab in the workbook. ExcelJS
    // sorts visible tabs by ``orderNo``; reassigning it puts Roll-up at
    // position 1 with everything else shifted right by one.
    const rollupSheet = wb.getWorksheet(rollupName);
    if (rollupSheet) {
      const others = wb.worksheets.filter(s => s.name !== rollupName);
      (rollupSheet as ExcelJS.Worksheet & { orderNo: number }).orderNo = 1;
      others.forEach((s, i) => {
        (s as ExcelJS.Worksheet & { orderNo: number }).orderNo = i + 2;
      });
    }
  }

  // ── Append a "Plain Data" sheet — unstyled, one row per file,
  // first-wins per field. Named "Plain Data" (not "Raw Data") because
  // utility-recon already uses "Raw Data" for its month-grid layout.
  // This is the flat, column-per-field view the user asked for —
  // useful for downstream scripts / pivot tables.
  {
    // Collect fields in first-seen order across all rows.
    const fieldsSeen = new Set<string>();
    const fields: string[] = [];
    for (const rs of fileMap.values()) {
      for (const r of rs) {
        if (!r.value || !String(r.value).trim()) continue;
        if (!fieldsSeen.has(r.field)) { fieldsSeen.add(r.field); fields.push(r.field); }
      }
    }

    // Generate a unique sheet name. We can't reach the ``usedNames`` Set
    // inside the if/else above (different scope) so just walk worksheets.
    let plainName = 'Plain Data';
    let n = 2;
    while (wb.getWorksheet(plainName)) plainName = `Plain Data ${n++}`;

    const rawWs = wb.addWorksheet(plainName);
    rawWs.addRow(['#', 'File Name', ...fields]);

    let idx = 1;
    for (const [filename, rs] of fileMap.entries()) {
      const values: Record<string, string> = {};
      for (const r of rs) {
        if (!r.value) continue;
        if (!values[r.field]) values[r.field] = r.value;
      }
      rawWs.addRow([
        idx++,
        filename.replace(/\.(pdf|docx?)$/i, ''),
        ...fields.map(f => values[f] ?? ''),
      ]);
    }

    rawWs.columns = [
      { width: 5 },
      { width: 30 },
      ...fields.map(() => ({ width: 22 })),
    ];

    // Borders on every cell, bold header row. No fills/colors — matches
    // the "plain raw data" spec.
    const _thin = { style: 'thin' as const, color: { argb: 'FF000000' } };
    rawWs.eachRow((row, rowNum) => {
      row.eachCell(cell => {
        cell.border = { top: _thin, bottom: _thin, left: _thin, right: _thin };
        cell.font = { name: 'Arial', size: 10, bold: rowNum === 1 };
        cell.alignment = { vertical: 'middle', wrapText: true };
      });
    });
  }

  // ── Step 7: download ──────────────────────────────────────────────────────────
  const now     = new Date();
  const dateStr = now.toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const buf     = await wb.xlsx.writeBuffer();
  const stem    = isPortfolio ? 'Pexl_Portfolio_UtilityRecon' : 'Pexl_UtilityRecon';
  saveAs(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `${stem}_${dateStr}.xlsx`,
  );
}
