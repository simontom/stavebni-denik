/** Thin fetch wrapper for the Ktor backend (JWT lives in an HttpOnly cookie). */

export class ApiError extends Error {
  readonly status: number;
  /** Machine-readable reason sent by the server (for example PASSWORD_CHANGE_REQUIRED), if any. */
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(path, { ...init, headers });

  if (res.status === 401) {
    localStorage.removeItem("user");
    window.location.assign("/login");
    throw new ApiError(401, "Přihlášení vypršelo");
  }

  if (!res.ok) {
    let message = `Chyba ${res.status}`;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      if (body?.error) message = body.error;
      code = body?.code;
    } catch {
      // non-JSON error body
    }
    if (res.status === 403 && code === "PASSWORD_CHANGE_REQUIRED") {
      // A temporary password has to be replaced before anything else works.
      const user = currentUser();
      if (user) localStorage.setItem("user", JSON.stringify({ ...user, mustChangePwd: true }));
      if (window.location.pathname !== "/change-password") window.location.assign("/change-password");
    }
    throw new ApiError(res.status, message, code);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const json = (data: unknown): string => JSON.stringify(data);

export interface SessionUser {
  id: string;
  nickname: string;
  displayName: string;
  role: "BOSS" | "WORKER" | "INSPECTOR" | "INVESTOR";
  isAdmin: boolean;
  /** True while the password was set by an administrator and has to be changed. */
  mustChangePwd?: boolean;
}

export function currentUser(): SessionUser | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem("user");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export const ROLE_LABELS: Record<string, string> = {
  BOSS: "Stavbyvedoucí",
  WORKER: "Pracovník",
  INSPECTOR: "Technický dozor",
  INVESTOR: "Investor",
};

export interface UserOption {
  id: string;
  nickname: string;
  displayName: string;
  role: string;
}
