# Project guidelines & memory — Stavební deník

Persistent project memory for AI agents working in this repo. Load this first,
then read the linked docs before changing code.

## What this project is

Electronic **construction diary** (Czech "stavební deník") compliant with
§ 157 of the Building Act (Act 283/2021 Sb.) and Annex 16 of Decree 499/2006 Sb.
Single-tenant, deployed to Fly.io / Railway, photos on a local `/data` volume,
tamper-evident audit log via a SHA-256 hash chain.

## Source of truth (read in this order)

1. `docs/PROGRESS.md` — live status snapshot: what is done, what is in progress,
   what is next, and the file map. **Update it whenever the status changes.**
2. `docs/plan.md` — full requirements, technical design, and the 6-step delivery
   plan (in-repo copy of the Junie working plan).
3. `README.md` — local dev, scripts, and deployment.
4. `AGENTS.md` — Next.js 16 / Prisma 7 have breaking changes vs. older training
   data; consult the bundled docs before writing framework code.

## Current state (keep in sync with docs/PROGRESS.md)

- Step 1 (bootstrap/infra) and Step 2 (auth + user management) are **done**.
- Step 3 (RBAC + hash-chain audit log) is **in progress** — core
  `withAudit`/`assertCan`/audit UI/verify script exist; the scheduled verify
  cron and integration tests are still missing. No test runner is configured yet.

## Non-negotiable invariants

- **No hard deletes.** Every entity uses `deletedAt` (soft delete); never add a
  destructive delete path or UI.
- **Every domain mutation goes through `withAudit(...)`** (`src/server/audit.ts`).
  Never write to domain entities outside the audit wrapper.
- **`audit_log` is append-only**, enforced by DB triggers *and* a privilege
  `REVOKE` on the `app` role. Do not add UPDATE/DELETE to it.
- **Authorization only via `assertCan(...)`** (`src/server/rbac.ts`) in the
  service layer; middleware is a second line of defence, not the only one.
- Roles: `BOSS` (admin/site manager), `WORKER`, `GUEST` (TDS/supervisor, read +
  remarks only).

## Workflow

- Work is plan-driven; advance the delivery steps in `docs/plan.md` strictly in
  order, finishing one before starting the next.
- Keep `docs/PROGRESS.md` accurate after each meaningful change.
- Czech for UI strings and user-facing docs; Europe/Prague timezone; date format
  `dd.MM.yyyy`.

## Common commands

```bash
pnpm install
docker compose up -d postgres
pnpm db:migrate          # prisma migrate dev
pnpm dev                 # http://localhost:3000 (health: /healthz)
pnpm lint && pnpm typecheck
pnpm verify:audit        # walk the audit hash chain
```
