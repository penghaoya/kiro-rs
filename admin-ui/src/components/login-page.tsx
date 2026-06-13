import { useState, useEffect } from "react";
import { Eye, EyeOff, Loader2, Moon, Sun } from "lucide-react";
import { storage } from "@/lib/storage";
import { getCredentials } from "@/api/credentials";
import { extractErrorMessage } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useDarkMode } from "@/hooks/use-dark-mode";

interface LoginPageProps {
  onLogin: (apiKey: string) => void;
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { darkMode, toggle: toggleDarkMode } = useDarkMode();

  useEffect(() => {
    const savedKey = storage.getApiKey();
    if (savedKey) setApiKey(savedKey);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const key = apiKey.trim();
    if (!key || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    storage.setApiKey(key);
    try {
      await getCredentials();
      onLogin(key);
    } catch (err) {
      storage.removeApiKey();
      setError(extractErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center p-6">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-4 top-4 h-9 w-9 rounded-full text-muted-foreground"
        onClick={toggleDarkMode}
        title={darkMode ? "浅色" : "深色"}
      >
        {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </Button>

      <div className="w-full max-w-[360px] animate-fade-in">
        <div className="mb-8 flex flex-col items-center text-center">
          <img
            src="/admin/kirors.png"
            alt="Kiro"
            className="mb-4 h-[72px] w-[72px] object-contain"
            draggable={false}
          />
          <h1 className="text-[22px] font-semibold tracking-tight">Kiro-Kfc</h1>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col">
          <div className="relative">
            <Input
              type={showKey ? "text" : "password"}
              placeholder="Admin API Key"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setError(null);
              }}
              className="h-11 pr-10 font-mono text-sm"
              disabled={isSubmitting}
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground"
              onClick={() => setShowKey((v) => !v)}
              aria-label={showKey ? "隐藏" : "显示"}
              disabled={isSubmitting}
            >
              {showKey ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>

          {error && (
            <p className="mt-2.5 text-[13px] text-destructive">{error}</p>
          )}

          <Button
            type="submit"
            size="lg"
            className={`h-11 w-full ${error ? "mt-5" : "mt-8"}`}
            disabled={!apiKey.trim() || isSubmitting}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                登录中…
              </>
            ) : (
              "登录"
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
