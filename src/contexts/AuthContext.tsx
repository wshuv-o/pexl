import { createContext, useContext, useState, useEffect, ReactNode } from "react";

const ODIN_API = import.meta.env.VITE_ODIN_API_URL; // https://api.odinems.bulkscraper.cloud/api
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
  last_used: string | null;
}

interface AuthContextType {
  user: User | null;
  usage: UsageStats;
  authLoading: boolean;
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  signup: (name: string, email: string, password: string) => { ok: boolean; error?: string };
  logout: () => void;
  trackUsage: (filesCount: number, statementsCount: number) => Promise<void>;
  trackDownload: () => Promise<void>;
}

const EMPTY_USAGE: UsageStats = {
  files_processed: 0,
  statements_extracted: 0,
  downloads: 0,
  last_used: null,
};

const AuthContext = createContext<AuthContextType | null>(null);

const getToken = () => localStorage.getItem(TOKEN_KEY);
const bearer = () => ({ Authorization: `Bearer ${getToken()}` });

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
    const res = await fetch(`${ODIN_API}/pexl/usage`, { headers: bearer() });
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
    await fetch(`${ODIN_API}/pexl/usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer() },
      body: JSON.stringify(body),
    });
  } catch {
    // Non-critical — silently ignore
  }
}

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [usage, setUsage] = useState<UsageStats>(EMPTY_USAGE);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
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
        if (data.code === "ACCOUNT_INACTIVE") {
          return { ok: false, error: "Your account is inactive. Check your email for an activation link." };
        }
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

  const signup = (_name: string, _email: string, _password: string): { ok: boolean; error?: string } => {
    // Placeholder — implement actual signup API call
    return { ok: false, error: "Signup is not yet implemented." };
  };

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
    setUsage(EMPTY_USAGE);
  };

  const trackUsage = async (filesCount: number, statementsCount: number): Promise<void> => {
    await apiPostUsage({ files_processed: filesCount, statements_extracted: statementsCount, downloads: 0 });
    setUsage(await apiFetchUsage());
  };

  const trackDownload = async (): Promise<void> => {
    await apiPostUsage({ files_processed: 0, statements_extracted: 0, downloads: 1 });
    setUsage(await apiFetchUsage());
  };

  return (
    <AuthContext.Provider value={{ user, usage, authLoading, login, signup, logout, trackUsage, trackDownload }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
};
