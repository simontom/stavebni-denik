import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { currentUser, hasUnsavedWork, setUnsavedWork, SESSION_EXPIRED_EVENT, unsavedWorkIsKeptAsDraft, type SessionUser } from "../lib/api";
import { browserStorage, clearAllDrafts } from "../lib/draftStore";
import { Button, Field, Modal, TextInput, useModal } from "./ui";

/**
 * Shown when the server ends the session while a page is open. The page underneath keeps its state (a half-written
 * entry stays in its form); signing in again here continues where the person was. Only the same account can sign in here (the
 * name is fixed), so a page never carries on under somebody else.
 *
 * It is a modal `<dialog>` of the shared [Modal], like every other dialog, and that is what makes it reachable: a dialog that is
 * open when the session ends (a form with twenty meters typed into it) is in the browser's top layer, where a plain overlay cannot
 * be put above it, and the person could neither sign in nor leave. A modal dialog that opens later stacks on top of the others, makes
 * them inert while it is there, and gives the focus back when it closes, so the form is still there, with its text, once the person is
 * signed in again. Escape does nothing: the person signs in or leaves.
 */
export function SessionExpiredDialog() {
  // The method of the request that was refused (null: the dialog is closed).
  const [refusedMethod, setRefusedMethod] = useState<string | null>(null);

  useEffect(() => {
    const onExpired = (event: Event) => setRefusedMethod((event as CustomEvent<{ method?: string }>).detail?.method ?? "GET");
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  if (refusedMethod === null) return null;
  return <ExpiredDialog refusedMethod={refusedMethod} onClosed={() => setRefusedMethod(null)} />;
}

function ExpiredDialog({ refusedMethod, onClosed }: { refusedMethod: string; onClosed: () => void }) {
  const passwordInput = useRef<HTMLInputElement>(null);
  return (
    <Modal
      title="Přihlášení vypršelo"
      description="Vaše práce na stránce zůstala, jak byla. Přihlaste se znovu a zopakujte, co jste dělali (například uložení)."
      size="sm"
      dismissible={false}
      onCancel={() => undefined}
      initialFocus={passwordInput}
    >
      <ExpiredForm refusedMethod={refusedMethod} onClosed={onClosed} passwordInput={passwordInput} />
    </Modal>
  );
}

function ExpiredForm({ refusedMethod, onClosed, passwordInput }: { refusedMethod: string; onClosed: () => void; passwordInput: React.RefObject<HTMLInputElement | null> }) {
  const navigate = useNavigate();
  const modal = useModal();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const user = currentUser();

  const leave = () => {
    // Signing out for good: nothing of the page stays on the device (a draft holds the names of the people on site), and
    // the guard that asks before leaving a page with unsaved work must let this through (the button says what is thrown away).
    setUnsavedWork(false);
    clearAllDrafts(browserStorage());
    localStorage.removeItem("user");
    modal.close(() => {
      onClosed();
      navigate("/login");
    });
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
      const signedIn = body.user;
      // Closed first, while it is still in the document: the focus goes back to what had it (the field being typed in, the button
      // that was pressed), also inside a dialog that was open underneath.
      modal.close(
        () => {
          onClosed();
          if (signedIn.mustChangePwd) {
            navigate("/change-password");
          } else if (refusedMethod === "GET" && !hasUnsavedWork()) {
            // A page that could not load its data has nothing to lose: load it again.
            window.location.reload();
          }
          // Otherwise the page stays as it is and the person repeats what they were doing (saving, signing, ...).
        },
        { restoreFocus: true },
      );
    } catch {
      setError("Server neodpovídá. Zkuste to znovu.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void signIn(e)} className="space-y-4">
      {unsavedWorkIsKeptAsDraft() && <p className="text-sm text-ink">Rozepsaný text je uložený i v tomto zařízení; odhlášením se smaže.</p>}
      <p className="text-sm text-ink">
        Uživatel: <strong>{user?.nickname ?? "?"}</strong>
      </p>
      <Field id="session-expired-password" label="Heslo" error={error || undefined}>
        <TextInput ref={passwordInput} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <Button variant="quiet" onClick={leave}>
          {hasUnsavedWork() ? "Odhlásit a zahodit změny" : "Odhlásit"}
        </Button>
        <Button type="submit" disabled={busy || password.length === 0}>
          Přihlásit se
        </Button>
      </div>
    </form>
  );
}
