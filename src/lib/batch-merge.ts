export type FieldMap = Record<string, string>;

export interface RecordConflict {
  batchId: number;
  sessionId: string;
  filename: string;
  page: number;
  /** What this browser tried to save. */
  mine: FieldMap;
  /** What the server holds right now. */
  theirs: FieldMap;
  /** What both sides started from, when known — enables a 3-way merge. */
  base: FieldMap;
  /** Server version to save against once resolved. */
  serverVersion: number;
  theirsBy?: string | null;
  theirsAt?: string | null;
}

export type Side = 'mine' | 'theirs';

/**
 * Split a concurrent edit into what can be merged automatically and what a
 * human has to decide.
 *
 * Comparing both sides against their common ancestor means the user is only
 * asked about fields *both* of them changed. The common real case — two people
 * fixing different cells on the same page — resolves with no decision at all.
 *
 * With no known ancestor (an older session with no base snapshot) every
 * difference becomes a decision, which is the safe direction: it can ask a
 * needless question, but it can never silently drop someone's work.
 */
export function partitionConflict(c: Pick<RecordConflict, 'mine' | 'theirs' | 'base'>) {
  const keys = Array.from(new Set([
    ...Object.keys(c.mine ?? {}),
    ...Object.keys(c.theirs ?? {}),
    ...Object.keys(c.base ?? {}),
  ])).sort();

  const auto: { field: string; value: string; from: Side }[] = [];
  const clashes: { field: string; mine: string; theirs: string }[] = [];

  for (const f of keys) {
    const mine = c.mine?.[f] ?? '';
    const theirs = c.theirs?.[f] ?? '';
    const base = c.base?.[f] ?? '';
    if (mine === theirs) continue;                        // already agree
    if (mine === base) { auto.push({ field: f, value: theirs, from: 'theirs' }); continue; }
    if (theirs === base) { auto.push({ field: f, value: mine, from: 'mine' }); continue; }
    clashes.push({ field: f, mine, theirs });             // both changed it
  }
  return { auto, clashes, keys };
}
