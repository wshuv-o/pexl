import { useState, FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import { Loader2, Eye, EyeOff, LogOut } from "lucide-react";

const Login = () => {
  const { user, login, logout } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (!username || !password) { setError("Please enter your username and password"); return; }
    setLoading(true);
    const result = await login(username, password);
    setLoading(false);
    if (!result.ok) { setError(result.error || "Login failed"); return; }
    navigate("/");
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4 relative">

      {/* Logout button — top right, only if already logged in */}
      {user && (
        <button
          onClick={() => { logout(); }}
          className="absolute top-4 right-4 flex items-center gap-1.5 text-xs text-muted-foreground
                     hover:text-foreground transition-all duration-200 px-3 py-2 rounded-lg hover:bg-muted"
        >
          <LogOut className="w-3.5 h-3.5" />
          Sign out
        </button>
      )}

      <div className="w-full max-w-sm">

        {/* Logo + title */}
        <div className="flex flex-col items-center mb-8">
          <img src="/favicon.ico" alt="Pexl" className="w-11 h-11 rounded-xl mb-3" />
          <h1 className="text-xl font-bold text-foreground tracking-tight">Welcome back</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Sign in to Pexl</p>
        </div>

        <Card>
          <form onSubmit={handleSubmit}>
            <CardHeader className="pb-2">
              {error && (
                <div className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2.5 text-center">
                  {error}
                </div>
              )}
            </CardHeader>

            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="username" className="text-xs font-medium text-muted-foreground">
                  Username or email
                </label>
                <Input
                  id="username"
                  type="text"
                  placeholder="Enter your username"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  autoComplete="username"
                  autoFocus
                  className="h-10 bg-muted text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="password" className="text-xs font-medium text-muted-foreground">
                  Password
                </label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPw ? "text" : "password"}
                    placeholder="Enter your password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    autoComplete="current-password"
                    className="h-10 pr-10 bg-muted text-foreground placeholder:text-muted-foreground"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw(v => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-all duration-200"
                    tabIndex={-1}
                  >
                    {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </CardContent>

            <CardFooter>
              <Button
                type="submit"
                className="w-full h-10 bg-black text-white hover:bg-black/85 font-semibold text-sm"
                disabled={loading}
              >
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Sign in
              </Button>
            </CardFooter>
          </form>
        </Card>

        <p className="text-[11px] text-muted-foreground/50 text-center mt-8">
          Pexl - PDF Data Extractor
        </p>
      </div>
    </div>
  );
};

export default Login;
