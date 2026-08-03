/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { X, Download, RefreshCw, Pencil, CheckCircle2, ArrowUpDown, ArrowUp, ArrowDown, Trash2, Check, Layers, ChevronDown, Plus, Loader2, Sparkles, AlertTriangle, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ExtractedRow, DocumentType, CellIssue } from '@/types/utilscraper';
import { getFieldConfig } from '@/types/utilscraper';
import { exportToExcel } from '@/lib/excel-export';
import {
  findMergeOpportunities, findUtilityMergeOpportunities, applyMerges,
  type MergeGroup, type MergeChoice,
} from '@/lib/bank-excel-export';
import MergeDialog from '@/components/bank/MergeDialog';
import BatchPanel from '@/components/BatchPanel';
import MergeConflictDialog, { type RecordConflict } from '@/components/batch/MergeConflictDialog';
import { normalizeDateValue } from '@/lib/api';
import { FIELD_LABELS } from '@/types/utilscraper';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

interface Props {
  data: ExtractedRow[];
  filename: string;
  provider: string;
  onClose: () => void;
  onReExtract: () => void;
  onReExtractPage?: (sessionId: string, page: number) => void;
  /** Re-read only the flagged cells with line-gutter alignment enabled. */
  onRepairFlagged?: (cells: { sessionId: string; page: number; field: string }[]) => void | Promise<void>;
  onDataChange: (data: ExtractedRow[]) => void;
  multiFile?: boolean;
  onDownload?: () => void;
  onRowClick?: (sessionId: string, page: number) => void;
  onDeleteRow?: (sessionId: string, page: number) => void;
  externalBatchId?: number | null;
  // Doc type explicitly chosen by the user — overrides field-count
  // auto-detection in the export. Lets the user manually pick the
  // template even when their highlighted fields are mixed/wrong type.
  forceDocType?: DocumentType;
}

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000';

const CONF_PCT: Record<string, number> = { high: 95, medium: 65, low: 25 };

// How long to wait after the last edit on a page before pushing it to the
// batch. Long enough that fixing three cells in a row is one request, short
// enough that the save feels immediate.
const AUTO_SAVE_DELAY_MS = 700;

// Plain-English reason shown on a flagged cell, so the warning is actionable
// rather than mysterious.
const ISSUE_LABELS: Record<CellIssue, string> = {
  empty:      'Nothing was read from this region',
  clipped:    'The highlight cut through the text — part of the value was never read',
  low_ocr:    'Weak OCR confidence on this value',
  bad_amount: 'Does not parse as an amount',
  bad_date:   'Not a valid MM/DD/YYYY date',
  drifted:    'This box read a line it was not aimed at — the page’s text may have shifted',
};

// Count fields per doc type using only fields that are exclusive to a
// single type (e.g. beginning_balance → bank_statement). Shared fields
// like property_name / account_number / address are ignored because
// they'd smear the signal across types. Returns the dominant type or
// null when no exclusive-field signal exists (e.g. only shared fields
// were extracted).
function detectDocTypeFromRows(rows: ExtractedRow[]): DocumentType | null {
  const fieldToType: Record<string, DocumentType> = {};
  for (const f of FIELD_LABELS) {
    if (f.value !== 'custom' && f.docTypes.length === 1) {
      fieldToType[f.value] = f.docTypes[0];
    }
  }
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const dt = fieldToType[r.field];
    if (dt) counts[dt] = (counts[dt] || 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] as DocumentType | undefined;
  return top ?? null;
}

// Kept as a named helper for the utility-specific merge / date-picker
// branches elsewhere in the panel. Delegates to the generic detector.
function isUtilityExport(rows: ExtractedRow[]): boolean {
  return detectDocTypeFromRows(rows) === 'utility_bill';
}

// PageRow holds ALL extracted values per field (arrays, so multi-value fields
// like multiple statement_dates can explode into multiple display rows).
interface PageRow {
  sessionId: string;
  filename: string;
  page: number;
  cellsMulti: Record<string, ExtractedRow[]>; // multiple values allowed per field
}

// DisplayRow is the actual rendered row after exploding multi-value PageRows.
interface DisplayRow {
  sessionId: string;
  filename: string;
  page: number;
  subIndex: number;                          // which sub-row of the page this is
  isFirstOfPage: boolean;
  cells: Record<string, ExtractedRow | null>;
}

// Parse a value for numeric sorting (strips $, commas, whitespace)
const parseForSort = (val: string): number => parseFloat(val.replace(/[$,\s]/g, ''));

// Month name → 0-indexed month (handles abbreviations and full names)
const MONTH_NAMES: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

// Robust date parser → returns epoch ms or NaN.
// Always extracts a 4-digit year so year-aware sorting works.
const parseDateValue = (val: string): number => {
  if (!val) return NaN;
  const trimmed = String(val).trim();
  if (!trimmed) return NaN;

  // 1. ISO YYYY-MM-DD
  const iso = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) {
    const y = parseInt(iso[1], 10);
    const m = parseInt(iso[2], 10);
    const d = parseInt(iso[3], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return new Date(y, m - 1, d).getTime();
    }
  }

  // 2. MM/DD/YYYY or DD/MM/YYYY (auto-detect when month > 12)
  const slash = trimmed.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/);
  if (slash) {
    let mo = parseInt(slash[1], 10);
    let dd = parseInt(slash[2], 10);
    let yy = parseInt(slash[3], 10);
    if (yy < 100) yy += yy < 70 ? 2000 : 1900;
    if (mo > 12 && dd <= 12) [mo, dd] = [dd, mo];
    if (mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31) {
      return new Date(yy, mo - 1, dd).getTime();
    }
  }

  // 3. Month-name formats: "January 15, 2024" / "15 January 2024" / "Jan 15 24"
  const lower = trimmed.toLowerCase();
  // "Month Day, Year" or "Month Day Year"
  const monthFirst = lower.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})/);
  if (monthFirst) {
    const m = MONTH_NAMES[monthFirst[1]];
    if (m !== undefined) {
      const d = parseInt(monthFirst[2], 10);
      let y = parseInt(monthFirst[3], 10);
      if (y < 100) y += y < 70 ? 2000 : 1900;
      return new Date(y, m, d).getTime();
    }
  }
  // "Day Month Year"
  const dayFirst = lower.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?\s+(\d{2,4})/);
  if (dayFirst) {
    const m = MONTH_NAMES[dayFirst[2]];
    if (m !== undefined) {
      const d = parseInt(dayFirst[1], 10);
      let y = parseInt(dayFirst[3], 10);
      if (y < 100) y += y < 70 ? 2000 : 1900;
      return new Date(y, m, d).getTime();
    }
  }

  // 4. Native Date as a final fallback
  const native = new Date(trimmed);
  if (!isNaN(native.getTime())) return native.getTime();

  return NaN;
};

const isDateField = (field: string): boolean => /date$/i.test(field);

