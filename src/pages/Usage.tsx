/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import ThemeToggle from "@/components/ThemeToggle";
import {
  Loader2, LogOut, ArrowLeft, FileText, BarChart2, Download, Users, Layers, ScanText, Table2,
  Search, ChevronDown, Clock, ArrowUpDown,
} from "lucide-react";

const ODIN_API = import.meta.env.VITE_ODIN_API_URL;

interface UsageRow {
  id: number;
  user_id: number;
  username: string;
  full_name: string;
  designation: string | null;
  files_processed: number;
  statements_extracted: number;
  downloads: number;
  ocr_downloads: number;
  table_extracts: number;
  doc_types: string[] | null;
  used_at: string;
  /** Wall-clock moment the user kicked off the upload that produced
   *  this event. Optional — older rows (before this column existed)
   *  return ``null`` from the backend. Used by Odin EMS to compute
   *  ``finished_at - uploaded_at`` for the "time saved" report. */
  uploaded_at?: string | null;
  /** Wall-clock moment this usage event completed. Optional for the
   *  same backward-compat reason. */
  finished_at?: string | null;
  /** Server-computed gap in seconds (MySQL TIMESTAMPDIFF). Preferred
   *  over recomputing on the client because the timestamps are stored
   *  naively and the parse-as-UTC-or-local heuristic can drift; doing
   *  the math server-side sidesteps that entirely. */
  duration_seconds?: number | null;
}

type TimeRange = 'today' | 'week' | 'all';
type SortKey   = 'files' | 'extracted' | 'downloads' | 'ocr_downloads' | 'table_extracts' | 'lastActive';

// Parse a backend timestamp. The backend may send either:
//   (a) naive UTC      — "2026-04-20T22:00:00"  (FastAPI datetime.utcnow)
//   (b) naive local    — "2026-04-20T22:00:00"  (FastAPI datetime.now)
//   (c) ISO with tz    — "2026-04-20T22:00:00Z" or "+06:00"
// JavaScript's `new Date(iso)` treats case (a) and (b) the same — as LOCAL.
// Case (c) is unambiguous.
//
// If we force-append "Z" to make it UTC, we correctly handle (a) but break
// (b) — in UTC+6 a local 22:00 gets shifted ~6h forward, into tomorrow.
//
// Heuristic: try UTC first. If that lands the timestamp > 2h in the future,
// the backend is almost certainly sending local time → re-parse as local.
const parseTimestamp = (iso: string): Date => {
  if (!iso) return new Date(NaN);
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso);
  if (hasTz) return new Date(iso);
  const asUtc = new Date(`${iso}Z`);
  // If interpreting as UTC puts this in the future, it must have been local all along.
  if (asUtc.getTime() > Date.now() + 2 * 60 * 60 * 1000) {
    return new Date(iso);
  }
  return asUtc;
};

// All usage timestamps are surfaced in Bangladesh Standard Time so the
// dashboard reads the same regardless of where the viewer is sitting.
const BD_TZ = 'Asia/Dhaka';

const fmtDateTime = (iso: string) =>
  parseTimestamp(iso).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
    timeZone: BD_TZ,
  });

/** Format a duration given in seconds as "4.6 s" / "1m 12s" / "1h 5m". */
const fmtDurationSec = (totalSec: number): string => {
  if (!Number.isFinite(totalSec) || totalSec < 0) return '—';
  if (totalSec < 60) return `${totalSec.toFixed(1)} s`;
  const secs = Math.round(totalSec);
  const mins = Math.floor(secs / 60);
  const remS = secs % 60;
  if (mins < 60) return `${mins}m ${remS}s`;
  const hrs = Math.floor(mins / 60);
  const remM = mins % 60;
  return `${hrs}h ${remM}m`;
};

/** Format the gap between two ISO timestamps. Used as the client-side
 *  fallback for old rows where the server didn't populate
 *  duration_seconds. */
