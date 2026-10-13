import { describe, it, expect, vi, afterEach } from 'vitest';
import ExcelJS from 'exceljs';

// The browser download wrappers hand the workbook to file-saver; capture it.
const saved: { blob: Blob; name: string }[] = [];
vi.mock('file-saver', () => ({
  saveAs: (blob: Blob, name: string) => { saved.push({ blob, name }); },
  default: { saveAs: (blob: Blob, name: string) => { saved.push({ blob, name }); } },
}));

import { buildExportWorkbook, exportToExcel } from '@/lib/excel-export';
import type { UtilityDateField } from '@/lib/utility-excel-export';
import { buildWorkbookForRequest, docTypeCatalog, type ExportRequest } from '@/server/export-request';
import { DOCUMENT_TYPES, type DocumentType, type ExtractedRow } from '@/types/utilscraper';
import fixtures from './fixtures/export-requests.json';

const requests = fixtures as Record<string, ExportRequest>;

/** Rows as the browser holds them after extraction: one session per PDF. */
function browserRows(req: ExportRequest): ExtractedRow[] {
  return req.files.flatMap((file, i) => file.rows.map(r => ({
    page: r.page,
    field: r.field,
    value: r.value,
    confidence: 'high' as const,
    wasOcr: false,
    filename: file.filename,
    ...(file.folder_name ? { folderName: file.folder_name } : {}),
    sessionId: `session-${i}`,
  })));
}

/** BatchPanel's filename stem rule, applied to the run id. */
const stem = (req: ExportRequest) =>
  (req.external_reference ?? '').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || req.doc_type;

function viaBrowser(req: ExportRequest) {
  return buildExportWorkbook(browserRows(req), stem(req), {
    forceDocType: req.doc_type as DocumentType,
    dateField: req.options?.date_field ?? 'auto',
  });
}

/** Everything that defines a workbook's content and layout, as plain data. */
async function snapshot(buffer: ArrayBuffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb.worksheets.map(ws => {
    const cells: Record<string, unknown> = {};
    ws.eachRow({ includeEmpty: true }, row => {
      row.eachCell({ includeEmpty: true }, cell => {
        cells[cell.address] = { value: cell.value, style: cell.style };
      });
    });
    return {
      name: ws.name,
      state: ws.state,
      merges: [...(ws.model.merges ?? [])].sort(),
      views: ws.views,
      autoFilter: ws.autoFilter,
      columns: (ws.columns ?? []).map(c => c.width),
      rowHeights: Array.from({ length: ws.rowCount }, (_, i) => ws.getRow(i + 1).height),
      cells,
    };
  });
}

