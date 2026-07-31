import { describe, it, expect, vi } from 'vitest';
import type ExcelJS from 'exceljs';

vi.mock('@/lib/pdf-extract', () => ({ extractFromRegions: vi.fn() }));

import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { buildUtilityWorkbook } from '@/lib/utility-excel-export';
import { buildBankStatementWorkbook } from '@/lib/bank-excel-export';
import SheetGrid from '@/components/SheetGrid';
import type { ExtractedRow } from '@/types/utilscraper';

// Shaped exactly like BatchPreview rebuilds them from saved batch records.
const row = (
  filename: string, page: number, field: string, value: string,
): ExtractedRow => ({
  page, field, value, confidence: 'high', wasOcr: false,
  filename, sessionId: `sess-${filename}`,
});

/** Every string sitting in a worksheet, for header assertions. */
function sheetText(ws: ExcelJS.Worksheet): string[] {
  const out: string[] = [];
  ws.eachRow(r => {
    r.eachCell({ includeEmpty: false }, c => {
      const v = c.value;
      if (typeof v === 'string') out.push(v);
      else if (v && typeof v === 'object' && 'richText' in v) {
        out.push((v.richText as { text: string }[]).map(t => t.text).join(''));
      }
    });
  });
  return out;
}

describe('utility template preview', () => {
  const utilityRows: ExtractedRow[] = [
    ...['sample_gas_bill'].flatMap(f => [
      row(f, 1, 'provider_name', 'National Grid Gas'),
      row(f, 1, 'property_name', 'Sunset Apartments'),
      row(f, 1, 'account_number', 'GAS-0007-TEST'),
      row(f, 1, 'billing_date', '07/05/2026'),
      row(f, 1, 'total_gas_bill', '250.00'),
    ]),
    ...['sample_water_bill'].flatMap(f => [
      row(f, 1, 'provider_name', 'City Water'),
      row(f, 1, 'property_name', 'Sunset Apartments'),
      row(f, 1, 'account_number', 'WTR-2026-000TEST'),
      row(f, 1, 'billing_date', '07/10/2026'),
      row(f, 1, 'total_water_bill', '80.00'),
    ]),
  ];

  it('builds the real recon workbook, not a field-per-column grid', async () => {
    const fileMap = new Map<string, ExtractedRow[]>();
    for (const r of utilityRows) {
      const key = r.filename || 'Unknown';
      if (!fileMap.has(key)) fileMap.set(key, []);
      fileMap.get(key)!.push(r);
    }

    const { wb } = await buildUtilityWorkbook(fileMap);
    expect(wb.worksheets.length).toBeGreaterThan(0);

    const recon = wb.worksheets[0];
    const text = sheetText(recon);
    // The template's own column headers — none of which the old preview showed.
    expect(text).toContain('Utility Items');
    expect(text).toContain('Utility Provider');
    expect(text).toContain('Account Number');
    expect(text).toContain('Total');
    // The property header the template prints.
    expect(text.join(' ')).toContain('Sunset Apartments');
  });

  it('exposes more than one sheet so the preview can tab between them', async () => {
    const fileMap = new Map([['sample_gas_bill', utilityRows.slice(0, 5)]]);
    const { wb } = await buildUtilityWorkbook(fileMap);
    expect(wb.worksheets.map(w => w.name)).toContain('Utility Recon');
  });
});

describe('SheetGrid renders the built worksheet', () => {
  it('puts the template’s own headers into the DOM', async () => {
    const rows: ExtractedRow[] = [
      row('gas.pdf', 1, 'provider_name', 'National Grid Gas'),
      row('gas.pdf', 1, 'property_name', 'Sunset Apartments'),
      row('gas.pdf', 1, 'account_number', 'GAS-0007-TEST'),
      row('gas.pdf', 1, 'billing_date', '07/05/2026'),
      row('gas.pdf', 1, 'total_gas_bill', '250.00'),
    ];
    const { wb } = await buildUtilityWorkbook(new Map([['gas.pdf', rows]]));

    render(React.createElement(SheetGrid, { worksheet: wb.worksheets[0] }));
    expect(screen.getAllByText('Utility Provider').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Account Number').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Sunset Apartments/).length).toBeGreaterThan(0);
    cleanup();
  });
});

describe('bank statement template preview', () => {
  it('builds the balance-chain workbook from saved records', async () => {
    const rows: ExtractedRow[] = ['jan', 'feb'].flatMap((m, i) => [
      row(`stmt_${m}.pdf`, 1, 'property_name', 'Harbour LLC'),
      row(`stmt_${m}.pdf`, 1, 'account_number', '****1234'),
      row(`stmt_${m}.pdf`, 1, 'statement_date', `0${i + 1}/31/2025`),
      row(`stmt_${m}.pdf`, 1, 'beginning_balance', '1000.00'),
      row(`stmt_${m}.pdf`, 1, 'ending_balance', '1500.00'),
      row(`stmt_${m}.pdf`, 1, 'total_credits', '900.00'),
      row(`stmt_${m}.pdf`, 1, 'total_debits', '400.00'),
    ]);

    const wb = await buildBankStatementWorkbook(rows);
    expect(wb.worksheets.length).toBeGreaterThan(0);

    const text = wb.worksheets.flatMap(sheetText);
    // Columns unique to the bank template.
    expect(text).toContain('Deposits');
    expect(text).toContain('Withdrawals');
    expect(text).toContain('Unadjusted Balance');
    // Trailing-period block.
    expect(text).toContain('Trailing - 12');
  });
});