const fmtDuration = (fromIso?: string | null, toIso?: string | null): string => {
  if (!fromIso || !toIso) return '—';
  const a = parseTimestamp(fromIso).getTime();
  const b = parseTimestamp(toIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '—';
  return fmtDurationSec((b - a) / 1000);
};

const fmtRelative = (iso: string): string => {
  const then = parseTimestamp(iso).getTime();
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return parseTimestamp(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const isInRange = (iso: string, range: TimeRange): boolean => {
  if (range === 'all') return true;
  const t = parseTimestamp(iso).getTime();
  if (isNaN(t)) return false;
  if (range === 'today') {
    // Rolling last 24 hours — surfaces activity from late yesterday too,
    // which the user thinks of as "recent / today".
    return t >= Date.now() - 24 * 60 * 60 * 1000;
  }
  // week = last 7 × 24 h (rolling)
  return t >= Date.now() - 7 * 24 * 60 * 60 * 1000;
};

// ─── Stat card (top strip) ────────────────────────────────────────────────
// Clickable. When expanded it reveals the top contributors to that metric —
// e.g. "Downloads" shows which users downloaded the most.
type MetricKey = 'users' | 'batches' | 'files' | 'extracted' | 'downloads' | 'ocr_downloads' | 'table_extracts';

interface StatCardProps {
  icon: any;
  label: string;
  value: number;
  metric: MetricKey;
  expanded: boolean;
  onToggle: () => void;
  // Data used to populate the drill-down list when expanded.
  users: UserSummary[];
}

const StatCard = ({ icon: Icon, label, value, metric, expanded, onToggle, users }: StatCardProps) => {
  // Top 5 contributors for this metric. "users" metric just lists active ones.
  const top = useMemo(() => {
    if (metric === 'users') {
      return [...users]
        .sort((a, b) => parseTimestamp(b.lastActive).getTime() - parseTimestamp(a.lastActive).getTime())
        .slice(0, 5)
        .map(u => ({ name: u.full_name || u.username, value: u.sessions, suffix: u.sessions === 1 ? 'session' : 'sessions' }));
    }
    const getVal = (u: UserSummary): number => {
      switch (metric) {
        case 'batches':         return u.sessions;
        case 'files':           return u.files;
        case 'extracted':       return u.extracted;
        case 'downloads':       return u.downloads;
        case 'ocr_downloads':   return u.ocr_downloads;
        case 'table_extracts':  return u.table_extracts;
        default:                return 0;
      }
    };
    return [...users]
      .filter(u => getVal(u) > 0)
      .sort((a, b) => getVal(b) - getVal(a))
      .slice(0, 5)
      .map(u => ({ name: u.full_name || u.username, value: getVal(u), suffix: '' }));
  }, [users, metric]);

  const canExpand = value > 0;

  return (
    <div
      className={`bg-card border rounded-xl transition-all duration-200 overflow-hidden
        ${expanded ? 'border-primary shadow-md' : 'border-border hover:border-primary/40'}`}
    >
      <button
        className={`w-full p-4 flex items-center gap-3 text-left transition-colors
          ${canExpand ? 'cursor-pointer' : 'cursor-default'}`}
        onClick={() => { if (canExpand) onToggle(); }}
        disabled={!canExpand}
      >
        <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xl font-bold leading-none tabular-nums">{value.toLocaleString()}</p>
          <p className="text-[11px] text-muted-foreground mt-1 truncate">{label}</p>
        </div>
        {canExpand && (
          <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        )}
      </button>

      {expanded && top.length > 0 && (
        <div className="border-t border-border bg-muted/30 px-4 py-2 space-y-1">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Top {top.length}</p>
          {top.map((row, i) => (
            <div key={i} className="flex items-center justify-between text-[11px]">
              <span className="text-foreground truncate pr-2">{row.name}</span>
              <span className="text-muted-foreground tabular-nums shrink-0">
                {row.value.toLocaleString()}{row.suffix ? ` ${row.suffix}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// Compact inline stat used inside the row-layout user card.
const StatInline = ({ label, value }: { label: string; value: number }) => (
  <div className="flex items-baseline gap-1.5 min-w-0">
    <span className="text-sm font-bold tabular-nums text-foreground">{value.toLocaleString()}</span>
    <span className="text-[10px] text-muted-foreground uppercase tracking-wide truncate">{label}</span>
  </div>
);

// ─── Per-user summary + drill-down ───────────────────────────────────────
interface UserSummary {
  user_id: number;
  username: string;
  full_name: string;
  designation: string | null;
  files: number;
  extracted: number;
  downloads: number;
  ocr_downloads: number;
  table_extracts: number;
  sessions: number;
  lastActive: string;    // ISO
  // Per-doc-type session counts (e.g. { appraisal: 2, utility_bill: 1 })
  // — drives the breakdown pills on the user card.
  typeCounts: Record<string, number>;
  rows: UsageRow[];
}

const UserCard = ({
  summary, expanded, onToggle,
}: {
  summary: UserSummary;
  expanded: boolean;
  onToggle: () => void;
}) => {
  const initials = (summary.full_name || summary.username)
    .split(/\s+/).map(s => s[0]?.toUpperCase() ?? '').slice(0, 2).join('') || '?';

  return (
    <div className={`bg-card border rounded-xl overflow-hidden transition-all duration-200
      ${expanded ? 'border-primary shadow-sm' : 'border-border hover:border-primary/30'}`}>
      {/* Single horizontal row: avatar + identity | 3 stats | last-active | chevron */}
      <button
        className="w-full flex items-center gap-4 p-3 text-left"
        onClick={onToggle}
      >
        <div className="w-10 h-10 rounded-full bg-primary/15 text-primary font-semibold text-sm flex items-center justify-center shrink-0">
          {initials}
        </div>

        <div className="min-w-0 w-56 sm:w-64 shrink-0">
          <p className="font-semibold text-sm text-foreground truncate">
            {summary.full_name || summary.username}
          </p>
          <p className="text-[11px] text-muted-foreground truncate">
            {summary.username}{summary.designation ? ` · ${summary.designation}` : ''}
          </p>
        </div>

        {/* Stats inline — hidden on narrow screens, shown as a grid below instead */}
        <div className="hidden md:flex items-center gap-5 flex-1 min-w-0">
          <StatInline label="Files"          value={summary.files}          />
          <StatInline label="Extracted"      value={summary.extracted}      />
          <StatInline label="Downloads"      value={summary.downloads}      />
          <StatInline label="OCR Downloads"  value={summary.ocr_downloads}  />
          <StatInline label="Table Extracts" value={summary.table_extracts} />
        </div>

        <div className="hidden lg:flex flex-col items-end text-[11px] text-muted-foreground shrink-0 min-w-[120px]">
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" /> {fmtRelative(summary.lastActive)}
          </span>
          <span className="text-muted-foreground/70">
            {summary.sessions} session{summary.sessions !== 1 ? 's' : ''}
          </span>
        </div>

        <ChevronDown className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {/* Mobile fallback — stats in a compact grid under the header row */}
      <div className="md:hidden grid grid-cols-5 gap-px bg-border">
        <div className="bg-card py-2 text-center">
          <p className="text-sm font-bold tabular-nums leading-none">{summary.files}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5 uppercase tracking-wide">Files</p>
        </div>
        <div className="bg-card py-2 text-center">
          <p className="text-sm font-bold tabular-nums leading-none">{summary.extracted}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5 uppercase tracking-wide">Extracted</p>
        </div>
        <div className="bg-card py-2 text-center">
          <p className="text-sm font-bold tabular-nums leading-none">{summary.downloads}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5 uppercase tracking-wide">Downloads</p>
        </div>
        <div className="bg-card py-2 text-center">
          <p className="text-sm font-bold tabular-nums leading-none">{summary.ocr_downloads}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5 uppercase tracking-wide">OCR</p>
        </div>
        <div className="bg-card py-2 text-center">
          <p className="text-sm font-bold tabular-nums leading-none">{summary.table_extracts}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5 uppercase tracking-wide">Tables</p>
        </div>
      </div>
      <div className="md:hidden bg-muted/40 px-4 py-1.5 flex items-center justify-between text-[11px] text-muted-foreground border-t border-border">
        <span className="flex items-center gap-1">
          <Clock className="w-3 h-3" /> Last active {fmtRelative(summary.lastActive)}
        </span>
        <span>{summary.sessions} session{summary.sessions !== 1 ? 's' : ''}</span>
      </div>

      {/* Per-doc-type breakdown pills (e.g. "2 appraisal · 1 utility bill") */}
      {Object.keys(summary.typeCounts).length > 0 && (
        <div className="px-4 py-2 border-t border-border bg-muted/20 flex flex-wrap gap-1.5 text-[10px]">
          {Object.entries(summary.typeCounts)
            .sort(([, a], [, b]) => b - a)
            .map(([type, count]) => (
              <span
                key={type}
                className="px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium"
              >
                {count} {type.replace(/_/g, ' ')}
              </span>
            ))}
        </div>
      )}

      {expanded && (
        <div className="border-t border-border">
          <div className="max-h-[320px] overflow-auto custom-scrollbar">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-2 font-medium uppercase tracking-wide text-[10px]">Date & Time</th>
                  <th className="text-left px-4 py-2 font-medium uppercase tracking-wide text-[10px]">Uploaded</th>
                  <th className="text-left px-4 py-2 font-medium uppercase tracking-wide text-[10px]">Finished</th>
                  <th className="text-right px-3 py-2 font-medium uppercase tracking-wide text-[10px]">Duration</th>
                  <th className="text-right px-3 py-2 font-medium uppercase tracking-wide text-[10px]">Files</th>
                  <th className="text-right px-3 py-2 font-medium uppercase tracking-wide text-[10px]">Extracted</th>
                  <th className="text-right px-3 py-2 font-medium uppercase tracking-wide text-[10px]">Downloads</th>
                  <th className="text-right px-3 py-2 font-medium uppercase tracking-wide text-[10px]">OCR Downloads</th>
                  <th className="text-right px-3 py-2 font-medium uppercase tracking-wide text-[10px]">Table Extracts</th>
                  <th className="text-left px-4 py-2 font-medium uppercase tracking-wide text-[10px]">Doc Types</th>
                </tr>
              </thead>
              <tbody>
                {summary.rows.map((r, i) => (
                  <tr key={r.id} className={`border-b border-border last:border-0 ${i % 2 === 0 ? '' : 'bg-muted/20'}`}>
                    <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">{fmtDateTime(r.used_at)}</td>
                    <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">
                      {r.uploaded_at ? fmtDateTime(r.uploaded_at) : <span className="text-muted-foreground/50">—</span>}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">
                      {r.finished_at ? fmtDateTime(r.finished_at) : <span className="text-muted-foreground/50">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground whitespace-nowrap">
                      {typeof r.duration_seconds === 'number'
                        ? fmtDurationSec(r.duration_seconds)
                        : fmtDuration(r.uploaded_at, r.finished_at)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.files_processed > 0 ? r.files_processed : <span className="text-muted-foreground/50">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.statements_extracted > 0 ? r.statements_extracted : <span className="text-muted-foreground/50">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.downloads > 0 ? r.downloads : <span className="text-muted-foreground/50">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {(r.ocr_downloads ?? 0) > 0 ? r.ocr_downloads : <span className="text-muted-foreground/50">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {(r.table_extracts ?? 0) > 0 ? r.table_extracts : <span className="text-muted-foreground/50">—</span>}
                    </td>
                    <td className="px-4 py-2">
                      {r.doc_types && r.doc_types.length > 0
                        ? <span className="text-muted-foreground">{[...new Set(r.doc_types)].map(t => t.replace(/_/g, ' ')).join(', ')}</span>
                        : <span className="text-muted-foreground/50">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Main page ──────────────────────────────────────────────────────────
const Usage = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows]     = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState("");
  const [range, setRange]   = useState<TimeRange>('week');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('lastActive');
  const [expandedUserId, setExpandedUserId] = useState<number | null>(null);
  const [expandedStat, setExpandedStat] = useState<MetricKey | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("auth_token");
    fetch(`${ODIN_API}/pexl/usage/all`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => {
        if (!r.ok) throw new Error("Failed to load usage data");
        return r.json();
      })
      .then(setRows)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // ── Apply time filter first, then everything else derives from it ──
  const filteredRows = useMemo(
    () => rows.filter(r => isInRange(r.used_at, range)),
    [rows, range],
  );

  const totals = useMemo(() => {
    const t = { batches: 0, files: 0, extracted: 0, downloads: 0, ocr_downloads: 0, table_extracts: 0, users: 0 };
    for (const r of filteredRows) {
      if (r.files_processed > 0) t.batches++;
      t.files          += r.files_processed;
      t.extracted      += r.statements_extracted;
      t.downloads      += r.downloads;
      t.ocr_downloads  += r.ocr_downloads ?? 0;
      t.table_extracts += r.table_extracts ?? 0;
    }
    t.users = new Set(filteredRows.map(r => r.user_id)).size;
    return t;
  }, [filteredRows]);

  // ── Aggregate by user ──
  const userSummaries = useMemo<UserSummary[]>(() => {
    const map = new Map<number, UserSummary>();
    for (const r of filteredRows) {
      const cur = map.get(r.user_id);
      if (cur) {
        cur.files          += r.files_processed;
        cur.extracted      += r.statements_extracted;
        cur.downloads      += r.downloads;
        cur.ocr_downloads  += r.ocr_downloads ?? 0;
        cur.table_extracts += r.table_extracts ?? 0;
        cur.sessions       += 1;
        if (parseTimestamp(r.used_at) > parseTimestamp(cur.lastActive)) cur.lastActive = r.used_at;
        for (const t of r.doc_types ?? []) {
          cur.typeCounts[t] = (cur.typeCounts[t] || 0) + 1;
        }
        cur.rows.push(r);
      } else {
        const typeCounts: Record<string, number> = {};
        for (const t of r.doc_types ?? []) typeCounts[t] = (typeCounts[t] || 0) + 1;
        map.set(r.user_id, {
          user_id:        r.user_id,
          username:       r.username,
          full_name:      r.full_name,
          designation:    r.designation,
          files:          r.files_processed,
          extracted:      r.statements_extracted,
          downloads:      r.downloads,
          ocr_downloads:  r.ocr_downloads ?? 0,
          table_extracts: r.table_extracts ?? 0,
          sessions:       1,
          lastActive:     r.used_at,
          typeCounts,
          rows:           [r],
        });
      }
    }
    for (const u of map.values()) {
      u.rows.sort((a, b) => parseTimestamp(b.used_at).getTime() - parseTimestamp(a.used_at).getTime());
    }
    return Array.from(map.values());
  }, [filteredRows]);

  // ── Apply search filter + sort ──
  const displayedUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? userSummaries.filter(u =>
          u.username.toLowerCase().includes(q)
          || (u.full_name || '').toLowerCase().includes(q)
          || (u.designation || '').toLowerCase().includes(q))
      : userSummaries;

    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case 'files':          return b.files - a.files;
        case 'extracted':      return b.extracted - a.extracted;
        case 'downloads':      return b.downloads - a.downloads;
        case 'ocr_downloads':  return b.ocr_downloads - a.ocr_downloads;
        case 'table_extracts': return b.table_extracts - a.table_extracts;
        case 'lastActive':     return parseTimestamp(b.lastActive).getTime() - parseTimestamp(a.lastActive).getTime();
      }
    });
  }, [userSummaries, search, sortKey]);

  const sortOptions: { key: SortKey; label: string }[] = [
    { key: 'lastActive',     label: 'Last active' },
    { key: 'files',          label: 'Files' },
    { key: 'extracted',      label: 'Extracted' },
    { key: 'downloads',      label: 'Downloads' },
    { key: 'ocr_downloads',  label: 'OCR Downloads' },
    { key: 'table_extracts', label: 'Table Extracts' },
  ];

  const timeOptions: { key: TimeRange; label: string }[] = [
    { key: 'today', label: 'Today' },
    { key: 'week',  label: 'This week' },
    { key: 'all',   label: 'All time' },
  ];

  return (
    <div className="min-h-screen bg-background flex flex-col">

      {/* ── Header — matches Dashboard / OcrOnly ─────────────────── */}
      <header className="h-14 bg-card border-b border-border flex items-center px-6 gap-4 shrink-0">
        <button
          onClick={() => navigate("/")}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-all duration-200 px-2 py-1.5 rounded-lg hover:bg-muted"
          title="Back to dashboard"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Dashboard</span>
        </button>
        <div className="flex items-center gap-2.5">
          <img src="/favicon.ico" alt="Pexl" className="w-7 h-7 rounded-lg" />
          <div>
            <h1 className="text-base font-bold text-foreground">Usage Dashboard</h1>
            <p className="text-[11px] text-muted-foreground">All users · Pexl</p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground hidden md:block">{user?.username}</span>
          <ThemeToggle />
          <button
            onClick={() => { logout(); navigate("/login"); }}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-all duration-200 px-2 py-1.5 rounded-lg hover:bg-muted"
            title="Sign out"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      <main className="flex-1 container mx-auto px-4 py-6 space-y-5 max-w-6xl w-full">

        {/* ── Time range pills ─────────────────────────────────── */}
        <div className="flex items-center gap-1 bg-muted p-1 rounded-lg w-fit">
          {timeOptions.map(opt => (
            <button
              key={opt.key}
              onClick={() => setRange(opt.key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-150
                ${range === opt.key
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'}`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* ── Stat cards ────────────────────────────────────────── */}
        {!loading && !error && (() => {
          const toggle = (m: MetricKey) => () => setExpandedStat(prev => prev === m ? null : m);
          return (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3 items-start">
              <StatCard icon={Users}     label="Active users"     value={totals.users}          metric="users"          users={userSummaries} expanded={expandedStat === 'users'}          onToggle={toggle('users')} />
              <StatCard icon={Layers}    label="Sessions"         value={totals.batches}        metric="batches"        users={userSummaries} expanded={expandedStat === 'batches'}        onToggle={toggle('batches')} />
              <StatCard icon={FileText}  label="Files processed"  value={totals.files}          metric="files"          users={userSummaries} expanded={expandedStat === 'files'}          onToggle={toggle('files')} />
              <StatCard icon={BarChart2} label="Values extracted" value={totals.extracted}      metric="extracted"      users={userSummaries} expanded={expandedStat === 'extracted'}      onToggle={toggle('extracted')} />
              <StatCard icon={Download}  label="Downloads"        value={totals.downloads}      metric="downloads"      users={userSummaries} expanded={expandedStat === 'downloads'}      onToggle={toggle('downloads')} />
              <StatCard icon={ScanText}  label="OCR Downloads"    value={totals.ocr_downloads}  metric="ocr_downloads"  users={userSummaries} expanded={expandedStat === 'ocr_downloads'}  onToggle={toggle('ocr_downloads')} />
              <StatCard icon={Table2}    label="Table Extracts"   value={totals.table_extracts} metric="table_extracts" users={userSummaries} expanded={expandedStat === 'table_extracts'} onToggle={toggle('table_extracts')} />
            </div>
          );
        })()}

        {/* ── Loading / error states ────────────────────────────── */}
        {loading && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        )}
        {error && (
          <div className="bg-destructive/10 border border-destructive/20 text-destructive text-sm rounded-xl px-4 py-3 text-center">
            {error}
          </div>
        )}

        {/* ── User search + sort bar ────────────────────────────── */}
        {!loading && !error && (
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search user name, username, or designation..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full h-9 pl-9 pr-3 bg-card border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground/70 outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
            <div className="relative">
              <select
                value={sortKey}
                onChange={e => setSortKey(e.target.value as SortKey)}
                className="h-9 pl-8 pr-8 bg-card border border-border rounded-lg text-xs font-medium text-foreground outline-none focus:ring-2 focus:ring-primary/40 appearance-none cursor-pointer"
              >
                {sortOptions.map(o => <option key={o.key} value={o.key}>Sort: {o.label}</option>)}
              </select>
              <ArrowUpDown className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
              <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            </div>
          </div>
        )}

        {/* ── User cards grid ───────────────────────────────────── */}
        {!loading && !error && (
          displayedUsers.length === 0 ? (
            <div className="bg-card border border-border rounded-xl py-16 text-center text-sm text-muted-foreground">
              {search
                ? `No users matching "${search}"`
                : range === 'today'
                  ? 'No activity in the last 24 hours.'
                  : range === 'week'
                    ? 'No activity in the last 7 days.'
                    : 'No activity yet.'}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {displayedUsers.map(u => (
                <UserCard
                  key={u.user_id}
                  summary={u}
                  expanded={expandedUserId === u.user_id}
                  onToggle={() => setExpandedUserId(prev => prev === u.user_id ? null : u.user_id)}
                />
              ))}
            </div>
          )
        )}
      </main>
    </div>
  );
};

export default Usage;
