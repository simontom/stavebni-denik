/**
 * Safety check for the E2E seed (`e2e-prepare.ts`).
 *
 * The seed resets well-known accounts (including admins) to a known password
 * and hard-deletes users, so it must only ever run against a database on this
 * machine: a local container or the CI service container. Never a shared,
 * staging or production database.
 *
 * Kept in its own module because `e2e-prepare.ts` runs on import.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Throws unless the connection URL points at the local machine.
 *
 * The host is read with the WHATWG URL parser, so tricks such as
 * `postgresql://localhost@db.example.com/x` (host is `db.example.com`) or
 * `localhost.example.com` are refused. The error message never contains the
 * user name or password from the URL.
 */
export function assertLocalDatabase(connectionString: string): void {
  let host: string;
  try {
    host = new URL(connectionString).hostname.toLowerCase();
  } catch {
    throw new Error("E2E seed: DATABASE_URL is not a valid connection URL");
  }

  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`E2E seed refuses to run against the non-local database host "${host}". ` + "It resets known accounts and deletes users; point DATABASE_URL at localhost.");
  }
}
