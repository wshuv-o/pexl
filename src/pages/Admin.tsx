/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, LogOut, ArrowLeft, FileText, BarChart2, Download, Users, Layers } from "lucide-react";

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

const fmt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

const StatCard = ({ icon: Icon, label, value }: { icon: any; label: string; value: number }) => (
  <Card>
    <CardContent className="flex items-center gap-3 py-4">
      <div className="p-2 rounded-md bg-primary/10 text-primary">
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-2xl font-bold leading-none">{value.toLocaleString()}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
      </div>
    </CardContent>
  </Card>
);

const Admin = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const token = localStorage.getItem("auth_token");
    fetch(`${ODIN_API}/bankstatement/admin/usage`, {
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

  const totals = rows.reduce(
    (acc, r) => ({
      batches: acc.batches + (r.files_processed > 0 ? 1 : 0),
      files: acc.files + r.files_processed,
      extracted: acc.extracted + r.statements_extracted,
      downloads: acc.downloads + r.downloads,
      users: acc.users,
    }),
    { batches: 0, files: 0, extracted: 0, downloads: 0, users: 0 }
  );
  totals.users = new Set(rows.map(r => r.user_id)).size;

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-primary text-primary-foreground py-4 px-4 shadow-md">
        <div className="container mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/")}
              className="text-primary-foreground hover:text-primary-foreground hover:bg-primary-foreground/20 gap-1.5"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Back</span>
            </Button>
            <div>
              <h1 className="text-xl font-bold tracking-tight">Usage Dashboard</h1>
              <p className="text-xs opacity-80 mt-0.5">All users · Bank Statement Scraper</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm opacity-90 hidden md:block">{user?.username}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { logout(); navigate("/login"); }}
              className="text-primary-foreground hover:text-primary-foreground hover:bg-primary-foreground/20 gap-1.5"
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        {/* Summary cards */}
        {!loading && !error && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <StatCard icon={Users}     label="Active users"         value={totals.users} />
            <StatCard icon={Layers}    label="Total batches"        value={totals.batches} />
            <StatCard icon={FileText}  label="Files submitted"      value={totals.files} />
            <StatCard icon={BarChart2} label="Statements extracted" value={totals.extracted} />
            <StatCard icon={Download}  label="Downloads"            value={totals.downloads} />
          </div>
        )}

        {/* Detail table */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Activity Log</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {loading && (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            )}
            {error && (
              <p className="text-sm text-destructive text-center py-10">{error}</p>
            )}
            {!loading && !error && rows.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-10">No activity yet.</p>
            )}
            {!loading && !error && rows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted text-muted-foreground text-xs uppercase tracking-wide">
                      <th className="text-left px-4 py-3">Date & Time</th>
                      <th className="text-left px-4 py-3">Name</th>
                      <th className="text-left px-4 py-3 hidden md:table-cell">Designation</th>
                      <th className="text-right px-4 py-3">Files</th>
                      <th className="text-right px-4 py-3">Extracted</th>
                      <th className="text-right px-4 py-3">Downloads</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={r.id} className={`border-b last:border-0 ${i % 2 === 0 ? "" : "bg-muted/30"}`}>
                        <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                          {fmt(r.used_at)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium leading-none">{r.full_name || r.username}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">{r.username}</div>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground hidden md:table-cell">
                          {r.designation || "—"}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs">
                          {r.files_processed > 0 ? r.files_processed : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs">
                          {r.statements_extracted > 0 ? r.statements_extracted : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs">
                          {r.downloads > 0 ? r.downloads : <span className="text-muted-foreground">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
};

export default Admin;
