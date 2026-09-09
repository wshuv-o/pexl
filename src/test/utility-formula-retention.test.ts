import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';

// The exporter hands the finished workbook to file-saver. Capture the blob
// instead of touching the filesystem, then read it back with ExcelJS so the
// assertions are about the real generated cells, not our intent.
const saved: Blob[] = [];
vi.mock('file-saver', () => ({
  saveAs: (blob: Blob) => { saved.push(blob); },
  default: { saveAs: (blob: Blob) => { saved.push(blob); } },
}));

import { downloadUtilityExcel } from '@/lib/utility-excel-export';
import type { ExtractedRow } from '@/types/utilscraper';

/** One imported spreadsheet row, in the shape BatchPanel feeds the exporter. */
function record(page: number, fields: Record<string, string>): ExtractedRow[] {
  return Object.entries(fields).map(([field, value]) => ({
    page, field, value,
    confidence: 'high' as const,
    wasOcr: false,
    filename: 'Maple Apts',
    sessionId: 'xls-test',
  }));
}

/** jsdom's Blob has no arrayBuffer(); FileReader is the portable path. */
function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as ArrayBuffer);
    fr.onerror = () => reject(fr.error);
    fr.readAsArrayBuffer(blob);
  });
}

async function generate(rows: ExtractedRow[]): Promise<ExcelJS.Workbook> {
  saved.length = 0;
  const fileMap = new Map<string, ExtractedRow[]>();
  for (const r of rows) {
    if (!fileMap.has(r.filename)) fileMap.set(r.filename, []);
    fileMap.get(r.filename)!.push(r);
  }
  await downloadUtilityExcel(fileMap, 'auto');
  expect(saved).toHaveLength(1);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await blobToArrayBuffer(saved[0]));
  return wb;
}

/**
 * Month cell of a utility table's data row.
 *
 * The Recon sheet repeats a utility's name on several rows — a table title
 * row, the data row, a "Total <utility>" row, and one row in each of the
 * three summary tables. Only the data row carries a provider and account
 * (cols 3 and 4), which is what distinguishes it.
 */
function findCell(ws: ExcelJS.Worksheet, utilityLabel: string, monthLabel: string) {
  const header = ws.getRow(6);
  let monthCol = 0;
  header.eachCell((cell, colNum) => {
    if (cell.value === monthLabel) monthCol = colNum;
  });
  expect(monthCol, `month column ${monthLabel}`).toBeGreaterThan(0);

  const dataRows: number[] = [];
  ws.eachRow((row, rowNum) => {
    if (row.getCell(2).value === utilityLabel && row.getCell(3).value) dataRows.push(rowNum);
  });
  expect(dataRows, `data row for ${utilityLabel}`).toHaveLength(1);
  return ws.getRow(dataRows[0]).getCell(monthCol);
}

describe('utility export — retained source formulas', () => {
  beforeEach(() => { saved.length = 0; });

  it('writes the source cell arithmetic as the month cell formula', async () => {
    const wb = await generate([
      ...record(1, {
        property_name: 'Maple Apts',
        provider_name: 'Duke Energy',
        account_number: '9101 7667 9948',
        date: '2026-05-01',
        total_electricity_bill: '8.00',
        total_electricity_bill_expr: '1.2+2.3+4.5',
      }),
    ]);
    const cell = findCell(wb.getWorksheet('Utility Recon')!, 'Electricity', 'May-26');
    expect(cell.formula).toBe('1.2+2.3+4.5');
    expect(cell.result).toBeCloseTo(8, 2);
  });

  it('keeps a plain number a number when no formula was retained', async () => {
    const wb = await generate([
      ...record(1, {
        property_name: 'Maple Apts',
        provider_name: 'Duke Energy',
        account_number: '9101',
        date: '2026-05-01',
        total_electricity_bill: '1151.39',
      }),
    ]);
    const cell = findCell(wb.getWorksheet('Utility Recon')!, 'Electricity', 'May-26');
    expect(cell.formula).toBeUndefined();
    expect(cell.value).toBeCloseTo(1151.39, 2);
  });

  it('parenthesises a retained expression when the month has several bills', async () => {
    const wb = await generate([
      ...record(1, {
        property_name: 'Maple Apts', provider_name: 'Duke Energy', account_number: '9101',
        date: '2026-05-04', total_electricity_bill: '8.00', total_electricity_bill_expr: '1.2+2.3+4.5',
      }),
      ...record(2, {
        property_name: 'Maple Apts', provider_name: 'Duke Energy', account_number: '9101',
        date: '2026-05-20', total_electricity_bill: '10.00',
      }),
    ]);
    const cell = findCell(wb.getWorksheet('Utility Recon')!, 'Electricity', 'May-26');
    expect(cell.formula).toBe('(1.2+2.3+4.5)+10.00');
    expect(cell.result).toBeCloseTo(18, 2);
  });

  it('ignores an expression that references cells or calls a function', async () => {
    // Defence in depth: the importer never emits these, but a cell ref
    // reaching the output workbook would resolve against unrelated cells.
    for (const bad of ['B2+C2', 'SUM(A1:A9)', '2**3', 'foo']) {
      const wb = await generate([
        ...record(1, {
          property_name: 'Maple Apts', provider_name: 'Duke Energy', account_number: '9101',
          date: '2026-05-01', total_electricity_bill: '5.00', total_electricity_bill_expr: bad,
        }),
      ]);
      const cell = findCell(wb.getWorksheet('Utility Recon')!, 'Electricity', 'May-26');
      expect(cell.formula, bad).toBeUndefined();
      expect(cell.value, bad).toBeCloseTo(5, 2);
    }
  });

  it('buckets an invoice date into the month it names, unshifted', async () => {
    // 'date' is taken at face value; only 'billing_date' rolls a pre-15th
    // bill into the previous month.
    const wb = await generate([
      ...record(1, {
        property_name: 'Maple Apts', provider_name: 'Duke Energy', account_number: '9101',
        date: '2026-05-01', total_electricity_bill: '8.00', total_electricity_bill_expr: '1.2+2.3+4.5',
      }),
    ]);
    const ws = wb.getWorksheet('Utility Recon')!;
    let sawMay = false, sawApr = false;
    ws.eachRow(row => row.eachCell(c => {
      if (c.value === 'May-26') sawMay = true;
      if (c.value === 'Apr-26') sawApr = true;
    }));
    expect(sawMay).toBe(true);
    expect(sawApr).toBe(false);
  });
});
