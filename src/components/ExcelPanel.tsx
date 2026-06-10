/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useState, useMemo, useEffect } from 'react';
import { X, Download, RefreshCw, Pencil, CheckCircle2, ArrowUpDown, ArrowUp, ArrowDown, Trash2, Check, Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ExtractedRow, DocumentType } from '@/types/utilscraper';
import { getFieldConfig } from '@/types/utilscraper';
import { exportToExcel } from '@/lib/excel-export';
import {
  findMergeOpportunities, findUtilityMergeOpportunities, applyMerges,
  type MergeGroup, type MergeChoice,
} from '@/lib/bank-excel-export';
import MergeDialog from '@/components/bank/MergeDialog';
import BatchPanel from '@/components/BatchPanel';
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

// Mirror of detectDocType in excel-export.ts: returns true if the dominant
// doc type for this batch is utility_bill.
function isUtilityExport(rows: ExtractedRow[]): boolean {
  const fieldToType: Record<string, string> = {};
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
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  return top === 'utility_bill';
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
  data, filename, provider, onClose, onReExtract, onReExtractPage, onDataChange, multiFile, onDownload, onRowClick, onDeleteRow, externalBatchId, forceDocType,
}: Props) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [mergeGroups, setMergeGroups] = useState<MergeGroup[] | null>(null);
  // Date-source selector for utility exports. 'auto' picks billing_date
  // when any row has it, otherwise falls back to the 'date' field.
  const [utilityDateField, setUtilityDateField] = useState<'auto' | 'billing_date' | 'date'>('auto');
  const [sortCol, setSortCol]       = useState<string | null>(null);
  const [sortAsc, setSortAsc]       = useState(true);
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

  // Fetch saved batch records whenever the active batch changes
  useEffect(() => {
    if (!activeBatchId) { setBatchSavedRows([]); return; }
    fetch(`${BACKEND_URL}/api/batches/${activeBatchId}/records`)
      .then(r => r.json())
      .then((d: any) => {
        if (d.status !== 'ok') return;
        const rows: ExtractedRow[] = [];
        for (const rec of d.records) {
          for (const [field, value] of Object.entries(rec.fields as Record<string, string>)) {
            if (value) rows.push({ page: rec.page, field, value, confidence: 'high', wasOcr: false, filename: rec.filename, sessionId: rec.session_id });
          }
        }
        setBatchSavedRows(rows);
      })
      .catch(() => {});
  }, [activeBatchId]);
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
      pageRow.cellsMulti[row.field].push(row);

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

  const handleEdit = (cellKey: string, cell: ExtractedRow, newValue: string) => {
    const next = data.map(r =>
      r === cell ? { ...r, value: newValue, edited: true } : r,
    );
    onDataChange(next);
    setEditingKey(null);
    void cellKey;
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
  const totalRows = sortedGroups.reduce((s, g) => s + g.rows.length, 0);
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
          </div>
          <button
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-all duration-200"
            onClick={onClose}
            aria-label="Close panel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Batch selector */}
        <div className="flex items-center gap-2 mb-2">
          <select
            value={activeBatchId ?? ''}
            onChange={e => setActiveBatchId(e.target.value ? Number(e.target.value) : null)}
            className="flex-1 h-8 px-2 text-xs rounded-md border border-border bg-background text-foreground outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">— Select batch —</option>
            {batches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs shrink-0"
            onClick={() => setShowBatchPanel(true)}
            title="Manage batches"
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
            onClick={() => {
              if (exportData.length === 0) { toast.error('No data to export'); return; }
              // For utility bills run the utility-specific scan FIRST so we
              // surface provider_name groups too — the bank scan ignores
              // provider and would otherwise pre-empt this branch.
              if (isUtilityExport(exportData)) {
                const utilGroups = findUtilityMergeOpportunities(exportData);
                if (utilGroups.length > 0) {
                  setMergeGroups(utilGroups);
                  return;
                }
              } else {
                const bankGroups = findMergeOpportunities(exportData);
                if (bankGroups.length > 0) {
                  setMergeGroups(bankGroups);
                  return;
                }
              }
              exportToExcel(exportData, filename, provider, { dateField: utilityDateField, forceDocType });
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

      {/* Shared merge dialog — works for bank-style and utility-style groups */}
      {mergeGroups && (
        <MergeDialog
          groups={mergeGroups}
          onCancel={() => setMergeGroups(null)}
          onConfirm={(choices: MergeChoice[]) => {
            const merged = choices.length > 0 ? applyMerges(exportData, choices) : exportData;
            exportToExcel(merged, filename, provider, { dateField: utilityDateField, forceDocType });
            onDownload?.();
            setMergeGroups(null);
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
                {/* Actions column: re-extract + approve */}
                <th className="px-1 py-2.5 w-14 border-r border-white/10" />
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
              {sortedGroups.map((g, gi) => (
                <React.Fragment key={g.sessionId}>
                  {g.rows.map((row, ri) => {
                    const isLastInGroup = ri === g.rows.length - 1;
                    const rowKey = `${g.sessionId}-${row.page}-${row.subIndex}`;
                    const isSelected = selectedRowKey === rowKey;
                    const approveKey = `${row.sessionId}-${row.page}`;
                    const isApproved = approvedKeys.has(approveKey);
                    const isApproving = approvingKey === approveKey;
                    return (
                      <tr
                        key={rowKey}
                        className={`group/row transition-all duration-200 cursor-pointer
                          ${isApproved ? 'bg-green-500/10 hover:bg-green-500/15' : `hover:bg-primary/5 ${ri % 2 === 0 ? 'bg-card' : 'bg-muted/20'}`}
                          ${isApproved ? 'shadow-[inset_3px_0_0_0_#22c55e]' : isSelected ? 'bg-primary/10 shadow-[inset_3px_0_0_0_hsl(var(--primary))]' : ''}
                          ${isLastInGroup && gi < sortedGroups.length - 1 ? 'border-b-2 border-b-primary/40' : 'border-b border-border/40'}`}
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
                                title={isApproved ? 'Approved — click to un-approve' : 'Approve this row'}
                                onClick={e => { e.stopPropagation(); void toggleApprove(row); }}
                              >
                                <Check className="w-3 h-3" />
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
                                        onDataChange([...data, {
                                          page: row.page, field: f, value: val,
                                          confidence: 'high', wasOcr: false,
                                          filename: row.filename, sessionId: row.sessionId,
                                          edited: true,
                                        }]);
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

                          return (
                            <td
                              key={f}
                              className="px-3 py-2 cursor-text border-l border-border/40 min-w-[120px] select-text"
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
                                  onBlur={e => handleEdit(cellKey, cell, e.target.value)}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter') handleEdit(cellKey, cell, (e.target as HTMLInputElement).value);
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
            <span>{totalRows} row{totalRows !== 1 ? 's' : ''} across {sortedGroups.length} PDF{sortedGroups.length !== 1 ? 's' : ''} · double-click any cell to edit</span>
            <span className="text-primary font-medium">{extracted} extracted</span>
          </div>
        </div>
      )}
    </div>
  );
}
