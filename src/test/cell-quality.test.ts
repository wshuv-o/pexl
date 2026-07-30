import { describe, it, expect, vi } from 'vitest';

// api.ts transitively imports pdfjs (via pdf-extract), which needs browser
// APIs (DOMMatrix) that jsdom lacks — stub it out.
vi.mock('@/lib/pdf-extract', () => ({ extractFromRegions: vi.fn() }));

import { assessCell } from '@/lib/api';
import type { ExtractedRow } from '@/types/utilscraper';

const row = (over: Partial<ExtractedRow> = {}): ExtractedRow => ({
  page: 1,
  field: 'account_number',
  value: 'x',
  confidence: 'high',
  wasOcr: false,
  ...over,
});

describe('assessCell — which cells deserve a second look', () => {
  it('flags empty values and nothing else', () => {
    expect(assessCell(row(), null)).toEqual(['empty']);
    expect(assessCell(row(), '')).toEqual(['empty']);
    expect(assessCell(row(), '   ')).toEqual(['empty']);
    // An empty cell short-circuits: no point also complaining about format.
    expect(assessCell(row({ field: 'total_credits', clipped: true }), '')).toEqual(['empty']);
  });

  it('stays silent on a healthy cell', () => {
    expect(assessCell(row(), '12345')).toEqual([]);
    expect(assessCell(row({ field: 'total_credits' }), '1234.56')).toEqual([]);
    expect(assessCell(row({ field: 'statement_date' }), '01/31/2025')).toEqual([]);
  });

  it('flags a value the highlight truncated', () => {
    // The exact failure the backend now detects: box cut "1,234.56" → "1,23".
    expect(assessCell(row({ field: 'total_credits', clipped: true }), '1.23')).toContain('clipped');
  });

  it('flags weak OCR reads, and trusts strong ones', () => {
    expect(assessCell(row({ ocrScore: 0.42, wasOcr: true }), '8000')).toContain('low_ocr');
    expect(assessCell(row({ ocrScore: 0.97, wasOcr: true }), '8000')).toEqual([]);
    // Native text has no score — absence must not be read as "bad".
    expect(assessCell(row({ ocrScore: undefined }), '8000')).toEqual([]);
  });

  it('flags amounts and dates that did not normalise', () => {
    expect(assessCell(row({ field: 'total_credits' }), '1,23')).toContain('bad_amount');
    expect(assessCell(row({ field: 'ending_balance' }), 'N/A')).toContain('bad_amount');
    expect(assessCell(row({ field: 'statement_date' }), 'Jan 2025')).toContain('bad_date');
    expect(assessCell(row({ field: 'statement_date' }), 'NONE')).toContain('bad_date');
  });

  it('reports every applicable reason at once', () => {
    const issues = assessCell(
      row({ field: 'total_credits', clipped: true, ocrScore: 0.3, wasOcr: true }),
      '1,23',
    );
    expect(issues).toEqual(expect.arrayContaining(['clipped', 'low_ocr', 'bad_amount']));
  });

  it('does not flag non-amount fields for amount formatting', () => {
    // Free-text fields must never be judged against the numeric rule.
    expect(assessCell(row({ field: 'property_name' }), 'Sunset Apartments')).toEqual([]);
    expect(assessCell(row({ field: 'address' }), '12 Main St, Apt 4')).toEqual([]);
  });
});
