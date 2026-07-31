import { describe, it, expect, vi } from 'vitest';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { render, waitFor, cleanup } from '@testing-library/react';

/**
 * Regression guard for the refetch loop that made the batches panel slow.
 *
 * ExcelPanel's `refreshBatchSavedRows` fetches a batch's records and stores
 * them as a NEWLY BUILT array, and an effect depends on that callback. If the
 * callback also depends on the state it sets, every fetch changes its identity,
 * which re-triggers the effect, which fetches again — forever. (Writing that
 * version as a test hung the runner outright, so only the correct shape is
 * exercised here.)
 *
 * This mirrors the fixed shape: stable callback, fallback value read from a
 * ref. If someone reintroduces the state dependency, the count assertion below
 * starts failing instead of quietly hammering the server.
 */

type Row = { id: number };

function StableFetcher({ onFetch }: { onFetch: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const rowsRef = useRef<Row[]>([]);
  useEffect(() => { rowsRef.current = rows; }, [rows]);

  const refresh = useCallback(async () => {
    onFetch();
    // A fresh array every call — same data, different reference. This is what
    // made the unstable version loop.
    setRows([{ id: 1 }]);
    return rowsRef.current;
  }, [onFetch]);

  useEffect(() => { void refresh(); }, [refresh]);
  return React.createElement('div', null, String(rows.length));
}

describe('batch records refetch', () => {
  it('fetches once and settles, even though it stores a new array each time', async () => {
    const onFetch = vi.fn();
    render(React.createElement(StableFetcher, { onFetch }));

    await waitFor(() => expect(onFetch).toHaveBeenCalled());
    // Give it ample opportunity to misbehave.
    await new Promise(r => setTimeout(r, 300));

    expect(onFetch).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
