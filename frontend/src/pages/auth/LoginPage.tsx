import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { User } from "lucide-react";
import { browserStorage, clearDraftsExceptUser } from "../../lib/draftStore";
import { Banner, Button, Field, TextInput } from "../../components/ui";

export function LoginPage() {
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    localStorage.removeItem("user");
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname, password }),
      });

      if (response.status === 429) {
        // Too many failed attempts: the server says how long to wait.
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Příliš mnoho pokusů. Zkuste to později.");
      }
      if (!response.ok) {
        // A temporary password that was not used in time: only a correct password gets this answer.
        const body = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
        if (response.status === 401 && body?.code === "PASSWORD_EXPIRED" && body.error) throw new Error(body.error);
        throw new Error("Neplatné přihlašovací jméno nebo heslo");
      }

      const data = await response.json();
      if (data && data.user) {
        localStorage.setItem("user", JSON.stringify(data.user));
        // Drafts of an earlier person on this device are not for the one who signed in now (the same person keeps theirs).
        if (typeof data.user.id === "string") clearDraftsExceptUser(browserStorage(), data.user.id);
      }

      // A temporary password (new account, administrator reset) has to be replaced first.
      navigate(data?.user?.mustChangePwd ? "/change-password" : "/projects");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Chyba přihlášení");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
      <div className="w-full max-w-md space-y-8">
        <div>
          <h2 className="mt-6 text-center text-3xl font-bold tracking-tight text-ink">Stavební deník</h2>
          <p className="mt-2 text-center text-sm text-ink-muted">Přihlaste se ke svému účtu</p>
        </div>
        {/* The labels are for screen readers here (the placeholders say the same to the eye); visible labels are backlog B7. */}
        <form className="mt-8 space-y-4" onSubmit={handleLogin}>
          <Field label="Přihlašovací jméno" labelHidden>
            <TextInput name="nickname" type="text" required placeholder="Přihlašovací jméno" value={nickname} onChange={(e) => setNickname(e.target.value)} />
          </Field>
          <Field label="Heslo" labelHidden>
            <TextInput name="password" type="password" required placeholder="Heslo" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>

          {error && <Banner tone="danger">{error}</Banner>}

          <Button type="submit" block>
            <User className="h-5 w-5" aria-hidden="true" />
            Přihlásit se
          </Button>
        </form>
      </div>
    </div>
  );
}
