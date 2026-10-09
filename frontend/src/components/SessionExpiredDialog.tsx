import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { currentUser, hasUnsavedWork, SESSION_EXPIRED_EVENT, type SessionUser } from "../lib/api";

/**
 * Shown when the server ends the session while a page is open. The page underneath keeps its state (a half-written
 * entry stays in its form); signing in again here continues where the person was. If somebody else signs in, nothing of
 * the previous person's page is kept.
 */
export function SessionExpiredDialog() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refusedMethod = useRef("GET");
  const passwordInput = useRef<HTMLInputElement>(null);
  const user = currentUser();

  useEffect(() => {
    const onExpired = (event: Event) => {
      refusedMethod.current = (event as CustomEvent<{ method?: string }>).detail?.method ?? "GET";
      setOpen(true);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  useEffect(() => {
    if (open) passwordInput.current?.focus();
  }, [open]);

  if (!open) return null;

  const leave = () => {
    localStorage.removeItem("user");
    setOpen(false);
    navigate("/login");
  };

  const signIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return leave();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: user.nickname, password }),
      });
      const body = (await response.json().catch(() => null)) as { user?: SessionUser; error?: string; code?: string } | null;
      if (!response.ok || !body?.user) {
        setError(response.status === 429 || body?.code === "PASSWORD_EXPIRED" ? (body?.error ?? "Přihlášení se nezdařilo") : "Neplatné heslo");
        return;
      }
      localStorage.setItem("user", JSON.stringify(body.user));
      setPassword("");
      setOpen(false);
      if (body.user.mustChangePwd) {
        navigate("/change-password");
      } else if (refusedMethod.current === "GET" && !hasUnsavedWork()) {
        // A page that could not load its data has nothing to lose: load it again.
        window.location.reload();
      }
      // Otherwise the page stays as it is and the person repeats what they were doing (saving, signing, ...).
    } catch {
      setError("Server neodpovídá. Zkuste to znovu.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="session-expired-title" className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <form onSubmit={(e) => void signIn(e)} className="w-full max-w-sm space-y-4 rounded-lg bg-white p-6 shadow-xl">
        <h2 id="session-expired-title" className="text-lg font-bold text-gray-900">
          Přihlášení vypršelo
        </h2>
        <p className="text-sm text-gray-600">Vaše práce na stránce zůstala, jak byla. Přihlaste se znovu a zopakujte, co jste dělali (například uložení).</p>
        <p className="text-sm text-gray-800">
          Uživatel: <strong>{user?.nickname ?? "?"}</strong>
        </p>
        <div>
          <label htmlFor="session-expired-password" className="mb-1 block text-xs font-medium text-gray-700">
            Heslo
          </label>
          <input
            id="session-expired-password"
            ref={passwordInput}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded border border-gray-300 p-2 text-sm"
          />
        </div>
        {error && (
          <div role="alert" className="text-sm text-red-600">
            {error}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 border-t pt-3">
          <button type="button" onClick={leave} className="text-sm text-gray-600 underline hover:text-gray-900">
            Odhlásit
          </button>
          <button
            type="submit"
            disabled={busy || password.length === 0}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            Přihlásit se
          </button>
        </div>
      </form>
    </div>
  );
}
