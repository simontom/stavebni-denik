import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { User } from "lucide-react";

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
      }

      // A temporary password (new account, administrator reset) has to be replaced first.
      navigate(data?.user?.mustChangePwd ? "/change-password" : "/projects");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Chyba přihlášení");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12 sm:px-6 lg:px-8">
      <div className="w-full max-w-md space-y-8">
        <div>
          <h2 className="mt-6 text-center text-3xl font-bold tracking-tight text-gray-900">Stavební deník</h2>
          <p className="mt-2 text-center text-sm text-gray-600">Přihlaste se ke svému účtu</p>
        </div>
        <form className="mt-8 space-y-6" onSubmit={handleLogin}>
          <div className="-space-y-px rounded-md shadow-sm">
            <div>
              <label htmlFor="nickname" className="sr-only">
                Přihlašovací jméno
              </label>
              <input
                id="nickname"
                name="nickname"
                type="text"
                required
                className="relative block w-full rounded-t-md border-0 px-3 py-1.5 text-gray-900 ring-1 ring-gray-300 ring-inset placeholder:text-gray-400 focus:z-10 focus:ring-2 focus:ring-indigo-600 focus:ring-inset sm:text-sm sm:leading-6"
                placeholder="Přihlašovací jméno"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="password" className="sr-only">
                Heslo
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                className="relative block w-full rounded-b-md border-0 px-3 py-1.5 text-gray-900 ring-1 ring-gray-300 ring-inset placeholder:text-gray-400 focus:z-10 focus:ring-2 focus:ring-indigo-600 focus:ring-inset sm:text-sm sm:leading-6"
                placeholder="Heslo"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>

          {error && <div className="text-center text-sm text-red-500">{error}</div>}

          <div>
            <button
              type="submit"
              className="group relative flex w-full justify-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
            >
              <span className="absolute inset-y-0 left-0 flex items-center pl-3">
                <User className="h-5 w-5 text-indigo-500 group-hover:text-indigo-400" aria-hidden="true" />
              </span>
              Přihlásit se
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
