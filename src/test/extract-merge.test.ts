import { describe, it, expect } from 'vitest';
import { highlightSlots, applyRegionUpdates } from '@/lib/extract-merge';
import type { Highlight, RegionUpdate } from '@/types/utilscraper';

const hl = (page: number, field: string): Highlight => ({
  id: `${page}-${field}`, page, field, x: 0, y: 0, width: 0.1, height: 0.1,
});
const upd = (index: number, page: number, value: string | null): RegionUpdate =>
  ({ index, row: { page, field: 'f', value, confidence: 'high', wasOcr: false } });

describe('highlightSlots', () => {
  it('lines up with Object.values(...).flat(), the list handed to extraction', () => {
    // Pages deliberately inserted out of order — JS walks integer-like keys
    // ascending, and the flatten the caller does has to agree with this map.
    const hls = { 10: [hl(10, 'a')], 2: [hl(2, 'b'), hl(2, 'c')] };
    const flat = Object.values(hls).flat();
    const slots = highlightSlots(hls);

    expect(slots.length).toBe(flat.length);
    slots.forEach(([page, offset], i) => {
      expect(hls[page as 2 | 10][offset]).toBe(flat[i]);
    });
    expect(slots).toEqual([[2, 0], [2, 1], [10, 0]]);
  });
});

describe('applyRegionUpdates', () => {
  const base = () => ({ 1: [hl(1, 'a'), hl(1, 'b')], 3: [hl(3, 'c')] });

  it('routes each result to the highlight that asked for it', () => {
    const hls = base();
    const slots = highlightSlots(hls);           // [[1,0],[1,1],[3,0]]
    const out = applyRegionUpdates(hls, slots, [upd(2, 3, 'third'), upd(0, 1, 'first')]);

    expect(out[1][0].extractedValue).toBe('first');
    expect(out[1][1].extractedValue).toBeUndefined();   // untouched, still pending
    expect(out[3][0].extractedValue).toBe('third');
  });

  it('accumulates across the page-by-page callbacks', () => {
    const hls = base();
    const slots = highlightSlots(hls);
    const afterPage3 = applyRegionUpdates(hls, slots, [upd(2, 3, 'third')]);
    const afterPage1 = applyRegionUpdates(afterPage3, slots, [upd(0, 1, 'first'), upd(1, 1, 'second')]);

    expect(afterPage1[1].map(h => h.extractedValue)).toEqual(['first', 'second']);
    expect(afterPage1[3][0].extractedValue).toBe('third');   // earlier page survives
  });

  it('never mutates the record it was given', () => {
    const hls = base();
    const slots = highlightSlots(hls);
    const out = applyRegionUpdates(hls, slots, [upd(0, 1, 'first')]);

    expect(hls[1][0].extractedValue).toBeUndefined();
    expect(out).not.toBe(hls);
    expect(out[1]).not.toBe(hls[1]);
    expect(out[3]).toBe(hls[3]);      // untouched page keeps its identity
  });

  it('returns the same reference when nothing matched, so no repaint is queued', () => {
    const hls = base();
    const slots = highlightSlots(hls);
    expect(applyRegionUpdates(hls, slots, [])).toBe(hls);
    expect(applyRegionUpdates(hls, slots, [upd(99, 1, 'stray')])).toBe(hls);
  });

  it('carries confidence and the OCR flag through, not just the value', () => {
    const hls = base();
    const slots = highlightSlots(hls);
    const out = applyRegionUpdates(hls, slots, [
      { index: 0, row: { page: 1, field: 'a', value: 'v', confidence: 'medium', wasOcr: true } },
    ]);
    expect(out[1][0]).toMatchObject({ extractedValue: 'v', confidence: 'medium', wasOcr: true });
    expect(out[1][0].id).toBe('1-a');    // identity/geometry preserved
  });

  it('keeps an explicit null result distinct from still-pending', () => {
    const hls = base();
    const slots = highlightSlots(hls);
    const out = applyRegionUpdates(hls, slots, [upd(0, 1, null)]);
    // null = extraction ran and found nothing (row shows, empty).
    // undefined = still waiting (row absent from the panel).
    expect(out[1][0].extractedValue).toBeNull();
    expect(out[1][1].extractedValue).toBeUndefined();
  });
});