async function load(buffer: ArrayBuffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

describe('export API builds the same workbook as the browser Export button', () => {
  for (const [name, req] of Object.entries(requests)) {
    it(name, async () => {
      const api = await buildWorkbookForRequest(req);
      const browser = await viaBrowser(req);
      const [a, b] = [await snapshot(api.buffer), await snapshot(browser.buffer)];
      expect(a.length).toBeGreaterThan(0);
      expect(a.map(s => s.name)).toEqual(b.map(s => s.name));
      expect(a).toEqual(b);
      // Same filename shape the browser uses, stem taken from the run id.
      expect(api.filename.replace(/\d{4}-\d\d-\d\d-\d\d-\d\d/, 'D'))
        .toBe(browser.filename.replace(/\d{4}-\d\d-\d\d-\d\d-\d\d/, 'D'));
    });
  }

  it('covers every document type', () => {
    const covered = new Set(Object.values(requests).map(r => r.doc_type));
    expect([...covered].sort()).toEqual(DOCUMENT_TYPES.map(t => t.value).sort());
  });

  it('keeps formulas and merges in the API output', async () => {
    const wb = await load((await buildWorkbookForRequest(requests.utility_bill)).buffer);
    const recon = wb.getWorksheet('Utility Recon')!;
    expect(recon.model.merges).toContain('B5:C5');
    const formulas: string[] = [];
    recon.eachRow(row => row.eachCell(c => {
      if (c.value && typeof c.value === 'object' && 'formula' in c.value) formulas.push(c.value.formula);
    }));
    expect(formulas.some(f => f.includes('(1.25+2.25)'))).toBe(true);
    expect(formulas.some(f => f.startsWith('SUM('))).toBe(true);
  });

  it('reports fields the doc type does not know', async () => {
    expect((await buildWorkbookForRequest(requests.appraisal)).unknownFields).toEqual(['total_gas_bill']);
    expect((await buildWorkbookForRequest(requests.utility_bill)).unknownFields).toEqual([]);
    expect((await buildWorkbookForRequest(requests.others)).unknownFields).toEqual([]);
  });

  it('rejects an unknown doc type and malformed rows', async () => {
    await expect(buildWorkbookForRequest({ ...requests.tax, doc_type: 'invoice' }))
      .rejects.toThrow('Unknown doc_type: invoice');
    const bad = structuredClone(requests.tax);
    bad.files[0].rows[0].page = 0;
    await expect(buildWorkbookForRequest(bad)).rejects.toThrow('files[0].rows[0].page');
  });

  it('lists doc types with their fields', () => {
    const utility = docTypeCatalog().find(t => t.value === 'utility_bill')!;
    expect(utility.label).toBe('Utility Bill');
    expect(utility.fields.map(f => f.value)).toEqual(
      expect.arrayContaining(['total_gas_bill', 'total_electricity_bill', 'billing_date', 'provider_name']),
    );
    expect(utility.fields.map(f => f.value)).not.toContain('custom');
  });
});

describe('utility month bucketing through the API', () => {
  // Twelve monthly bills, each dated the 5th. billing_date rolls a bill dated
  // before the 15th back a month; the plain `date` field does not.
  const monthly = (fields: ('billing_date' | 'date')[], mode: UtilityDateField): ExportRequest => ({
    doc_type: 'utility_bill',
    options: { date_field: mode },
    files: [{
      filename: 'year.pdf',
      rows: Array.from({ length: 12 }, (_, i) => [
        { page: i + 1, field: 'provider_name', value: 'ConEd' },
        { page: i + 1, field: 'total_electricity_bill', value: String((i + 1) * 10) },
        ...fields.map(field => ({ page: i + 1, field, value: `${String(i + 1).padStart(2, '0')}/05/2026` })),
      ]).flat(),
    }],
  });

  async function monthCells(req: ExportRequest) {
    const ws = (await load((await buildWorkbookForRequest(req)).buffer)).getWorksheet('Utility Recon')!;
    let dataRow = 0;
    ws.eachRow((row, n) => { if (row.getCell(3).value === 'ConEd') dataRow = n; });
    const out: Record<string, unknown> = {};
    ws.getRow(6).eachCell((cell, col) => {
      if (/^[A-Z][a-z]{2}-\d\d$/.test(String(cell.value))) out[String(cell.value)] = ws.getCell(dataRow, col).value;
    });
    return out;
  }

  const shifted = Object.fromEntries(
    ['Dec-25', 'Jan-26', 'Feb-26', 'Mar-26', 'Apr-26', 'May-26', 'Jun-26', 'Jul-26', 'Aug-26', 'Sep-26', 'Oct-26', 'Nov-26']
      .map((m, i) => [m, (i + 1) * 10]),
  );
  const asNamed = Object.fromEntries(
    ['Jan-26', 'Feb-26', 'Mar-26', 'Apr-26', 'May-26', 'Jun-26', 'Jul-26', 'Aug-26', 'Sep-26', 'Oct-26', 'Nov-26', 'Dec-26']
      .map((m, i) => [m, (i + 1) * 10]),
  );

  it('billing_date rolls early-month bills back a month', async () => {
    expect(await monthCells(monthly(['billing_date', 'date'], 'billing_date'))).toEqual(shifted);
  });
  it('date uses the month as named', async () => {
    expect(await monthCells(monthly(['billing_date', 'date'], 'date'))).toEqual(asNamed);
  });
  it('auto prefers billing_date, else falls back to date', async () => {
    expect(await monthCells(monthly(['billing_date', 'date'], 'auto'))).toEqual(shifted);
    expect(await monthCells(monthly(['date'], 'auto'))).toEqual(asNamed);
  });
});

describe('browser Export button still downloads', () => {
  afterEach(() => { vi.restoreAllMocks(); saved.length = 0; });

  it('saves xlsx-js-style layouts through an anchor click', async () => {
    const urls: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => { urls.push(b); return 'blob:x'; }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await exportToExcel(browserRows(requests.tax), 'f', 'My Batch', { forceDocType: 'tax' });
    expect(click).toHaveBeenCalledTimes(1);
    expect(urls).toHaveLength(1);
  });

  it('saves the ExcelJS layouts through file-saver', async () => {
    await exportToExcel(browserRows(requests.utility_bill), 'f', 'p', { forceDocType: 'utility_bill' });
    await exportToExcel(browserRows(requests.bank_statement), 'f', 'p', { forceDocType: 'bank_statement' });
    await vi.waitFor(() => expect(saved).toHaveLength(2));
    expect(saved.map(s => s.name.split('_')[1]).sort()).toEqual(['UtilityRecon', 'p'].sort());
  });
});
