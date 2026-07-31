import { describe, it, expect } from 'vitest';
import { partitionConflict, type RecordConflict } from '@/lib/batch-merge';

const make = (
  base: Record<string, string>,
  mine: Record<string, string>,
  theirs: Record<string, string>,
): RecordConflict => ({
  batchId: 1, sessionId: 's', filename: 'f.pdf', page: 1,
  base, mine, theirs, serverVersion: 2,
});

describe('3-way merge of a concurrent batch edit', () => {
  it('auto-merges when each side changed a different field', () => {
    // The exact scenario that used to silently revert someone's work.
    const { auto, clashes } = partitionConflict(make(
      { ending_balance: '1,23', statement_date: '01/31/2025' },
      { ending_balance: '1,23', statement_date: '02/28/2025' },  // I changed the date
      { ending_balance: '1234.56', statement_date: '01/31/2025' }, // they fixed the balance
    ));
    expect(clashes).toHaveLength(0);
    expect(auto).toEqual(expect.arrayContaining([
      { field: 'ending_balance', value: '1234.56', from: 'theirs' },
      { field: 'statement_date', value: '02/28/2025', from: 'mine' },
    ]));
  });

  it('asks only about fields both sides changed', () => {
    const { auto, clashes } = partitionConflict(make(
      { a: '1', b: '2', c: '3' },
      { a: '1', b: 'mine', c: 'mine-c' },
      { a: 'theirs-a', b: 'theirs', c: '3' },
    ));
    expect(clashes).toEqual([{ field: 'b', mine: 'mine', theirs: 'theirs' }]);
    expect(auto).toEqual(expect.arrayContaining([
      { field: 'a', value: 'theirs-a', from: 'theirs' },
      { field: 'c', value: 'mine-c', from: 'mine' },
    ]));
  });

  it('ignores fields both sides set to the same value', () => {
    const { auto, clashes } = partitionConflict(make(
      { a: '1' }, { a: '2' }, { a: '2' },
    ));
    expect(clashes).toHaveLength(0);
    expect(auto).toHaveLength(0);
  });

  it('treats a newly added field as that side’s change', () => {
    const { auto, clashes } = partitionConflict(make(
      {}, { note: 'mine' }, {},
    ));
    expect(clashes).toHaveLength(0);
    expect(auto).toEqual([{ field: 'note', value: 'mine', from: 'mine' }]);
  });

  it('flags a genuine clash when both add the same new field differently', () => {
    const { clashes } = partitionConflict(make(
      {}, { note: 'mine' }, { note: 'theirs' },
    ));
    expect(clashes).toEqual([{ field: 'note', mine: 'mine', theirs: 'theirs' }]);
  });

  it('handles a cleared field as a change, not a no-op', () => {
    const { auto, clashes } = partitionConflict(make(
      { a: 'x' }, { a: '' }, { a: 'x' },
    ));
    expect(clashes).toHaveLength(0);
    expect(auto).toEqual([{ field: 'a', value: '', from: 'mine' }]);
  });

  it('without a known ancestor, every difference needs a decision', () => {
    // Older sessions may have no base snapshot; falling back to "ask" is the
    // safe direction — never silently drop a side.
    const { auto, clashes } = partitionConflict(make(
      {}, { a: 'mine' }, { a: 'theirs' },
    ));
    expect(auto).toHaveLength(0);
    expect(clashes).toHaveLength(1);
  });
});
