/* eslint-disable no-empty */
import { createContext, useContext, useState, useEffect, ReactNode } from "react";

const ODIN_API = import.meta.env.VITE_ODIN_API_URL;
const TOKEN_KEY = "auth_token";

export interface User {
  id: number;
  username: string;
  email: string;
  roles: string[];
  employee: {
    id?: number;
    first_name?: string;
    last_name?: string;
    designation?: string;
    profile_photo_url?: string;
  } | null;
}

export interface UsageStats {
  files_processed: number;
  statements_extracted: number;
  downloads: number;
  /** Number of OCR'd PDFs the user has downloaded. */
  ocr_downloads: number;
  /** Number of table extracts performed
   *  (table-region Excel export + full-document "Convert to Table" Excel). */
  table_extracts: number;
  last_used: string | null;
}

/**
 * Either a Date, an epoch-ms number, or an ISO string. Trackers
 * normalise to ISO before POSTing so the backend stores one canonical
 * timestamp shape.
 */
export type UsageTime = Date | number | string;

interface AuthContextType {
  user: User | null;
  usage: UsageStats;
  authLoading: boolean;
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => void;
  /**
   * Records a batch processing event.
   *
   * @param uploadedAt — optional moment the user kicked off the upload
   *   (e.g. ``session.uploadedAt``). Used together with ``finishedAt``
   *   on the backend to compute "time saved" for the per-user
   *   dashboard.
   * @param finishedAt — optional moment the operation completed.
   *   Defaults to ``Date.now()`` if omitted.
   */
  trackUsage: (
    filesCount: number,
    statementsCount: number,
    docTypes?: string[],
    uploadedAt?: UsageTime,
    finishedAt?: UsageTime,
  ) => Promise<void>;
  trackDownload:     (uploadedAt?: UsageTime, finishedAt?: UsageTime) => Promise<void>;
  /** Bumps the ocr_downloads counter by 1. */
  trackOcrDownload:  (uploadedAt?: UsageTime, finishedAt?: UsageTime) => Promise<void>;
  /** Bumps the table_extracts counter by 1. */
  trackTableExtract: (uploadedAt?: UsageTime, finishedAt?: UsageTime) => Promise<void>;
}

const EMPTY_USAGE: UsageStats = {
  files_processed: 0,
  statements_extracted: 0,
  downloads: 0,
  ocr_downloads: 0,
  table_extracts: 0,
  last_used: null,
};
const AuthContext = createContext<AuthContextType | null>(null);

const getToken = () => localStorage.getItem(TOKEN_KEY);
const bearer = () => ({ Authorization: `Bearer ${getToken()}` });

// ── Change "pexl" to your app name in these two URLs ──
const USAGE_URL = `${ODIN_API}/pexl/usage`;

async function verifyToken(): Promise<User | null> {
  const token = getToken();
  if (!token) return null;
  try {
    const res = await fetch(`${ODIN_API}/auth/me`, { headers: bearer() });
    if (!res.ok) return null;
    const data = await res.json();
    return data.user ?? null;
  } catch {
    return null;
  }
}

async function apiFetchUsage(): Promise<UsageStats> {
  try {
    const res = await fetch(USAGE_URL, { headers: bearer() });
    if (!res.ok) return EMPTY_USAGE;
    return await res.json();
  } catch {
    return EMPTY_USAGE;
  }
}

