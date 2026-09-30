/** Thin fetch wrapper for the Ktor backend (JWT lives in an HttpOnly cookie). */

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, message);
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
