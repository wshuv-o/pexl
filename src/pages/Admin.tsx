/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import ThemeToggle from "@/components/ThemeToggle";
import {
  Loader2, LogOut, ArrowLeft, FileText, BarChart2, Download, Users, Layers,
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
  used_at: string;
}

type TimeRange = 'today' | 'week' | 'all';
type SortKey   = 'files' | 'extracted' | 'downloads' | 'lastActive';

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

const fmtDateTime = (iso: string) =>
  parseTimestamp(iso).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

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
    // Rolling last 24 hours — more useful than strict "since local midnight"
    // because it surfaces activity that happened shortly before midnight,
    // which the user thinks of as "recent / today".
    return t >= Date.now() - 24 * 60 * 60 * 1000;
  }
  // week = last 7 × 24 h (rolling)
  return t >= Date.now() - 7 * 24 * 60 * 60 * 1000;
};

// ─── Mini stat card (top strip) ──────────────────────────────────────────
const StatCard = ({ icon: Icon, label, value }: { icon: any; label: string; value: number }) => (
  <div className="bg-card border border-border rounded-xl p-4 flex items-center gap-3">
    <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
      <Icon className="h-4 w-4" />
    </div>
    <div className="min-w-0">
      <p className="text-xl font-bold leading-none tabular-nums">{value.toLocaleString()}</p>
      <p className="text-[11px] text-muted-foreground mt-1 truncate">{label}</p>
    </div>
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
  sessions: number;
  lastActive: string;    // ISO
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
    <div className="bg-card border border-border rounded-xl overflow-hidden transition-all duration-200 hover:border-primary/30">
      <button
        className="w-full flex items-center gap-3 p-4 text-left"
        onClick={onToggle}
      >
        <div className="w-10 h-10 rounded-full bg-primary/15 text-primary font-semibold text-sm flex items-center justify-center shrink-0">
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm text-foreground truncate">
            {summary.full_name || summary.username}
          </p>
          <p className="text-[11px] text-muted-foreground truncate">
            {summary.username}{summary.designation ? ` · ${summary.designation}` : ''}
          </p>
        </div>
        <ChevronDown className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      <div className="grid grid-cols-3 gap-px bg-border">
        <div className="bg-card py-2.5 text-center">
          <p className="text-base font-bold tabular-nums leading-none">{summary.files}</p>
          <p className="text-[10px] text-muted-foreground mt-1 uppercase tracking-wide">Files</p>
        </div>
        <div className="bg-card py-2.5 text-center">
          <p className="text-base font-bold tabular-nums leading-none">{summary.extracted}</p>
          <p className="text-[10px] text-muted-foreground mt-1 uppercase tracking-wide">Extracted</p>
        </div>
        <div className="bg-card py-2.5 text-center">
          <p className="text-base font-bold tabular-nums leading-none">{summary.downloads}</p>
          <p className="text-[10px] text-muted-foreground mt-1 uppercase tracking-wide">Downloads</p>
        </div>
      </div>

      <div className="bg-muted/40 px-4 py-2 flex items-center justify-between text-[11px] text-muted-foreground border-t border-border">
        <span className="flex items-center gap-1">
          <Clock className="w-3 h-3" /> Last active {fmtRelative(summary.lastActive)}
        </span>
        <span>{summary.sessions} session{summary.sessions !== 1 ? 's' : ''}</span>
      </div>

      {expanded && (
        <div className="border-t border-border">
          <div className="max-h-[320px] overflow-auto custom-scrollbar">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-2 font-medium uppercase tracking-wide text-[10px]">Date & Time</th>
                  <th className="text-right px-3 py-2 font-medium uppercase tracking-wide text-[10px]">Files</th>
                  <th className="text-right px-3 py-2 font-medium uppercase tracking-wide text-[10px]">Extracted</th>
                  <th className="text-right px-4 py-2 font-medium uppercase tracking-wide text-[10px]">Downloads</th>
                </tr>
              </thead>
              <tbody>
                {summary.rows.map((r, i) => (
                  <tr key={r.id} className={`border-b border-border last:border-0 ${i % 2 === 0 ? '' : 'bg-muted/20'}`}>
                    <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">{fmtDateTime(r.used_at)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.files_processed > 0 ? r.files_processed : <span className="text-muted-foreground/50">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.statements_extracted > 0 ? r.statements_extracted : <span className="text-muted-foreground/50">—</span>}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {r.downloads > 0 ? r.downloads : <span className="text-muted-foreground/50">—</span>}
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
const Admin = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows]     = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState("");
  const [range, setRange]   = useState<TimeRange>('week');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('lastActive');
  const [expandedUserId, setExpandedUserId] = useState<number | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("auth_token");
    fetch(`${ODIN_API}/pexl/admin/usage`, {
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
    const t = { batches: 0, files: 0, extracted: 0, downloads: 0, users: 0 };
    for (const r of filteredRows) {
      if (r.files_processed > 0) t.batches++;
      t.files     += r.files_processed;
      t.extracted += r.statements_extracted;
      t.downloads += r.downloads;
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
        cur.files     += r.files_processed;
        cur.extracted += r.statements_extracted;
        cur.downloads += r.downloads;
        cur.sessions  += 1;
        if (parseTimestamp(r.used_at) > parseTimestamp(cur.lastActive)) cur.lastActive = r.used_at;
        cur.rows.push(r);
      } else {
        map.set(r.user_id, {
          user_id:     r.user_id,
          username:    r.username,
          full_name:   r.full_name,
          designation: r.designation,
          files:       r.files_processed,
          extracted:   r.statements_extracted,
          downloads:   r.downloads,
          sessions:    1,
          lastActive:  r.used_at,
          rows:        [r],
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
        case 'files':      return b.files - a.files;
        case 'extracted':  return b.extracted - a.extracted;
        case 'downloads':  return b.downloads - a.downloads;
        case 'lastActive': return parseTimestamp(b.lastActive).getTime() - parseTimestamp(a.lastActive).getTime();
      }
    });
  }, [userSummaries, search, sortKey]);

  const sortOptions: { key: SortKey; label: string }[] = [
    { key: 'lastActive', label: 'Last active' },
    { key: 'files',      label: 'Files' },
    { key: 'extracted',  label: 'Extracted' },
    { key: 'downloads',  label: 'Downloads' },
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
          onClick={() => navigate("/dashboard")}
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
        {!loading && !error && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <StatCard icon={Users}     label="Active users"    value={totals.users} />
            <StatCard icon={Layers}    label="Sessions"        value={totals.batches} />
            <StatCard icon={FileText}  label="Files processed" value={totals.files} />
            <StatCard icon={BarChart2} label="Values extracted" value={totals.extracted} />
            <StatCard icon={Download}  label="Downloads"       value={totals.downloads} />
          </div>
        )}

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
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
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

export default Admin;
