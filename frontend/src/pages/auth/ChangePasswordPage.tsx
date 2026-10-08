import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, currentUser, json } from "../../lib/api";
import { passwordRules } from "../../lib/passwordPolicy";

/** Change one's own password. Shown at once after the first login (temporary password) and reachable from the header. */
export const ChangePasswordPage: React.FC = () => {
  const navigate = useNavigate();
  const forced = currentUser()?.mustChangePwd === true;
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const rules = passwordRules(newPassword);
  const rulesOk = rules.every((r) => r.ok);
  const matches = newPassword.length > 0 && newPassword === repeat;
  const canSubmit = !busy && currentPassword.length > 0 && rulesOk && matches;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError("");
    setBusy(true);
    try {
      await api<{ status: string }>("/api/auth/change-password", {
        method: "POST",
        body: json({ currentPassword, newPassword }),
      });
      const user = currentUser();
      if (user) localStorage.setItem("user", JSON.stringify({ ...user, mustChangePwd: false }));
      navigate("/projects");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Heslo se nepodařilo změnit");
    } finally {
      setBusy(false);
    }
  };

  const input = "w-full rounded-md border border-gray-300 p-2 text-sm";

  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-2xl font-bold text-gray-900">Změna hesla</h1>
      {forced && <p className="mt-2 rounded bg-amber-50 p-3 text-sm text-amber-900">Máte přidělené dočasné heslo. Než budete pokračovat, zvolte si vlastní.</p>}
      <form onSubmit={(e) => void handleSubmit(e)} className="mt-6 space-y-4">
        {error && (
          <div role="alert" className="rounded bg-red-100 p-3 text-sm text-red-700">
            {error}
          </div>
        )}
        <div>
          <label htmlFor="current-password" className="mb-1 block text-sm font-medium text-gray-700">
            Stávající heslo
          </label>
          <input
            id="current-password"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
            className={input}
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="new-password" className="mb-1 block text-sm font-medium text-gray-700">
            Nové heslo
          </label>
          <input
            id="new-password"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            required
            className={input}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <ul className="mt-2 space-y-0.5 text-xs" aria-label="Požadavky na heslo">
            {rules.map((rule) => (
              <li key={rule.label} className={rule.ok ? "text-green-700" : "text-gray-500"}>
                {rule.ok ? "✓" : "○"} {rule.label}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <label htmlFor="repeat-password" className="mb-1 block text-sm font-medium text-gray-700">
            Nové heslo znovu
          </label>
          <input
            id="repeat-password"
            name="repeatPassword"
            type="password"
            autoComplete="new-password"
            required
            className={input}
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
          {repeat.length > 0 && !matches && <p className="mt-1 text-xs text-red-600">Hesla se neshodují.</p>}
        </div>
        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Změnit heslo
        </button>
      </form>
    </div>
  );
};
