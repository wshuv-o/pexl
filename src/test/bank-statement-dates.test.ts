import { describe, it, expect, vi } from 'vitest';

// api.ts transitively imports pdfjs (via pdf-extract), which needs browser
// APIs (DOMMatrix) that jsdom lacks — stub it out.
vi.mock('@/lib/pdf-extract', () => ({ extractFromRegions: vi.fn() }));

import { normalizeDateValue } from '@/lib/api';
import { buildT12Months } from '@/lib/bank-excel-export';

describe('normalizeDateValue — statement date ranges', () => {
  it('takes only the first date of a range', () => {
    expect(normalizeDateValue('Nov 11, 2025 - Dec 10, 2025')).toBe('11/11/2025');
    expect(normalizeDateValue('11/01/2025-11/30/2025')).toBe('11/01/2025');
    expect(normalizeDateValue('11/01/2025 - 11/30/2025')).toBe('11/01/2025');
    expect(normalizeDateValue('November 1, 2025 through November 30, 2025')).toBe('11/01/2025');
    expect(normalizeDateValue('Statement Period: Nov 11, 2025 to Dec 10, 2025')).toBe('11/11/2025');
  });

  it('borrows the year from the range end when the start has none', () => {
    expect(normalizeDateValue('Dec 11 - Jan 13, 2025')).toBe('12/11/2025');
  });

  it('supports short and 2-digit-year month-name formats', () => {
    expect(normalizeDateValue('Nov 11,26')).toBe('11/11/2026');
    expect(normalizeDateValue('nov 11,2026')).toBe('11/11/2026');
    expect(normalizeDateValue('Nov 11, 2026')).toBe('11/11/2026');
    expect(normalizeDateValue('SEPT 5, 2025')).toBe('09/05/2025');
    expect(normalizeDateValue('11 Nov 2026')).toBe('11/11/2026');
  });

  it('takes the range END when takeEnd is set (utility billing_date)', () => {
    expect(normalizeDateValue('Dec 11, 2024 - Jan 13, 2025', { takeEnd: true })).toBe('01/13/2025');
    expect(normalizeDateValue('Dec 11 - Jan 13, 2025', { takeEnd: true })).toBe('01/13/2025');
    expect(normalizeDateValue('01/13/2025', { takeEnd: true })).toBe('01/13/2025');
  });

  it('keeps existing formats working', () => {
    expect(normalizeDateValue('12/31/2025')).toBe('12/31/2025');
    expect(normalizeDateValue('2025-11-30')).toBe('11/30/2025');
    expect(normalizeDateValue('January 5th, 2025')).toBe('01/05/2025');
    expect(normalizeDateValue('01 / 31 / 2026')).toBe('01/31/2026');
    expect(normalizeDateValue('September 2025')).toBe('09/01/2025');
  });
});

describe('buildT12Months — month range for the bank template', () => {
  const anchor = new Date(2025, 10, 30); // Nov 2025

  it('still builds exactly 12 months without an earlier start', () => {
    const months = buildT12Months(anchor);
    expect(months).toHaveLength(12);
    expect(months[0]).toBe('12/31/2024');
    expect(months[11]).toBe('11/30/2025');
  });

  it('extends past 12 months when statements start earlier', () => {
    const months = buildT12Months(anchor, new Date(2024, 5, 15)); // Jun 2024
    expect(months).toHaveLength(18);
    expect(months[0]).toBe('06/30/2024');
    expect(months[17]).toBe('11/30/2025');
  });

  it('ignores an earliest date inside the trailing-12 window', () => {
    const months = buildT12Months(anchor, new Date(2025, 3, 10)); // Apr 2025
    expect(months).toHaveLength(12);
    expect(months[0]).toBe('12/31/2024');
  });
});
