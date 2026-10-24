import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, currentUser, json } from "../../lib/api";
import { passwordRules } from "../../lib/passwordPolicy";
import { Banner, Button, Field, TextInput } from "../../components/ui";
import { usePageTitle } from "../../lib/pageTitle";

/** Change one's own password. Shown at once after the first login (temporary password) and reachable from the header. */
export const ChangePasswordPage: React.FC = () => {
  usePageTitle("Změna hesla");
  const navigate = useNavigate();
  const forced = currentUser()?.mustChangePwd === true;
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  // The person has gone on from the repeat field (or tried to send the form): only then is a repeat that is still shorter than the new
  // password called wrong. While they type it, it is not wrong yet.
  const [repeatLeft, setRepeatLeft] = useState(false);
  const [busy, setBusy] = useState(false);

  const rules = passwordRules(newPassword, currentUser()?.nickname);
  const rulesOk = rules.every((r) => r.ok);
  const matches = newPassword.length > 0 && newPassword === repeat;
  const canSubmit = !busy && currentPassword.length > 0 && rulesOk && matches;
  // A mistake is said when the repeat is as long as the new password (it cannot be a start of it any more) or the person has left the field
  const showMismatch = repeat.length > 0 && !matches && (repeatLeft || repeat.length >= newPassword.length);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) {
      setRepeatLeft(true);
      return;
    }
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

  return (
    <div className="mx-auto max-w-md px-4 py-6 sm:py-10">
      <h1 className="text-2xl font-bold text-ink">Změna hesla</h1>
      {forced && (
        <Banner tone="warning" className="mt-2">
          Máte přidělené dočasné heslo. Než budete pokračovat, zvolte si vlastní.
        </Banner>
      )}
      <form onSubmit={(e) => void handleSubmit(e)} className="mt-6 space-y-4">
        {error && <Banner tone="danger">{error}</Banner>}
        <Field id="current-password" label="Stávající heslo">
          <TextInput name="currentPassword" type="password" autoComplete="current-password" required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
        </Field>
        <Field id="new-password" label="Nové heslo">
          <TextInput name="newPassword" type="password" autoComplete="new-password" required value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          <ul className="mt-2 space-y-0.5 text-xs" aria-label="Požadavky na heslo">
            {rules.map((rule) => (
              <li key={rule.label} className={rule.ok ? "text-success-ink" : "text-ink-muted"}>
                {rule.ok ? "✓" : "○"} {rule.label}
              </li>
            ))}
          </ul>
        </Field>
        <Field id="repeat-password" label="Nové heslo znovu" error={showMismatch ? "Hesla se neshodují." : undefined} errorRole={repeatLeft ? "alert" : "status"}>
          <TextInput
            name="repeatPassword"
            type="password"
            autoComplete="new-password"
            required
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            onFocus={() => setRepeatLeft(false)}
            onBlur={() => setRepeatLeft(true)}
          />
        </Field>
        <Button type="submit" block disabled={!canSubmit}>
          Změnit heslo
        </Button>
      </form>
    </div>
  );
};