async function apiPostUsage(body: object): Promise<void> {
  const token = getToken();
  if (!token) return;
  try {
    await fetch(USAGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer() },
      body: JSON.stringify(body),
    });
  } catch {}
}

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [usage, setUsage] = useState<UsageStats>(EMPTY_USAGE);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    // ── Localhost dev bypass ──────────────────────────────────────────────
    // When running `npm run dev` on localhost / 127.0.0.1 we inject a
    // synthetic admin user so the ProtectedRoute doesn't bounce you to
    // /login during local testing. Never fires in a production build
    // (Vite's import.meta.env.DEV is false there).
    if (import.meta.env.DEV && typeof window !== 'undefined') {
      const host = window.location.hostname;
      if (host === 'localhost' || host === '127.0.0.1') {
        setUser({
          id: 0,
          username: 'dev',
          email: 'dev@localhost',
          roles: ['admin'],
          employee: { first_name: 'Dev', last_name: 'Local', designation: 'Local dev' },
        });
        setAuthLoading(false);
        return;
      }
    }

    verifyToken().then(async me => {
      if (me) {
        setUser(me);
        setUsage(await apiFetchUsage());
      } else {
        localStorage.removeItem(TOKEN_KEY);
      }
      setAuthLoading(false);
    });
  }, []);

  const login = async (username: string, password: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(`${ODIN_API}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === "ACCOUNT_INACTIVE")
          return { ok: false, error: "Your account is inactive. Check your email for an activation link." };
        return { ok: false, error: data.error || "Login failed" };
      }
      localStorage.setItem(TOKEN_KEY, data.token);
      setUser(data.user);
      setUsage(await apiFetchUsage());
      return { ok: true };
    } catch {
      return { ok: false, error: "Could not reach the server. Try again." };
    }
  };

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
    setUsage(EMPTY_USAGE);
  };

  // ── Timestamp normalisation ──────────────────────────────────────
  // Trackers accept Date | epoch-ms | ISO string. Normalise to ISO
  // before POSTing so the backend always stores one canonical shape
  // (ISO 8601 UTC). Returns ``undefined`` when no timestamp was given,
  // which keeps the body lean and lets the backend default to ``NOW()``.
  const toIso = (t?: UsageTime): string | undefined => {
    if (t == null) return undefined;
    if (t instanceof Date) return t.toISOString();
    if (typeof t === "number") return new Date(t).toISOString();
    return t;  // already a string — assume ISO
  };

  const timingPayload = (uploadedAt?: UsageTime, finishedAt?: UsageTime) => {
    const out: { uploaded_at?: string; finished_at?: string } = {};
    const u = toIso(uploadedAt);
    const f = toIso(finishedAt) ?? new Date().toISOString();   // default end = now
    if (u) out.uploaded_at = u;
    out.finished_at = f;
    return out;
  };

  const trackUsage = async (
    filesCount: number,
    statementsCount: number,
    docTypes?: string[],
    uploadedAt?: UsageTime,
    finishedAt?: UsageTime,
  ): Promise<void> => {
    // doc_types is an array, one entry per session processed (e.g.
    // ['appraisal', 'utility_bill', 'appraisal']) so the backend can
    // surface per-type breakdowns in the admin usage view.
    await apiPostUsage({
      files_processed: filesCount,
      statements_extracted: statementsCount,
      downloads: 0,
      ...(docTypes && docTypes.length > 0 ? { doc_types: docTypes } : {}),
      ...timingPayload(uploadedAt, finishedAt),
    });
    setUsage(await apiFetchUsage());
  };

  const trackDownload = async (
    uploadedAt?: UsageTime,
    finishedAt?: UsageTime,
  ): Promise<void> => {
    await apiPostUsage({
      files_processed: 0,
      statements_extracted: 0,
      downloads: 1,
      ...timingPayload(uploadedAt, finishedAt),
    });
    setUsage(await apiFetchUsage());
  };

  const trackOcrDownload = async (
    uploadedAt?: UsageTime,
    finishedAt?: UsageTime,
  ): Promise<void> => {
    await apiPostUsage({
      files_processed: 0,
      statements_extracted: 0,
      downloads: 0,
      ocr_downloads: 1,
      ...timingPayload(uploadedAt, finishedAt),
    });
    setUsage(await apiFetchUsage());
  };

  const trackTableExtract = async (
    uploadedAt?: UsageTime,
    finishedAt?: UsageTime,
  ): Promise<void> => {
    await apiPostUsage({
      files_processed: 0,
      statements_extracted: 0,
      downloads: 0,
      table_extracts: 1,
      ...timingPayload(uploadedAt, finishedAt),
    });
    setUsage(await apiFetchUsage());
  };

  return (
    <AuthContext.Provider value={{
      user, usage, authLoading,
      login, logout,
      trackUsage, trackDownload, trackOcrDownload, trackTableExtract,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
};
