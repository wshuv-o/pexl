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

function billDateToMonthKey(dateStr: string): string | null {
  const d = parseDateValue(dateStr);
  if (!d) return null;
  let m = d.getUTCMonth();
  let y = d.getUTCFullYear();
  if (d.getUTCDate() < 15) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
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
  otherCharges:    Map<string, number>;
  taxes:           Map<string, number>;
};
type UtilityTable = {
  utilityField: string; utilityLabel: string;
  rows: Map<string, TableRow>;
  monthKeys: Set<string>;
  monthScrapedDates: Map<string, Set<string>>;
};
type SheetParams = {
  sortedTables:   UtilityTable[];
  sortedMonths:   string[];
  headerProperty: string;
  headerAddress:  string;
  isRecon:        boolean;
};

// ─── Sheet builder (called once per output sheet) ────────────────────────────

function buildSheet(wb: ExcelJS.Workbook, sheetName: string, p: SheetParams): void {
  const { sortedTables, sortedMonths, headerProperty, headerAddress, isRecon } = p;

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

  // ── Row 3: full year numbers ──────────────────────────────────────────────────
  ws.getRow(3).height = 12.75;
  for (let i = 0; i < MONTH_COUNT; i++) {
    const cell = G(3, FIXED_COLS + 1 + i);
    cell.value     = parseInt(sortedMonths[i].split('-')[0], 10);  // full year e.g. 2025
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

  // ── Row 7: empty buffer row (recon only, 12.75 height) ───────────────────────
  if (isRecon) ws.getRow(7).height = 12.75;

  // ── Per-utility-type data tables ──────────────────────────────────────────────
  const tableTotalRows = new Map<string, number>();
  let currentRow = isRecon ? 8 : 7;

  for (const table of sortedTables) {
    const sortedRows = Array.from(table.rows.values()).sort((a, b) =>
      a.provider !== b.provider
        ? a.provider.localeCompare(b.provider)
        : a.account.localeCompare(b.account),
    );

    const tableStartRow = currentRow;

    // Sub-header row: raw data only — label + scraped dates
    if (!isRecon) {
      ws.getRow(currentRow).height = 13.5;
      for (let c = 2; c <= LAST_COL; c++) {
        G(currentRow, c).fill = (c >= utilityItemsCol && c <= providerCol) ? orangeFill : whiteFill;
        G(currentRow, c).font = { name: 'Calibri', size: 10 };
      }
      G(currentRow, utilityItemsCol).value = table.utilityLabel;
      for (let i = 0; i < MONTH_COUNT; i++) {
        const mk    = sortedMonths[i];
        const dates = table.monthScrapedDates.get(mk);
        const cell  = G(currentRow, FIXED_COLS + 1 + i);
        cell.value     = dates && dates.size > 0 ? Array.from(dates).join(' · ') : '';
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      }
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
    const mainDataRows: number[] = [];
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
        G(currentRow, c).fill = (c >= utilityItemsCol && c <= providerCol) ? orangeFill : whiteFill;
        G(currentRow, c).font = { name: 'Calibri', size: 10, bold: !isRecon && c === 4 };
        const isCenter = (c === providerCol || c === accountCol);
        G(currentRow, c).alignment = { horizontal: isCenter ? 'center' : 'left', vertical: 'middle' };
      }
      for (let i = 0; i < MONTH_COUNT; i++) {
        const mk    = sortedMonths[i];
        const cell  = G(currentRow, FIXED_COLS + 1 + i);
        const vList = row.monthValuesList.get(mk);
        if (vList && vList.length > 1) {
          const sum = vList.reduce((a, b) => a + b, 0);
          cell.value  = { formula: vList.map(n => n.toFixed(2)).join('+'), result: sum };
          cell.numFmt = '"$"#,##0.00';
        } else if (vList && vList.length === 1) {
          cell.value  = vList[0];
          cell.numFmt = '"$"#,##0.00';
        }
        cell.fill      = whiteFill;
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
      mainDataRows.push(currentRow);
      currentRow++;

      // Other Charges / Taxes sub-rows (raw data only)
      if (!isRecon) {
        for (const [subLabel, subMap] of [['Other Charges', row.otherCharges], ['Taxes', row.taxes]] as [string, Map<string, number>][]) {
          if (subMap.size === 0) continue;
          ws.getRow(currentRow).height = 13.5;
          for (let c = 2; c <= LAST_COL; c++) {
            G(currentRow, c).fill = whiteFill;
            G(currentRow, c).font = { name: 'Calibri', size: 10, italic: true };
          }
          G(currentRow, utilityItemsCol).value     = `  ${subLabel}`;
          G(currentRow, utilityItemsCol).alignment = { horizontal: 'left', vertical: 'middle' };
          for (let i = 0; i < MONTH_COUNT; i++) {
            const mk  = sortedMonths[i];
            const val = subMap.get(mk);
            if (val !== undefined) {
              const cell       = G(currentRow, FIXED_COLS + 1 + i);
              cell.value       = val;
              cell.numFmt      = '"$"#,##0.00';
              cell.fill        = whiteFill;
              cell.font        = { name: 'Calibri', size: 10, italic: true };
              cell.alignment   = { horizontal: 'center', vertical: 'middle' };
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
    // Spacer row — same height as data rows
    ws.getRow(currentRow).height = isRecon ? 12.75 : 13.5;
    for (let c = 2; c <= FIXED_COLS;         c++) G(currentRow, c).fill = (c >= utilityItemsCol && c <= providerCol) ? orangeFill : whiteFill;
    for (let c = FIXED_COLS + 1; c <= LAST_COL; c++) G(currentRow, c).fill = whiteFill;
    currentRow++;

    // Total row
    ws.getRow(currentRow).height = isRecon ? 12.75 : 13.5;
    G(currentRow, utilityItemsCol).value = `Total ${table.utilityLabel}`;
    for (let c = 2; c <= LAST_COL; c++) {
      G(currentRow, c).font = { name: 'Calibri', size: 10, bold: true };
    }
    if (mainDataRows.length > 0) {
      for (let i = 0; i < MONTH_COUNT; i++) {
        const L    = colLetter(FIXED_COLS + 1 + i);
        const cell = G(currentRow, FIXED_COLS + 1 + i);
        cell.value  = { formula: `SUM(${mainDataRows.map(r => `${L}${r}`).join(',')})` };
        cell.numFmt = '"$"#,##0.00';
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      }
      if (MONTH_COUNT > 0) {
        const L  = colLetter(TOTAL_COL);
        const tc = G(currentRow, TOTAL_COL);
        tc.value  = { formula: `SUM(${mainDataRows.map(r => `${L}${r}`).join(',')})` };
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

  // Variance cells use red-bracket format for negatives
  const varFmt = '"$"#,##0.00;[Red]("$"#,##0.00)';

  for (let si = 0; si < sections.length; si++) {
    const section      = sections[si];
    const summaryStart = currentRow;
    const isVariance   = section === 'Variance';

    // Header row: 12.75 height, size 10; recon=blue/green split, raw=all navy; Comments col no fill
    ws.getRow(currentRow).height = 12.75;
    for (let c = 2; c <= LAST_COL; c++) {
      if (c === COMMENTS_COL || c === accountCol) {
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

    // Per-utility rows
    for (const table of sortedTables) {
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
    currentRow++;

    applyBlockBorders(ws, summaryStart, summaryEnd, 2, LAST_COL, boldLeftSet);
    if (si < sections.length - 1) currentRow += 1;
  }
}

// ─── Main export function ─────────────────────────────────────────────────────

export async function downloadUtilityExcel(fileMap: Map<string, ExtractedRow[]>): Promise<void> {

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
        monthKey: vals.billing_date ? (billDateToMonthKey(vals.billing_date) ?? '') : '',
        fieldValues: vals,
      });
    }
  }

  // ── Step 2: representative property + address ─────────────────────────────────
  const headerProperty = mostCommon(pages.map(p => p.property).filter(Boolean));
  const headerAddress  = mostCommon(pages.map(p => p.address ).filter(Boolean));

  // ── Step 3: build per-utility-type tables ─────────────────────────────────────
  type TableRow = {
    folder: string; fileName: string; provider: string; account: string;
    monthValues:     Map<string, number>;
    monthValuesList: Map<string, number[]>;
    otherCharges:    Map<string, number>;
    taxes:           Map<string, number>;
  };
  type UtilityTable = {
    utilityField: string; utilityLabel: string;
    rows: Map<string, TableRow>;
    monthKeys: Set<string>;
    monthScrapedDates: Map<string, Set<string>>;
  };
  const tables = new Map<string, UtilityTable>();

  for (const pg of pages) {
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
        if (ocRaw)  { const v = parseFloat(ocRaw.replace(/[$,\s]/g,  '')); if (!isNaN(v)) tr.otherCharges.set(pg.monthKey, (tr.otherCharges.get(pg.monthKey) ?? 0) + v); }
        const taxRaw = pg.fieldValues['taxes'];
        if (taxRaw) { const v = parseFloat(taxRaw.replace(/[$,\s]/g, '')); if (!isNaN(v)) tr.taxes.set(pg.monthKey,        (tr.taxes.get(pg.monthKey)        ?? 0) + v); }
        const rawDate = pg.fieldValues.billing_date;
        if (rawDate) {
          if (!table.monthScrapedDates.has(pg.monthKey)) table.monthScrapedDates.set(pg.monthKey, new Set());
          table.monthScrapedDates.get(pg.monthKey)!.add(rawDate.trim());
        }
      }
    }
  }

  // ── Step 4: sorted month timeline ────────────────────────────────────────────
  const allMonths = new Set<string>();
  for (const t of tables.values()) for (const k of t.monthKeys) allMonths.add(k);
  const sortedMonths = Array.from(allMonths).sort();

  // ── Step 5: sort tables ───────────────────────────────────────────────────────
  const utilityOrder = Object.keys(UTILITY_TOTAL_FIELDS);
  const sortedTables = Array.from(tables.values()).sort(
    (a, b) => utilityOrder.indexOf(a.utilityField) - utilityOrder.indexOf(b.utilityField),
  );

  // ── Step 6: build workbook ────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  const base = { sortedTables, sortedMonths, headerProperty, headerAddress };
  buildSheet(wb, 'Utility Recon', { ...base, isRecon: true  });
  buildSheet(wb, 'Raw Data',      { ...base, isRecon: false });

  // ── Step 7: download ──────────────────────────────────────────────────────────
  const now     = new Date();
  const dateStr = now.toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const buf     = await wb.xlsx.writeBuffer();
  saveAs(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `Pexl_UtilityRecon_${dateStr}.xlsx`,
  );
}
