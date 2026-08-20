import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExtractedRow, Highlight, RegionUpdate } from '@/types/utilscraper';

// extractRegions' fast path delegates the text-layer read to pdf-extract.
// Stubbing it lets us drive the page-by-page callback deterministically
// without standing up pdfjs under jsdom.
const extractFromRegions = vi.fn();
vi.mock('@/lib/pdf-extract', () => ({ extractFromRegions: (...a: unknown[]) => extractFromRegions(...a) }));
vi.mock('../lib/pdf-extract', () => ({ extractFromRegions: (...a: unknown[]) => extractFromRegions(...a) }));

const hl = (page: number, field: string): Highlight => ({
  id: `${page}-${field}`, page, field, x: 0.1, y: 0.1, width: 0.2, height: 0.05,
});
const row = (page: number, field: string, value: string | null): ExtractedRow =>
  ({ page, field, value, confidence: value ? 'high' : 'low', wasOcr: value === null });

/** Resolve the client stub page by page, firing onPageChunk as each lands. */
const clientAnswers = (answers: (string | null)[]) =>
  extractFromRegions.mockImplementation(async (_f, hls, opts) => {
    const byPage = new Map<number, number[]>();
    hls.forEach((h: Highlight, i: number) => {
      if (!byPage.has(h.page)) byPage.set(h.page, []);
      byPage.get(h.page)!.push(i);
    });
    const out: ExtractedRow[] = new Array(hls.length);
    for (const idxs of byPage.values()) {
      const chunk: RegionUpdate[] = idxs.map(i => ({ index: i, row: row(hls[i].page, hls[i].field, answers[i]) }));
      for (const u of chunk) out[u.index] = u.row;
      await Promise.resolve();
      opts?.onPageChunk?.(chunk);
    }
    return out;
  });

let extractRegions: typeof import('@/lib/api')['extractRegions'];
const file = new File(['%PDF-1.4'], 'multi.pdf', { type: 'application/pdf' });

/** Minimal duck-typed fetch response — api.ts only reads .ok/.status/.json(). */
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

// api.ts passes AbortSignal.timeout() to its health probe; jsdom doesn't
// ship it, and the resulting throw would route every test into the offline
// fallback rather than the path under test.
if (typeof AbortSignal !== 'undefined' && !('timeout' in AbortSignal)) {
  (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout =
    () => new AbortController().signal;
}

beforeEach(async () => {
  vi.resetModules();
  extractFromRegions.mockReset();
  // Health probe runs at module load; every later POST is an extract call.
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/health')) return ok({});
    const body = JSON.parse(String(init?.body));
    return ok({ results: body.highlights.map((h: Highlight) => row(h.page, h.field, `ocr-p${h.page}-${h.field}`)) });
  }));
  const api = await import('@/lib/api');
  extractRegions = api.extractRegions;
  // api.ts probes /health at module load and only takes the client-first
  // fast path once that resolves. Wait for it, or every test silently runs
  // the offline fallback instead of the path under test.
  for (let i = 0; i < 100 && !api.isBackendOnline(); i++) await new Promise(r => setTimeout(r, 5));
  expect(api.isBackendOnline()).toBe(true);
});

describe('extractRegions live streaming', () => {
  it('emits each page as it resolves rather than once at the end', async () => {
    const highlights = [hl(1, 'a'), hl(2, 'b'), hl(3, 'c')];
    clientAnswers(['one', 'two', 'three']);
    const batches: RegionUpdate[][] = [];

    const out = await extractRegions('sess', highlights, file, {
      strict: true, onPartial: u => batches.push(u),
    });

    // One batch per page — not a single batch carrying all three.
    expect(batches.length).toBe(3);
    expect(batches.map(b => b.map(u => u.row.page))).toEqual([[1], [2], [3]]);
    expect(out.map(r => r.value)).toEqual(['one', 'two', 'three']);
  });

  it('holds back rows the text layer missed until the backend answers them', async () => {
    const highlights = [hl(1, 'a'), hl(2, 'b')];
    clientAnswers(['found', null]);          // page 2 is scanned
    const batches: RegionUpdate[][] = [];

    const out = await extractRegions('sess', highlights, file, {
      strict: true, onPartial: u => batches.push(u),
    });

    // Page 1 streams immediately; page 2 emits only once OCR returns —
    // never as a blank row that fills in later.
    expect(batches.flat().every(u => u.row.value !== null)).toBe(true);
    expect(out.map(r => r.value)).toEqual(['found', 'ocr-p2-b']);
  });

  it('sends one backend request per page so scanned pages return independently', async () => {
    const highlights = [hl(1, 'a'), hl(2, 'b'), hl(3, 'c')];
    clientAnswers([null, null, null]);       // fully scanned document
    const batches: RegionUpdate[][] = [];

    const out = await extractRegions('sess', highlights, file, {
      strict: true, onPartial: u => batches.push(u),
    });

    const posts = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(c => String(c[0]).includes('/extract-regions'));
    expect(posts.length).toBe(3);
    expect(posts.every(c => JSON.parse(String((c[1] as RequestInit).body)).highlights.length === 1)).toBe(true);
    expect(batches.length).toBe(3);
    expect(out.map(r => r.value)).toEqual(['ocr-p1-a', 'ocr-p2-b', 'ocr-p3-c']);
  });

  it('keeps results aligned to the input order when pages interleave', async () => {
    // Highlights out of page order — the old page-grouped flat() returned
    // [p1a, p1c, p2b] against an input of [p1a, p2b, p1c].
    const highlights = [hl(1, 'a'), hl(2, 'b'), hl(1, 'c')];
    clientAnswers(['A', 'B', 'C']);

    const out = await extractRegions('sess', highlights, file, { strict: true });

    expect(out.map(r => [r.page, r.field, r.value])).toEqual([
      [1, 'a', 'A'], [2, 'b', 'B'], [1, 'c', 'C'],
    ]);
  });

  it('keeps the pages that succeeded when one page request fails', async () => {
    const highlights = [hl(1, 'a'), hl(2, 'b')];
    clientAnswers([null, null]);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/health')) return ok({});
      const body = JSON.parse(String(init?.body));
      if (body.highlights[0].page === 1) return { ok: false, status: 500, json: async () => ({}) };
      return ok({ results: body.highlights.map((h: Highlight) => row(h.page, h.field, `ocr-p${h.page}`)) });
    }));

    const out = await extractRegions('sess', highlights, file, { strict: true });

    // Page 1 degrades to null; page 2's value is not thrown away with it.
    expect(out.map(r => r.value)).toEqual([null, 'ocr-p2']);
  });
});
