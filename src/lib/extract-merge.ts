import type { Highlight, RegionUpdate } from '@/types/utilscraper';

/**
 * Merging partial extraction results back into page-keyed highlight state.
 *
 * Extraction takes a flat highlight list and answers it page by page, out of
 * order. The UI holds highlights keyed by page. These two helpers are the
 * bridge — kept out of the component because getting the mapping wrong
 * doesn't throw, it silently pins one highlight's value onto another.
 */

/**
 * Positions in `Object.values(hls).flat()`, as [page, offset-within-page].
 *
 * Callers flatten their highlight record to hand extraction a list; this
 * returns the reverse route, so result index N can be traced back to the
 * highlight it belongs to.
 *
 * Both this and the caller's flatten walk the record in the same order, so
 * they agree regardless of what that order turns out to be. (For the record:
 * JS orders integer-like keys ascending no matter the insertion order, so
 * highlighting page 5 before page 2 still yields 2 then 5 in both.)
 */
export function highlightSlots(hls: Record<number, Highlight[]>): [number, number][] {
  const slots: [number, number][] = [];
  for (const [pageNum, pageHls] of Object.entries(hls)) {
    pageHls.forEach((_, i) => slots.push([Number(pageNum), i]));
  }
  return slots;
}

/**
 * Fold extracted rows into a highlight record, copy-on-write.
 *
 * Returns the record untouched when no update matched a slot, so a caller can
 * use reference equality to skip a re-render. Pages that no update touched
 * keep their original array identity.
 */
export function applyRegionUpdates(
  hls: Record<number, Highlight[]>,
  slots: [number, number][],
  updates: RegionUpdate[],
): Record<number, Highlight[]> {
  let out = hls;
  const copied = new Set<number>();

  for (const { index, row } of updates) {
    const slot = slots[index];
    if (!slot) continue;
    const [pageNum, offset] = slot;
    const page = out[pageNum];
    if (!page || !page[offset]) continue;

    if (!copied.has(pageNum)) {
      out = { ...out, [pageNum]: [...page] };
      copied.add(pageNum);
    }
    out[pageNum][offset] = {
      ...out[pageNum][offset],
      extractedValue: row.value,
      confidence:     row.confidence,
      wasOcr:         row.wasOcr,
    };
  }

  return out;
}