export default function ExcelPanel({
  data, filename, provider, onClose, onReExtract, onReExtractPage, onRepairFlagged, onDataChange, multiFile, onDownload, onRowClick, onDeleteRow, externalBatchId, forceDocType,
}: Props) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [mergeGroups, setMergeGroups] = useState<MergeGroup[] | null>(null);
  // Which action the merge dialog is gating: 'export' downloads the .xlsx,
  // 'batch' saves the (optionally merged) rows to the active batch. Lets the
  // one shared MergeDialog serve both the Export and the Save-to-batch flows.
  const [pendingMergeAction, setPendingMergeAction] = useState<'export' | 'batch'>('export');
  // Date-source selector for utility exports. 'auto' picks billing_date
  // when any row has it, otherwise falls back to the 'date' field.
  const [utilityDateField, setUtilityDateField] = useState<'auto' | 'billing_date' | 'date'>('auto');
  const [sortCol, setSortCol]       = useState<string | null>(null);
  const [sortAsc, setSortAsc]       = useState(true);
  // When on, the table shows only rows containing a cell flagged for review.
  const [showOnlySuspect, setShowOnlySuspect] = useState(false);
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  const [approvedKeys, setApprovedKeys] = useState<Set<string>>(new Set());
  const [approvingKey, setApprovingKey] = useState<string | null>(null);
  const [batches, setBatches]               = useState<{ id: number; name: string }[]>([]);
  const [activeBatchId, setActiveBatchId]   = useState<number | null>(externalBatchId ?? null);
  const [batchSavedRows, setBatchSavedRows] = useState<ExtractedRow[]>([]);
  const [showBatchPanel, setShowBatchPanel] = useState(false);

  useEffect(() => {
    if (externalBatchId != null) setActiveBatchId(externalBatchId);
  }, [externalBatchId]);

  // Pull the current batch's saved records from the server into
  // batchSavedRows. Wrapped as a callback so we can also invoke it after
  // approve / bulk-approve and right before Export, guaranteeing the
  // export reflects the latest server state instead of a stale snapshot
  // captured only at batch-selection time. Also seeds approvedKeys from
  // whatever the server already has, so freshly opened sessions know
  // which (sessionId, page) pairs are already saved.
  //
  // Returns the fresh rows so callers that need them synchronously (like
  // the Export click handler) can use them without waiting for React to
  // re-render — setBatchSavedRows schedules a state update but the
  // ongoing async handler still holds the old exportData in closure.
  // Latest saved rows, readable without making this callback depend on them.
  //
  // This callback MUST stay referentially stable. It is a dependency of the
  // effect below, and it calls setBatchSavedRows with a newly built array on
  // every run. If `batchSavedRows` were a dependency, each fetch would change
  // the callback's identity, re-trigger the effect, fetch again — an endless
  // refetch loop for as long as the panel is open with a batch selected.
  const batchSavedRowsRef = useRef<ExtractedRow[]>([]);
  useEffect(() => { batchSavedRowsRef.current = batchSavedRows; }, [batchSavedRows]);

  // Per-record concurrency bookkeeping, keyed by `${sessionId}-${page}`.
  //   versions — the row version this browser last saw; sent with each save so
  //              the server can reject a write based on stale data.
  //   base     — the field values at that version, i.e. the common ancestor.
  //              Having it turns a conflict into a 3-way merge, so the user is
  //              only asked about fields *both* sides actually changed.
  // Refs, not state: pure bookkeeping that must never re-trigger the fetch
  // effect above.
  const recordVersionsRef = useRef<Map<string, number>>(new Map());
  const recordBaseRef = useRef<Map<string, Record<string, string>>>(new Map());
  const [conflict, setConflict] = useState<RecordConflict | null>(null);

  const refreshBatchSavedRows = useCallback(async (batchId: number | null): Promise<ExtractedRow[]> => {
    if (!batchId) { setBatchSavedRows([]); setApprovedKeys(new Set()); return []; }
    try {
      const res = await fetch(`${BACKEND_URL}/api/batches/${batchId}/records`);
      const d = await res.json();
      if (d.status !== 'ok') return batchSavedRowsRef.current;
      const rows: ExtractedRow[] = [];
      const keys = new Set<string>();
      recordVersionsRef.current = new Map();
      recordBaseRef.current = new Map();
      for (const rec of d.records) {
        const key = `${rec.session_id}-${rec.page}`;
        keys.add(key);
        // Snapshot the version + values we loaded: the basis for detecting and
        // merging a concurrent edit later.
        recordVersionsRef.current.set(key, Number(rec.version ?? 1));
        recordBaseRef.current.set(key, { ...(rec.fields as Record<string, string>) });
        for (const [field, value] of Object.entries(rec.fields as Record<string, string>)) {
          if (value) rows.push({ page: rec.page, field, value, confidence: 'high', wasOcr: false, filename: rec.filename, sessionId: rec.session_id });
        }
      }
      setBatchSavedRows(rows);
      setApprovedKeys(keys);
      return rows;
    } catch {
      /* non-fatal — fall back to whatever's currently in state */
      return batchSavedRowsRef.current;
    }
  }, []);

  // Fetch saved batch records whenever the active batch changes
  useEffect(() => {
    void refreshBatchSavedRows(activeBatchId);
  }, [activeBatchId, refreshBatchSavedRows]);
  const { user } = useAuth();

  // ── Build page rows grouped by PDF (multi-value cells) ─────────────────
  const { groups, fieldColumns } = useMemo(() => {
    const pdfOrder: string[] = [];
    const pdfMap = new Map<string, { filename: string; pages: Map<number, PageRow> }>();
    const seenFields = new Set<string>();
    const fieldOrder: string[] = [];

    for (const row of data) {
      const key = row.sessionId || row.filename || 'unknown';
      if (!pdfMap.has(key)) {
        pdfMap.set(key, { filename: row.filename || '', pages: new Map() });
        pdfOrder.push(key);
      }
      const pdf = pdfMap.get(key)!;
      if (!pdf.pages.has(row.page)) {
        pdf.pages.set(row.page, {
          sessionId: row.sessionId || key,
          filename: row.filename || '',
          page: row.page,
          cellsMulti: {},
        });
      }
      const pageRow = pdf.pages.get(row.page)!;
      if (!pageRow.cellsMulti[row.field]) pageRow.cellsMulti[row.field] = [];
      // Date values extracted before normalization existed (or saved in a
      // batch back then) can still be raw ranges like "Jan 1, 2024 - Jan 31,
      // 2024" — re-normalize at display time so only one date shows.
      // billing_date keeps the END of the range (close of billing period).
      // Normalize date values for display — but NEVER a value the user has
      // edited by hand; their exact text wins and must not be reformatted.
      let displayRow = row;
      if (isDateField(row.field) && row.value && !row.edited) {
        const norm = normalizeDateValue(row.value, { takeEnd: row.field === 'billing_date' });
        if (norm !== row.value) displayRow = { ...row, value: norm };
      }
      pageRow.cellsMulti[row.field].push(displayRow);

      if (!seenFields.has(row.field)) {
        seenFields.add(row.field);
        fieldOrder.push(row.field);
      }
    }

    const groupList = pdfOrder.map(key => {
      const pdf = pdfMap.get(key)!;
      return {
        sessionId: key,
        filename: pdf.filename,
        pageRows: Array.from(pdf.pages.values()).sort((a, b) => a.page - b.page),
      };
    });

    return { groups: groupList, fieldColumns: fieldOrder };
  }, [data]);

  // ── Build display rows: explode multi-value pages into N rows ─────────
  // If a page has the same field extracted multiple times (e.g. two credit
  // subtotals on one statement page), we emit one DisplayRow per slot so
  // the user sees every highlighted value in the panel. The first sub-row
  // of a page carries all other fields; subsequent sub-rows leave non-
  // multi fields null to avoid visual duplication.
  const displayGroups = useMemo(() => {
    return groups.map(g => {
      const displayRows: DisplayRow[] = [];
      for (const pr of g.pageRows) {
        const maxCount = Math.max(
          1,
          ...fieldColumns.map(f => (pr.cellsMulti[f] ?? []).length),
        );
        for (let i = 0; i < maxCount; i++) {
          const cells: Record<string, ExtractedRow | null> = {};
          for (const f of fieldColumns) {
            const arr = pr.cellsMulti[f] ?? [];
            // First sub-row: show the i-th value if it exists; for single-
            // value fields that's just the only value.
            // Subsequent sub-rows (i >= 1): only show the i-th value when
            // the field actually has that many occurrences — single-value
            // fields get null so they don't repeat.
            cells[f] = arr[i] ?? null;
          }
          displayRows.push({
            sessionId:     pr.sessionId,
            filename:      pr.filename,
            page:          pr.page,
            subIndex:      i,
            isFirstOfPage: i === 0,
            cells,
          });
        }
      }
      return { sessionId: g.sessionId, filename: g.filename, rows: displayRows };
    });
  }, [groups, fieldColumns]);

  // ── Sort: rows within each PDF group + groups themselves ────────────────
  const sortedGroups = useMemo(() => {
    if (!sortCol) return displayGroups;

    // Comparator for two display rows
    const compareRows = (a: DisplayRow, b: DisplayRow): number => {
      if (sortCol === 'page') {
        return sortAsc
          ? a.page - b.page || a.subIndex - b.subIndex
          : b.page - a.page || a.subIndex - b.subIndex;
      }
      const av = a.cells[sortCol]?.value ?? '';
      const bv = b.cells[sortCol]?.value ?? '';
      const aEmpty = !av;
      const bEmpty = !bv;
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;
      if (bEmpty) return -1;

      // Date columns → parse as dates (year-aware)
      if (isDateField(sortCol)) {
        const ad = parseDateValue(av);
        const bd = parseDateValue(bv);
        if (!isNaN(ad) && !isNaN(bd)) {
          return sortAsc ? ad - bd : bd - ad;
        }
      }

      // Numeric → parse numbers
      const an = parseForSort(av);
      const bn = parseForSort(bv);
      if (!isNaN(an) && !isNaN(bn)) {
        return sortAsc ? an - bn : bn - an;
      }
      return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
    };

    // Sort rows within each group
    const sortedInner = displayGroups.map(g => ({
      ...g,
      rows: [...g.rows].sort(compareRows),
    }));

    // Also sort the groups themselves by their first row's sort value
    return [...sortedInner].sort((ga, gb) => {
      if (ga.rows.length === 0 || gb.rows.length === 0) return 0;
      return compareRows(ga.rows[0], gb.rows[0]);
    });
  }, [displayGroups, sortCol, sortAsc]);

  // Flatten sorted groups back to ExtractedRow[] for export.
  // The display model keeps only the FIRST value per (page, field) — but
  // some exports (bank statement's total_credits / total_debits) depend
  // on seeing every highlighted value to compute correct totals. So we
  // first emit rows in the user's sort order, then append any remaining
  // rows from the raw `data` so nothing is silently dropped.
  const sortedFlat = useMemo(() => {
    const out: ExtractedRow[] = [];
    const seen = new Set<ExtractedRow>();
    for (const g of sortedGroups) {
      for (const r of g.rows) {
        for (const f of fieldColumns) {
          const cell = r.cells[f];
          if (cell && !seen.has(cell)) {
            out.push(cell);
            seen.add(cell);
          }
        }
      }
    }
    // Append every extracted row the display layer discarded (e.g. a
    // second/third value of the same field on the same page).
    for (const row of data) {
      if (!seen.has(row)) {
        out.push(row);
        seen.add(row);
      }
    }
    return out;
  }, [data, sortedGroups, fieldColumns]);

  // Merge saved batch records with current session data for export.
  // Batch records whose (sessionId, page) already appear in the current
  // session are skipped — the live data takes precedence.
  const exportData = useMemo(() => {
    if (!batchSavedRows.length) return sortedFlat;
    const liveKeys = new Set(sortedFlat.map(r => `${r.sessionId}|${r.page}`));
    const prevOnly = batchSavedRows.filter(r => !liveKeys.has(`${r.sessionId}|${r.page}`));
    return [...prevOnly, ...sortedFlat];
  }, [batchSavedRows, sortedFlat]);

  const handleSort = (col: string) => {
    if (sortCol === col) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(true); }
  };

  const handleDeleteRow = (row: DisplayRow) => {
    const next = data.filter(r => !(r.sessionId === row.sessionId && r.page === row.page));
    onDataChange(next);
    onDeleteRow?.(row.sessionId, row.page);
    if (selectedRowKey === `${row.sessionId}-${row.page}-${row.subIndex}`) setSelectedRowKey(null);
  };

  // Persist a cell edit by STABLE IDENTITY — (sessionId, page, field, and
  // the occurrence index for multi-value fields) — not by object reference.
  // Date cells are rendered from a normalized *copy* of the row (see the
  // groups memo), so a reference match (`r === cell`) never hits the object
  // in `data` and the edit silently reverts. Matching the Nth occurrence of
  // (sessionId, page, field) always lands on the real row, so edits stick in
  // the frontend AND flow through to batch saves (which read from `data`).
  // ── Auto-save edits back into the batch ────────────────────────────────
  // Once a page has been approved into a batch there is already a server-side
  // record for it, so a later edit should just update that record — the user
  // shouldn't have to approve the same page over and over. Only pages that
  // are already approved in the active batch are touched; anything not yet
  // approved still needs an explicit approve, which is the user's opt-in.
  //
  // The write is a single POST: `upsert_record` on the server is a genuine
  // INSERT ... ON DUPLICATE KEY UPDATE, so one request atomically replaces
  // the record's fields. (The manual approve path does DELETE-then-POST;
  // left alone since it works, but the lone POST has no window in which the
  // record is missing if the write fails.)
  const autoSaveTimers  = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const autoSavePending = useRef<Record<string, ExtractedRow[]>>({});
  const [autoSavingKeys, setAutoSavingKeys] = useState<Set<string>>(new Set());

  // Don't leave timers firing into an unmounted panel.
  useEffect(() => {
    const timers = autoSaveTimers.current;
    return () => { for (const t of Object.values(timers)) clearTimeout(t); };
  }, []);

  const flushAutoSave = useCallback(async (sessionId: string, page: number) => {
    const key = `${sessionId}-${page}`;
    // Take the newest snapshot queued for this page and clear the slot, so a
    // save that lands mid-flight schedules its own follow-up rather than
    // being silently dropped.
    const snapshot = autoSavePending.current[key];
    delete autoSavePending.current[key];
    delete autoSaveTimers.current[key];
    if (!snapshot || !activeBatchId) return;

    const pageRows = snapshot.filter(d => d.sessionId === sessionId && d.page === page);
    // Same shape the approve path builds: one record per page, repeated
    // fields joined, valueless rows skipped (so clearing a cell removes it).
    const fields: Record<string, string> = {};
    for (const d of pageRows) {
      if (!d.value) continue;
      if (fields[d.field]) fields[d.field] += ', ' + d.value;
      else fields[d.field] = d.value;
    }
    const filename = pageRows[0]?.filename ?? '';

    setAutoSavingKeys(prev => new Set([...prev, key]));
    try {
      const res = await fetch(`${BACKEND_URL}/api/batches/${activeBatchId}/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId, filename, page, fields,
          // The version this browser last saw. The server refuses the write if
          // someone else has saved since, rather than silently overwriting.
          base_version: recordVersionsRef.current.get(key) ?? null,
          updated_by: user?.username ?? null,
        }),
      });

      if (res.status === 409) {
        // Someone else got there first. Hand both versions to the merge
        // dialog instead of losing either side's work.
        const body = await res.json().catch(() => ({}));
        const current = body.current ?? {};
        setConflict({
          batchId: activeBatchId,
          sessionId, filename, page,
          mine: fields,
          theirs: (current.fields ?? {}) as Record<string, string>,
          base: recordBaseRef.current.get(key) ?? {},
          serverVersion: Number(current.version ?? 0),
          theirsBy: current.updated_by ?? null,
          theirsAt: current.updated_at ?? null,
        });
        toast.warning(`Page ${page} was changed by someone else — review the merge`,
          { id: 'batch-autosave' });
        return;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const saved = await res.json().catch(() => ({}));
      if (saved.version) {
        recordVersionsRef.current.set(key, Number(saved.version));
        recordBaseRef.current.set(key, { ...fields });
      }
      // Keep the Export snapshot in step without refetching the whole batch.
      setBatchSavedRows(prev => [
        ...prev.filter(r => !(r.sessionId === sessionId && r.page === page)),
        ...Object.entries(fields).map(([field, value]) => ({
          page, field, value, confidence: 'high' as const, wasOcr: false,
          filename, sessionId,
        })),
      ]);
      // Stable toast id so a burst of edits replaces one toast instead of
      // stacking a tower of them.
      toast.success(`Batch updated — page ${page}`, { id: 'batch-autosave' });
    } catch (err) {
      console.error('auto-save to batch failed', err);
      toast.error(`Couldn't update the batch for page ${page} — click Approve to retry`,
        { id: 'batch-autosave' });
    } finally {
      setAutoSavingKeys(prev => { const n = new Set(prev); n.delete(key); return n; });
    }
  }, [activeBatchId, user?.username]);

  // Write the user's merge decision, based on the server's current version so
  // the save is guaranteed to apply, then bring the panel in line with it.
  const resolveConflict = useCallback(async (merged: Record<string, string>) => {
    if (!conflict) return;
    const { batchId, sessionId, filename, page, serverVersion } = conflict;
    const key = `${sessionId}-${page}`;
    try {
      const res = await fetch(`${BACKEND_URL}/api/batches/${batchId}/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId, filename, page, fields: merged,
          base_version: serverVersion, updated_by: user?.username ?? null,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const saved = await res.json().catch(() => ({}));
      recordVersionsRef.current.set(key, Number(saved.version ?? serverVersion + 1));
      recordBaseRef.current.set(key, { ...merged });

      // Show the merged result in the table. Values are applied to the first
      // occurrence of each field; repeated fields (saved joined with ", ")
      // keep their extra occurrences untouched.
      const applied = new Set<string>();
      const next = data.map(r => {
        if (r.sessionId !== sessionId || r.page !== page) return r;
        if (applied.has(r.field)) return r;
        applied.add(r.field);
        const v = merged[r.field] ?? '';
        return v === r.value ? r : { ...r, value: v };
      });
      for (const [field, value] of Object.entries(merged)) {
        if (!applied.has(field) && value) {
          next.push({ page, field, value, confidence: 'high', wasOcr: false, filename, sessionId });
        }
      }
      onDataChange(next);

      setBatchSavedRows(prev => [
        ...prev.filter(r => !(r.sessionId === sessionId && r.page === page)),
        ...Object.entries(merged).map(([field, value]) => ({
          page, field, value, confidence: 'high' as const, wasOcr: false, filename, sessionId,
        })),
      ]);
      setConflict(null);
      toast.success(`Page ${page} merged and saved`);
    } catch (err) {
      console.error('merge save failed', err);
      toast.error('Could not save the merged record — try again');
    }
  }, [conflict, data, onDataChange, user]);

  // Abandon this browser's version and adopt whatever the server holds.
  const discardMine = useCallback(() => {
    setConflict(null);
    void refreshBatchSavedRows(activeBatchId);
    toast('Your changes were discarded — showing the saved version', { icon: 'ℹ️' });
  }, [activeBatchId, refreshBatchSavedRows]);

  const scheduleAutoSave = useCallback((sessionId: string, page: number, snapshot: ExtractedRow[]) => {
    const key = `${sessionId}-${page}`;
    // Not in a batch, or this page was never approved → nothing to update.
    if (!activeBatchId || !approvedKeys.has(key)) return;
    autoSavePending.current[key] = snapshot;
    clearTimeout(autoSaveTimers.current[key]);
    autoSaveTimers.current[key] = setTimeout(() => { void flushAutoSave(sessionId, page); }, AUTO_SAVE_DELAY_MS);
  }, [activeBatchId, approvedKeys, flushAutoSave]);

  const handleEdit = (
    sessionId: string, page: number, field: string, occ: number, newValue: string,
  ) => {
    let seen = -1;
    let matched = false;
    const next = data.map(r => {
      if (r.sessionId === sessionId && r.page === page && r.field === field) {
        seen++;
        if (seen === occ) { matched = true; return { ...r, value: newValue, edited: true }; }
      }
      return r;
    });
    // Fallback: the occurrence wasn't found (e.g. an edited empty cell that
    // never had a row). Append a fresh edited row so the value isn't lost.
    if (!matched && newValue.trim()) {
      const ref = data.find(r => r.sessionId === sessionId && r.page === page);
      next.push({
        page, field, value: newValue, confidence: 'high', wasOcr: false,
        filename: ref?.filename ?? '', sessionId, edited: true,
      });
    }
    onDataChange(next);
    // If this page is already in the batch, push the edit straight through.
    scheduleAutoSave(sessionId, page, next);
    setEditingKey(null);
  };

  // Save every eligible row (unique sessionId + page pair) to the active
  // batch. UPSERT semantics: rows already in the batch get their fields
  // OVERWRITTEN with whatever's in the current session — so if the user
  // extracted more fields, edited values, or re-ran extract after the
  // first approve, the batch reflects those changes. Previously this
  // skipped already-approved rows, which stranded stale field sets on
  // the server (e.g. the batch only had `total_water_bill` even after
  // the user extracted `total_gas_bill` + more later). Bounded 6-way
  // parallelism so 300 rows don't fire 300 simultaneous requests.
  const [approvingAll, setApprovingAll] = useState(false);

  // Actually write rows to the active batch, one record per (sessionId, page).
  // Takes the rows to save as an argument so callers can pass either the raw
  // live data or a MERGED copy (from the merge dialog) — the save always
  // reflects exactly what the user confirmed.
  const runBatchSave = async (rows: ExtractedRow[]) => {
    if (!activeBatchId) { toast.error('Select a batch before approving'); return; }
    if (approvingAll) return;

    // Group rows into one record per (sessionId, page), concatenating
    // repeated fields. Only rows with a value are saved.
    const pending = new Map<string, {
      sessionId: string; filename: string; page: number;
      alreadyApproved: boolean; fields: Record<string, string>;
    }>();
    for (const d of rows) {
      if (!d.value) continue;
      const key = `${d.sessionId}-${d.page}`;
      let entry = pending.get(key);
      if (!entry) {
        entry = {
          sessionId: d.sessionId, filename: d.filename, page: d.page,
          alreadyApproved: approvedKeys.has(key), fields: {},
        };
        pending.set(key, entry);
      }
      if (entry.fields[d.field]) entry.fields[d.field] += ', ' + d.value;
      else entry.fields[d.field] = d.value;
    }

    if (pending.size === 0) {
      toast('Nothing to save', { icon: 'ℹ️' });
      return;
    }

    setApprovingAll(true);
    const total = pending.size;
    const toastId = toast.loading(`Saving 0 / ${total} to batch…`);
    let done = 0;
    let failed = 0;
    let updated = 0;
    const succeededKeys: string[] = [];

    const queue = Array.from(pending.entries());
    const CONCURRENCY = 6;
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) return;
        const [key, { sessionId, filename, page, alreadyApproved, fields }] = next;
        try {
          // Upsert: for rows already in the batch, DELETE first so the
          // POST inserts a fresh record with the current field set. This
          // mirrors how toggleApprove handles re-approval and prevents
          // duplicate rows piling up on the server.
          if (alreadyApproved) {
            await fetch(
              `${BACKEND_URL}/api/batches/${activeBatchId}/records/${encodeURIComponent(sessionId)}/${page}`,
              { method: 'DELETE' },
            );
          }
          const res = await fetch(`${BACKEND_URL}/api/batches/${activeBatchId}/records`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId, filename, page, fields }),
          });
          if (res.ok) {
            succeededKeys.push(key);
            if (alreadyApproved) updated++;
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
        done++;
        toast.loading(`Saving ${done} / ${total} to batch…`, { id: toastId });
      }
    });
    await Promise.all(workers);

    // Merge every successful key into approvedKeys in one setState call.
    if (succeededKeys.length > 0) {
      setApprovedKeys(prev => {
        const next = new Set(prev);
        for (const k of succeededKeys) next.add(k);
        return next;
      });
    }

    toast.dismiss(toastId);
    const added = succeededKeys.length - updated;
    const parts: string[] = [];
    if (added > 0)   parts.push(`${added} added`);
    if (updated > 0) parts.push(`${updated} updated`);
    const scope = parts.join(', ') || `${succeededKeys.length} saved`;
    if (failed === 0) {
      toast.success(`Batch synced — ${scope}`);
    } else if (succeededKeys.length === 0) {
      toast.error(`All ${failed} record${failed !== 1 ? 's' : ''} failed`);
    } else {
      toast.warning(`Batch synced — ${scope}, ${failed} failed`);
    }
    // Refresh batchSavedRows so the next Export includes everything we
    // just wrote to the server (values, fields, updated timestamps).
    if (succeededKeys.length > 0) await refreshBatchSavedRows(activeBatchId);
    setApprovingAll(false);
  };

  // Save-to-batch entry point. Mirrors the Export flow: scan the live rows
  // for merge opportunities FIRST and, if any exist, open the merge dialog so
  // the user can combine fields before the data lands in the batch. When
  // there's nothing to merge, save straight away.
  const handleApproveAll = async () => {
    if (!activeBatchId) { toast.error('Select a batch before approving'); return; }
    if (approvingAll) return;

    if (isUtilityExport(data)) {
      const utilGroups = findUtilityMergeOpportunities(data);
      if (utilGroups.length > 0) {
        setPendingMergeAction('batch');
        setMergeGroups(utilGroups);
        return;
      }
    } else {
      const bankGroups = findMergeOpportunities(data);
      if (bankGroups.length > 0) {
        setPendingMergeAction('batch');
        setMergeGroups(bankGroups);
        return;
      }
    }
    await runBatchSave(data);
  };

  const toggleApprove = async (row: DisplayRow) => {
    if (!activeBatchId) { toast.error('Select a batch before approving'); return; }
    const key = `${row.sessionId}-${row.page}`;
    if (approvingKey === key) return;
    setApprovingKey(key);
    try {
      if (approvedKeys.has(key)) {
        await fetch(
          `${BACKEND_URL}/api/batches/${activeBatchId}/records/${encodeURIComponent(row.sessionId)}/${row.page}`,
          { method: 'DELETE' },
        );
        setApprovedKeys(prev => { const n = new Set(prev); n.delete(key); return n; });
      } else {
        const fields: Record<string, string> = {};
        const pageData = data.filter(d => d.sessionId === row.sessionId && d.page === row.page);
        for (const d of pageData) {
          if (fields[d.field]) fields[d.field] += ', ' + (d.value ?? '');
          else fields[d.field] = d.value ?? '';
        }
        await fetch(`${BACKEND_URL}/api/batches/${activeBatchId}/records`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: row.sessionId, filename: row.filename, page: row.page, fields }),
        });
        setApprovedKeys(prev => new Set([...prev, key]));
        toast.success(`Page ${row.page} saved to batch`);
      }
      // Refresh so batchSavedRows (used by Export) mirrors the server.
      await refreshBatchSavedRows(activeBatchId);
    } catch (err) {
      console.error('approve error', err);
      toast.error('Failed to save record');
    } finally {
      setApprovingKey(null);
    }
  };

  const SortIcon = ({ col }: { col: string }) => {
    if (sortCol !== col) return <ArrowUpDown className="w-3 h-3 opacity-40" />;
    return sortAsc
      ? <ArrowUp className="w-3 h-3" />
      : <ArrowDown className="w-3 h-3" />;
  };

  const extracted = data.filter(r => r.value).length;
  const nullCount = data.filter(r => !r.value).length;
  // Cells that have a value but something about it looks off — a truncated
  // number, a weak OCR read, an amount/date that won't parse. These are the
  // dangerous ones: they look fine in the table but are quietly wrong.
  // Empty cells are counted separately (nullCount) since the user already
  // sees those as blanks.
  const suspectRows = useMemo(
    () => data.filter(r => r.value && (r.issues?.length ?? 0) > 0),
    [data],
  );
  const suspectCount = suspectRows.length;

  // "Review only" view — narrows the table to rows containing a flagged cell
  // so the user can work through just those. Off by default; when off this is
  // the untouched sortedGroups reference, so the normal table is unaffected.
  const visibleGroups = useMemo(() => {
    if (!showOnlySuspect) return sortedGroups;
    return sortedGroups
      .map(g => ({
        ...g,
        rows: g.rows.filter(row =>
          fieldColumns.some(f => {
            const c = row.cells[f];
            return c?.value && (c.issues?.length ?? 0) > 0;
          }),
        ),
      }))
      .filter(g => g.rows.length > 0);
  }, [sortedGroups, showOnlySuspect, fieldColumns]);
  const totalRows = visibleGroups.reduce((s, g) => s + g.rows.length, 0);
  // +1 for the delete column at the end, +1 for the actions column at the start
  const totalCols = 1 + (multiFile ? 1 : 0) + 1 + fieldColumns.length + 1;

  // Per-PDF sums for bank-statement credit/debit fields. This number is
  // what the exporter writes into the `Deposits` / `Withdrawals` cells —
  // shown in the panel so the user can see the sum without opening Excel.
  const parseMoney = (s: string | null | undefined): number => {
    if (!s) return 0;
    const n = parseFloat(String(s).replace(/[$,\s]/g, ''));
    return isNaN(n) ? 0 : n;
  };
  const perPdfSums = useMemo(() => {
    const byKey = new Map<string, { credit: number; debit: number; creditCount: number; debitCount: number }>();
    for (const r of data) {
      if (!r.value) continue;
      const key = r.sessionId || r.filename || 'unknown';
      if (!byKey.has(key)) byKey.set(key, { credit: 0, debit: 0, creditCount: 0, debitCount: 0 });
      const entry = byKey.get(key)!;
      if (r.field === 'total_credits') { entry.credit += parseMoney(r.value); entry.creditCount++; }
      if (r.field === 'total_debits')  { entry.debit  += parseMoney(r.value); entry.debitCount++; }
    }
    return byKey;
  }, [data]);
  // Load batches for the selector on mount
  useEffect(() => {
    fetch(`${BACKEND_URL}/api/batches`)
      .then(r => r.json())
      .then(d => { if (d.status === 'ok') setBatches(d.batches.map((b: any) => ({ id: b.id, name: b.name }))); })
      .catch(() => {});
  }, []);

  // Diagnostic: log the raw data shape so we can see whether multi-value
  // rows are reaching the panel. Open DevTools console and look for the
  // '[ExcelPanel]' line.
  useEffect(() => {
    if (data.length === 0) return;
    const perPageField: Record<string, Record<string, number>> = {};
    for (const r of data) {
      const pdfKey = (r.sessionId || r.filename || 'unknown') + '#p' + r.page;
      if (!perPageField[pdfKey]) perPageField[pdfKey] = {};
      perPageField[pdfKey][r.field] = (perPageField[pdfKey][r.field] || 0) + 1;
    }
    console.log('[ExcelPanel] data rows:', data.length,
      '· display rows:', totalRows,
      '· per (pdf+page) field counts:', perPageField);
  }, [data, totalRows]);

  return (
    <div className="h-full flex flex-col bg-background">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="bg-card border-b border-border px-5 py-3 shrink-0">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-sm font-bold text-foreground">Extracted Data</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {extracted} value{extracted !== 1 ? 's' : ''} extracted
              {nullCount > 0 && <span className="text-warning ml-1">· {nullCount} empty</span>}
            </p>
            {suspectCount > 0 && (
              <button
                type="button"
                onClick={() => setShowOnlySuspect(v => !v)}
                title={
                  showOnlySuspect
                    ? 'Show all rows again'
                    : `Show only rows with a flagged cell. These have a value, but it looks truncated, weakly OCR'd, or unparseable — they would otherwise pass unnoticed.`
                }
                className={`mt-1.5 inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium border transition-colors
                  ${showOnlySuspect
                    ? 'bg-warning/15 border-warning/50 text-warning'
                    : 'bg-warning/5 border-warning/30 text-warning hover:bg-warning/15'}`}
              >
                <AlertTriangle className="w-3 h-3" />
                {suspectCount} cell{suspectCount !== 1 ? 's' : ''} need{suspectCount === 1 ? 's' : ''} review
                {showOnlySuspect && <span className="opacity-70">· filtering</span>}
              </button>
            )}
            {suspectCount > 0 && onRepairFlagged && (
              <button
                type="button"
                onClick={() => {
                  const cells = suspectRows
                    .filter(r => r.sessionId)
                    .map(r => ({ sessionId: r.sessionId!, page: r.page, field: r.field }));
                  void onRepairFlagged(cells);
                }}
                title="Re-read only these cells, giving each box slack within its text line so a page whose text shifted a few mm still reads correctly. Cells that extracted cleanly are not touched, and anything that changes is marked for review."
                className="mt-1.5 ml-2 inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium border border-primary/40 text-primary hover:bg-primary/10 transition-colors"
              >
                <Wand2 className="w-3 h-3" />
                Try to fix {suspectCount === 1 ? 'it' : 'them'}
              </button>
            )}
          </div>
          <button
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-all duration-200"
            onClick={onClose}
            aria-label="Close panel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Batch selector — custom dropdown so we can inline a "Create new
            batch" affordance and give the newest batch a distinguishing
            colour. Batch creation now lives ONLY here; the Batches manager
            dialog is for editing / deleting / inspecting records. */}
        <div className="flex items-center gap-2 mb-2">
          <BatchSelectorDropdown
            batches={batches}
            activeBatchId={activeBatchId}
            onSelect={setActiveBatchId}
            onCreated={(newBatch) => {
              // Prepend so it becomes the "newest" and auto-select.
              setBatches(prev => [newBatch, ...prev]);
              setActiveBatchId(newBatch.id);
              toast.success(`Batch "${newBatch.name}" created`);
            }}
            username={user?.username ?? 'unknown'}
            // Doc type inherits from the session's active doc type — the
            // user already picked it at upload time.
            docType={forceDocType ?? 'utility_bill'}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs shrink-0"
            onClick={() => setShowBatchPanel(true)}
            title="Manage existing batches — rename, delete, inspect records"
          >
            <Layers className="w-3.5 h-3.5 mr-1" /> Batches
          </Button>
        </div>


        {/* Date source — only meaningful for utility exports. Lets the user
            pick which scraped field is used to bucket bills into month
            columns: billing_date (with the before-the-15th period
            roll-back) or the plain 'date' field (no day adjustment, the
            named month is the month the bill lands under). 'auto' uses
            billing_date when present and falls back to 'date'. */}
        {isUtilityExport(exportData) && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground shrink-0">Use date field:</span>
            <select
              className="h-7 px-2 rounded border border-border bg-background text-xs"
              value={utilityDateField}
              onChange={e => setUtilityDateField(e.target.value as 'auto' | 'billing_date' | 'date')}
              title="Pick which scraped field is used to bucket bills into month columns"
            >
              <option value="auto">Auto (billing_date, else date)</option>
              <option value="billing_date">Billing Date (rolls early bills to prior month)</option>
              <option value="date">Date (use the month as-is)</option>
            </select>
          </div>
        )}

        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="flex-1 h-8 text-xs" onClick={onReExtract}>
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Re-extract
          </Button>
          <Button
            size="sm"
            className="flex-1 h-8 text-xs bg-primary hover:bg-primary/90 text-primary-foreground font-semibold"
            onClick={async () => {
              // Pull the freshest server state for the active batch before
              // exporting. We use the RETURNED rows directly (not the
              // exportData memo) because setBatchSavedRows schedules a
              // React re-render but this async handler still holds the
              // pre-refresh exportData in closure — waiting on it here
              // would export stale data. Merge locally instead so every
              // sheet (Utility / Bank / Appraisal / Tax / Lease / Plain
              // Data) receives batch-saved + live rows in one array.
              const freshBatchRows = activeBatchId
                ? await refreshBatchSavedRows(activeBatchId)
                : [];
              const liveKeys = new Set(sortedFlat.map(r => `${r.sessionId}|${r.page}`));
              const prevOnly = freshBatchRows.filter(r => !liveKeys.has(`${r.sessionId}|${r.page}`));
              const finalData: ExtractedRow[] = [...prevOnly, ...sortedFlat];

              if (finalData.length === 0) { toast.error('No data to export'); return; }
              // For utility bills run the utility-specific scan FIRST so we
              // surface provider_name groups too — the bank scan ignores
              // provider and would otherwise pre-empt this branch.
              if (isUtilityExport(finalData)) {
                const utilGroups = findUtilityMergeOpportunities(finalData);
                if (utilGroups.length > 0) {
                  setPendingMergeAction('export');
                  setMergeGroups(utilGroups);
                  return;
                }
              } else {
                const bankGroups = findMergeOpportunities(finalData);
                if (bankGroups.length > 0) {
                  setPendingMergeAction('export');
                  setMergeGroups(bankGroups);
                  return;
                }
              }
              exportToExcel(finalData, filename, provider, { dateField: utilityDateField, forceDocType });
              onDownload?.();
            }}
          >
            <Download className="w-3.5 h-3.5 mr-1.5" />
            Export .xlsx
          </Button>
        </div>
      </div>

      {/* Batch manager overlay */}
      {showBatchPanel && (
        <BatchPanel
          username={user?.username ?? 'unknown'}
          activeBatchId={activeBatchId}
          onSelect={(id, name) => {
            setActiveBatchId(id);
            setShowBatchPanel(false);
            toast.success(`Batch "${name}" selected`);
          }}
          onClose={() => {
            setShowBatchPanel(false);
            fetch(`${BACKEND_URL}/api/batches`)
              .then(r => r.json())
              .then(d => { if (d.status === 'ok') setBatches(d.batches.map((b: any) => ({ id: b.id, name: b.name }))); })
              .catch(() => {});
          }}
        />
      )}

      {/* Shared merge dialog — gates either Export or Save-to-batch, depending
          on pendingMergeAction. On confirm we apply the chosen merges, then
          run whichever action opened the dialog. */}
      {conflict && (
        <MergeConflictDialog
          conflict={conflict}
          onCancel={discardMine}
          onResolve={merged => { void resolveConflict(merged); }}
        />
      )}

      {mergeGroups && (
        <MergeDialog
          groups={mergeGroups}
          onCancel={() => setMergeGroups(null)}
          onConfirm={(choices: MergeChoice[]) => {
            setMergeGroups(null);
            if (pendingMergeAction === 'batch') {
              // Apply merges to the live rows, reflect them in the UI, then
              // persist the merged data to the batch.
              const merged = choices.length > 0 ? applyMerges(data, choices) : data;
              if (choices.length > 0) onDataChange(merged);
              void runBatchSave(merged);
            } else {
              const merged = choices.length > 0 ? applyMerges(exportData, choices) : exportData;
              exportToExcel(merged, filename, provider, { dateField: utilityDateField, forceDocType });
              onDownload?.();
            }
          }}
        />
      )}

      {/* ── Scrollable table area ─────────────────────────────────────── */}
      <div className="flex-1 overflow-auto custom-scrollbar">
        {data.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
            <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
              <CheckCircle2 className="w-6 h-6 text-primary/50" />
            </div>
            <p className="text-sm text-muted-foreground">No values extracted yet.</p>
            <p className="text-xs text-muted-foreground/60">Draw highlight boxes over bill values then click Extract.</p>
          </div>
        ) : (
          <table className="w-max min-w-full text-xs border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="bg-primary text-primary-foreground text-[11px] font-semibold">
                {/* Actions column header: approve-all button sits directly
                    above the per-row approve buttons, so a single click
                    saves every un-approved row to the active batch. */}
                <th className="px-1 py-2.5 w-14 border-r border-white/10">
                  {(() => {
                    if (!activeBatchId) return null;
                    // Count rows that will ACTUALLY hit the network — split
                    // into "not yet saved" and "already saved but might
                    // have new fields". Both contribute to the total; the
                    // tooltip shows the breakdown so the user knows they
                    // can re-sync existing rows after adding more fields.
                    const seen = new Set<string>();
                    let newCount = 0;
                    let syncCount = 0;
                    for (const g of sortedGroups) {
                      for (const row of g.rows) {
                        const key = `${row.sessionId}-${row.page}`;
                        if (seen.has(key)) continue;
                        const hasValue = data.some(d => d.sessionId === row.sessionId && d.page === row.page && d.value);
                        if (!hasValue) continue;
                        seen.add(key);
                        if (approvedKeys.has(key)) syncCount++;
                        else newCount++;
                      }
                    }
                    const total = newCount + syncCount;
                    if (total === 0 && !approvingAll) return null;
                    const tooltipText = approvingAll
                      ? 'Saving to batch…'
                      : newCount > 0 && syncCount > 0
                        ? `Save ${newCount} new, re-sync ${syncCount} existing to batch`
                        : newCount > 0
                          ? `Save all ${newCount} row${newCount !== 1 ? 's' : ''} to batch`
                          : `Re-sync ${syncCount} row${syncCount !== 1 ? 's' : ''} (updates fields with any newly-extracted values)`;
                    return (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="w-6 h-6 rounded flex items-center justify-center bg-white/15 hover:bg-white/25
                                       disabled:opacity-50 disabled:cursor-not-allowed transition-colors mx-auto"
                            onClick={() => void handleApproveAll()}
                            disabled={approvingAll}
                            aria-label={tooltipText}
                          >
                            {approvingAll
                              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              : <CheckCircle2 className="w-3.5 h-3.5" />}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="right" className="text-xs max-w-[240px]">
                          {tooltipText}
                        </TooltipContent>
                      </Tooltip>
                    );
                  })()}
                </th>
                {multiFile && (
                  <th
                    className="text-left px-3 py-2.5 cursor-pointer hover:bg-white/10 select-none transition-all duration-200 whitespace-nowrap"
                    onClick={() => handleSort('filename')}
                  >
                    <span className="inline-flex items-center gap-1">File <SortIcon col="filename" /></span>
                  </th>
                )}
                <th
                  className="text-left px-3 py-2.5 cursor-pointer hover:bg-white/10 select-none transition-all duration-200 whitespace-nowrap"
                  onClick={() => handleSort('page')}
                >
                  <span className="inline-flex items-center gap-1">Page <SortIcon col="page" /></span>
                </th>
                {fieldColumns.map(f => {
                  const cfg = getFieldConfig(f);
                  return (
                    <th
                      key={f}
                      className="text-left px-3 py-2.5 cursor-pointer hover:bg-white/10 select-none transition-all duration-200 whitespace-nowrap border-l border-white/10"
                      onClick={() => handleSort(f)}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: cfg.color }} />
                        <span>{cfg.label}</span>
                        <SortIcon col={f} />
                      </span>
                    </th>
                  );
                })}
                <th className="px-2 py-2.5 w-7 border-l border-white/10" />
              </tr>
            </thead>
            <tbody>
              {visibleGroups.map((g, gi) => (
                <React.Fragment key={g.sessionId}>
                  {g.rows.map((row, ri) => {
                    const isLastInGroup = ri === g.rows.length - 1;
                    const rowKey = `${g.sessionId}-${row.page}-${row.subIndex}`;
                    const isSelected = selectedRowKey === rowKey;
                    const approveKey = `${row.sessionId}-${row.page}`;
                    const isApproved = approvedKeys.has(approveKey);
                    const isApproving = approvingKey === approveKey;
                    // An edit on an already-approved page is being pushed to
                    // the batch right now.
                    const isAutoSaving = autoSavingKeys.has(approveKey);
                    return (
                      <tr
                        key={rowKey}
                        className={`group/row transition-all duration-200 cursor-pointer
                          ${isApproved ? 'bg-green-500/10 hover:bg-green-500/15' : `hover:bg-primary/5 ${ri % 2 === 0 ? 'bg-card' : 'bg-muted/20'}`}
                          ${isApproved ? 'shadow-[inset_3px_0_0_0_#22c55e]' : isSelected ? 'bg-primary/10 shadow-[inset_3px_0_0_0_hsl(var(--primary))]' : ''}
                          ${isLastInGroup && gi < visibleGroups.length - 1 ? 'border-b-2 border-b-primary/40' : 'border-b border-border/40'}`}
                        onClick={() => {
                          // If the user just finished a text selection, treat the
                          // "click" as a selection end — don't navigate. Keeps
                          // cell values copiable (click-drag → Ctrl+C) while the
                          // row-click-to-scroll behavior still works on clean clicks.
                          const sel = window.getSelection?.();
                          if (sel && sel.toString().trim().length > 0) return;
                          setSelectedRowKey(rowKey);
                          onRowClick?.(row.sessionId, row.page);
                        }}
                      >
                        {/* Actions: re-extract + approve — shown on first sub-row of each page */}
                        <td className="px-1 py-2 w-14 border-r border-border/40">
                          {row.isFirstOfPage && (
                            <div className="flex items-center gap-0.5 justify-center">
                              {onReExtractPage && (
                                <button
                                  className="p-0.5 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all"
                                  title="Re-extract this page"
                                  onClick={e => { e.stopPropagation(); onReExtractPage(row.sessionId, row.page); }}
                                >
                                  <RefreshCw className="w-3 h-3" />
                                </button>
                              )}
                              <button
                                className={`p-0.5 rounded transition-all ${
                                  isApproved
                                    ? 'text-green-500 bg-green-500/15 hover:bg-green-500/25'
                                    : 'text-muted-foreground hover:text-green-500 hover:bg-green-500/10'
                                } ${isApproving ? 'opacity-40 pointer-events-none' : ''}`}
                                title={
                                  isAutoSaving
                                    ? 'Saving your edit to the batch…'
                                    : isApproved
                                      ? 'Approved — edits save to the batch automatically. Click to un-approve.'
                                      : 'Approve this row'
                                }
                                onClick={e => { e.stopPropagation(); void toggleApprove(row); }}
                              >
                                {isAutoSaving
                                  ? <Loader2 className="w-3 h-3 animate-spin" />
                                  : <Check className="w-3 h-3" />}
                              </button>
                            </div>
                          )}
                        </td>
                        {multiFile && (
                          <td className="px-3 py-2 text-muted-foreground text-[10px] truncate max-w-[140px]" title={g.filename}>
                            {ri === 0 ? g.filename.replace(/\.(pdf|docx?)$/i, '') : ''}
                          </td>
                        )}
                        <td className="px-3 py-2 text-muted-foreground font-medium">
                          {row.page}
                        </td>
                        {fieldColumns.map(f => {
                          const cell = row.cells[f];
                          const cellKey = `${g.sessionId}-${row.page}-${row.subIndex}-${f}`;
                          if (!cell) {
                            const emptyCellKey = `${g.sessionId}-${row.page}-${row.subIndex}-${f}`;
                            const isEditingEmpty = editingKey === emptyCellKey;
                            return (
                              <td
                                key={f}
                                className="px-3 py-2 border-l border-border/40 min-w-[120px] cursor-text"
                                onDoubleClick={() => setEditingKey(emptyCellKey)}
                                title="Double-click to add value"
                              >
                                {isEditingEmpty ? (
                                  <input
                                    className="w-full bg-card border border-primary rounded px-2 py-1 text-xs outline-none shadow-sm text-foreground"
                                    defaultValue=""
                                    autoFocus
                                    onClick={e => e.stopPropagation()}
                                    onBlur={e => {
                                      const val = e.target.value.trim();
                                      if (val) {
                                        const next = [...data, {
                                          page: row.page, field: f, value: val,
                                          confidence: 'high' as const, wasOcr: false,
                                          filename: row.filename, sessionId: row.sessionId,
                                          edited: true,
                                        }];
                                        onDataChange(next);
                                        // Filling a blank counts as an edit too.
                                        scheduleAutoSave(row.sessionId, row.page, next);
                                      }
                                      setEditingKey(null);
                                    }}
                                    onKeyDown={e => {
                                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                      if (e.key === 'Escape') setEditingKey(null);
                                    }}
                                  />
                                ) : (
                                  <span className="text-muted-foreground/30 italic">—</span>
                                )}
                              </td>
                            );
                          }
                          const isNull  = cell.value === null || cell.value === undefined || cell.value === '';
                          const pct     = CONF_PCT[cell.confidence ?? 'low'] ?? 25;
                          const pctColor = pct >= 90 ? '#22c55e' : pct >= 60 ? '#f59e0b' : '#ef4444';
                          const isEditing = editingKey === cellKey;
                          // Flagged cells have a value that looks wrong. Empty
                          // cells already read as "—" and are counted in the
                          // header, so we don't badge those too.
                          const cellIssues = (!isNull && cell.issues) ? cell.issues : [];
                          const hasIssues  = cellIssues.length > 0;
                          // Changed by the repair pass — the value moved without
                          // anyone typing it, so it must stay conspicuous until
                          // a human has looked at it.
                          const wasRepaired = !!cell.realigned;

                          return (
                            <td
                              key={f}
                              className={`px-3 py-2 cursor-text border-l border-border/40 min-w-[120px] select-text
                                ${wasRepaired ? 'bg-blue-500/15 shadow-[inset_2px_0_0_0_#3b82f6]' : hasIssues ? 'bg-warning/10' : ''}`}
                              onDoubleClick={() => setEditingKey(cellKey)}
                              onMouseDown={e => e.stopPropagation()}
                              title={isNull ? 'Double-click to edit' : String(cell.value)}
                            >
                              {isEditing ? (
                                <input
                                  className="w-full bg-card border border-primary rounded px-2 py-1 text-xs outline-none shadow-sm text-foreground"
                                  defaultValue={cell.value || ''}
                                  autoFocus
                                  onClick={e => e.stopPropagation()}
                                  onBlur={e => handleEdit(g.sessionId, row.page, f, row.subIndex, e.target.value)}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter') handleEdit(g.sessionId, row.page, f, row.subIndex, (e.target as HTMLInputElement).value);
                                    if (e.key === 'Escape') setEditingKey(null);
                                  }}
                                />
                              ) : (
                                <div className="flex items-center gap-2 min-w-0">
                                  {isNull ? (
                                    <span className="text-muted-foreground/40 italic">—</span>
                                  ) : (
                                    <span className={`truncate select-text ${cell.edited ? 'text-warning' : 'text-foreground'}`}>
                                      {cell.value}
                                    </span>
                                  )}
                                  {!isNull && (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <div className="ml-auto shrink-0 opacity-0 group-hover/row:opacity-100 transition-opacity">
                                          <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: pctColor }} />
                                        </div>
                                      </TooltipTrigger>
                                      <TooltipContent side="left" className="text-xs">
                                        <div className="space-y-0.5">
                                          <div>{pct >= 90 ? 'High' : pct >= 60 ? 'Medium' : 'Low'} accuracy ({pct}%)</div>
                                          {cell.wasOcr && <div className="text-amber-300">🔍 OCR extracted</div>}
                                        </div>
                                      </TooltipContent>
                                    </Tooltip>
                                  )}
                                  {wasRepaired && (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Wand2 className="w-3 h-3 text-blue-500 shrink-0" />
                                      </TooltipTrigger>
                                      <TooltipContent side="left" className="text-xs max-w-[280px]">
                                        <div className="space-y-1">
                                          <div className="font-semibold">Repaired — please confirm</div>
                                          <div>The box was realigned to its text line and re-read.</div>
                                          <div className="opacity-80">
                                            was: {cell.repairedFrom ? `"${cell.repairedFrom}"` : '(empty)'}
                                          </div>
                                          <div className="opacity-80">now: "{cell.value}"</div>
                                        </div>
                                      </TooltipContent>
                                    </Tooltip>
                                  )}
                                  {hasIssues && !wasRepaired && (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <AlertTriangle className="w-3 h-3 text-warning shrink-0" />
                                      </TooltipTrigger>
                                      <TooltipContent side="left" className="text-xs max-w-[260px]">
                                        <div className="space-y-1">
                                          <div className="font-semibold">Worth checking</div>
                                          {cellIssues.map(i => (
                                            <div key={i}>· {ISSUE_LABELS[i] ?? i}</div>
                                          ))}
                                          {cell.clippedText?.length ? (
                                            <div className="opacity-80">Cut word{cell.clippedText.length !== 1 ? 's' : ''}: {cell.clippedText.join(', ')}</div>
                                          ) : null}
                                          {typeof cell.ocrScore === 'number' && (
                                            <div className="opacity-80">OCR score: {(cell.ocrScore * 100).toFixed(0)}%</div>
                                          )}
                                        </div>
                                      </TooltipContent>
                                    </Tooltip>
                                  )}
                                  {cell.edited && <Pencil className="w-2.5 h-2.5 text-amber-500 shrink-0" />}
                                </div>
                              )}
                            </td>
                          );
                        })}
                        {/* Delete row button */}
                        <td className="px-1 py-2 w-7 border-l border-border/40">
                          {row.isFirstOfPage && (
                            <button
                              className="opacity-0 group-hover/row:opacity-60 hover:!opacity-100 p-0.5 rounded
                                         text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
                              onClick={e => { e.stopPropagation(); handleDeleteRow(row); }}
                              title="Remove this row"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {/* Per-PDF credit/debit sum banner — shown when either
                      field has multiple extracted values on this PDF, so the
                      user can eyeball the sum without opening Excel. */}
                  {(() => {
                    const sums = perPdfSums.get(g.sessionId);
                    if (!sums || (sums.creditCount <= 1 && sums.debitCount <= 1)) return null;
                    const sumCols = totalCols;
                    return (
                      <tr className="bg-primary/5 text-[11px]">
                        <td colSpan={sumCols} className="px-3 py-1.5 text-primary font-medium border-b border-primary/20">
                          Σ this PDF →
                          {sums.creditCount > 0 && (
                            <span className="ml-2">
                              Deposits: <b>${sums.credit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
                              <span className="text-muted-foreground"> ({sums.creditCount} value{sums.creditCount !== 1 ? 's' : ''})</span>
                            </span>
                          )}
                          {sums.debitCount > 0 && (
                            <span className="ml-4">
                              Withdrawals: <b>${sums.debit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
                              <span className="text-muted-foreground"> ({sums.debitCount} value{sums.debitCount !== 1 ? 's' : ''})</span>
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })()}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Footer summary ─────────────────────────────────────────────── */}
      {data.length > 0 && (
        <div className="bg-card border-t border-border px-5 py-2.5 shrink-0">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              {totalRows} row{totalRows !== 1 ? 's' : ''} across {visibleGroups.length} PDF{visibleGroups.length !== 1 ? 's' : ''}
              {showOnlySuspect && <span className="text-warning"> (review filter on)</span>} · double-click any cell to edit
            </span>
            <span className="text-primary font-medium">{extracted} extracted</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Batch selector dropdown ─────────────────────────────────────────────
// One click surface for two things:
//   1. Pick an existing batch (the newest gets a Sparkles icon + primary
//      tint so it's spottable at a glance).
//   2. Create a fresh batch inline — no modal. Enter → POST → auto-select.
// The Batches button next to this dropdown handles rename / delete / view
// records; creation was consolidated here so users don't have to open a
// separate manager just to spin up a new batch.
function BatchSelectorDropdown({
  batches, activeBatchId, onSelect, onCreated, username, docType,
}: {
  batches: { id: number; name: string }[];
  activeBatchId: number | null;
  onSelect: (id: number | null) => void;
  onCreated: (batch: { id: number; name: string }) => void;
  username: string;
  // Doc type baked into the new batch at creation — inherited from the
  // session's active doc type, which the user picked at upload time.
  docType: DocumentType;
}) {
  const [open, setOpen]           = useState(false);
  const [creating, setCreating]   = useState(false);
  const [name, setName]           = useState('');
  const [saving, setSaving]       = useState(false);
  const active = batches.find(b => b.id === activeBatchId);
  const newestId = batches[0]?.id;

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      // Doc type comes straight from the session's active doc type — the
      // user already picked it at upload time and shouldn't have to
      // choose again just to create a batch.
      const res = await fetch(`${BACKEND_URL}/api/batches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, created_by: username, doc_type: docType }),
      });
      const data = await res.json();
      if (data.status === 'ok') {
        onCreated({ id: data.batch.id, name: data.batch.name });
        setName('');
        setCreating(false);
        setOpen(false);
      } else {
        toast.error(data.error ?? 'Failed to create batch');
      }
    } catch {
      toast.error('Network error creating batch');
    }
    setSaving(false);
  };

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setCreating(false); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex-1 h-8 px-2 text-xs rounded-md border border-border bg-background text-foreground
                     hover:border-primary/50 transition-colors flex items-center justify-between gap-2 min-w-0"
        >
          <span className="flex items-center gap-1.5 min-w-0">
            {active && active.id === newestId && (
              <Sparkles className="w-3 h-3 text-primary shrink-0" />
            )}
            <span className="truncate">
              {active ? active.name : '— Select batch —'}
            </span>
          </span>
          <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-72 p-1.5" onOpenAutoFocus={(e) => e.preventDefault()}>
        {/* — Clear selection — */}
        <button
          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left transition-colors
            ${activeBatchId === null ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted'}`}
          onClick={() => { onSelect(null); setOpen(false); }}
        >
          <span className="w-3 h-3 shrink-0" />
          — Select batch —
        </button>

        {/* Batch list */}
        {batches.length > 0 && (
          <div className="max-h-64 overflow-y-auto mt-0.5 pr-0.5">
            {batches.map(b => {
              const isNewest = b.id === newestId;
              const isActive = b.id === activeBatchId;
              return (
                <button
                  key={b.id}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left transition-colors
                    ${isActive
                      ? 'bg-primary/15 text-primary font-medium'
                      : isNewest
                        ? 'text-foreground hover:bg-muted'
                        : 'text-foreground hover:bg-muted'}`}
                  onClick={() => { onSelect(b.id); setOpen(false); }}
                >
                  {isNewest ? (
                    <Sparkles className="w-3 h-3 shrink-0 text-primary" />
                  ) : (
                    <span className="w-3 h-3 shrink-0 rounded-full bg-muted-foreground/40" />
                  )}
                  <span className="truncate flex-1">{b.name}</span>
                  {isNewest && !isActive && (
                    <span className="text-[9px] px-1 py-0.5 rounded bg-primary/15 text-primary font-semibold uppercase shrink-0">
                      New
                    </span>
                  )}
                  {isActive && (
                    <Check className="w-3 h-3 shrink-0 text-primary" />
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Divider */}
        <div className="border-t border-border my-1.5" />

        {/* Create new — just a name field. Doc type inherits from the
            session's active doc type (already chosen at upload time). */}
        {creating ? (
          <div className="p-1 space-y-1.5">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate();
                if (e.key === 'Escape') { setCreating(false); setName(''); }
              }}
              placeholder="New batch name"
              className="w-full h-7 px-2 text-xs rounded border border-primary bg-background text-foreground outline-none focus:ring-1 focus:ring-primary"
            />
            <div className="flex gap-1">
              <Button
                size="sm"
                className="h-6 text-[11px] flex-1"
                onClick={handleCreate}
                disabled={saving || !name.trim()}
              >
                {saving ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Check className="w-3 h-3 mr-1" />}
                Create
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-[11px]"
                onClick={() => { setCreating(false); setName(''); }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <button
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left text-primary hover:bg-primary/10 transition-colors font-medium"
            onClick={() => { setName(''); setCreating(true); }}
          >
            <Plus className="w-3.5 h-3.5 shrink-0" />
            Create new batch
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
