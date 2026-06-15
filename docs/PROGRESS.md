# Stav projektu (memory snapshot)

> Živý přehled stavu vývoje. Slouží jako „paměť“ projektu, aby kontext
> nezávisel na historii konkrétní session. Detailní zadání a architektura je
> v [`docs/plan.md`](./plan.md) (verzovaná kopie pracovního plánu Junie z
> `~/.junie/plans/stavebni-denik-nextjs.md`).

**Poslední aktualizace:** 2026-06-15
**Repozitář:** `/Users/saymoon/Work-GIT/slack/stavebni-denik` (větev `main`)

## Tech stack (zkráceně)

Next.js 16 (App Router, React 19, RSC + server actions), Postgres 16 + Prisma 7
(`@prisma/adapter-pg`), Auth.js v5 Credentials + `@node-rs/argon2` (argon2id),
Tailwind 4 + shadcn/ui. Detail v `README.md`.

## Stav dodávky (Delivery Steps)

| Krok | Téma | Stav |
| ---- | ---- | ---- |
| 1 | Bootstrap, infra a deploy-skeleton | ✅ Hotovo |
| 2 | Autentizace a správa uživatelů s generovaným heslem | ✅ Hotovo |
| 3 | RBAC a tamper-evident audit log (hash chain) | 🚧 Rozpracováno |
| 4 | Zakázky a identifikační údaje stavby | ⬜ Čeká |
| 5 | Denní záznamy, fotky, počasí, checklist materiálu | ⬜ Čeká |
| 6 | Podpisy, lock, PDF export a produkční hardening | ⬜ Čeká |

### Krok 3 — co je hotovo

- `src/server/audit.ts` — `withAudit()` (mutace v transakci), `appendAudit()`
  (event-only akce typu sign-in/out) a `verifyAuditChain()` (ověření celého
  řetězu hashů).
- `src/server/rbac.ts` — `assertCan(user, action, resource)` s centrální,
  wildcard-resistentní maticí oprávnění pro BOSS/WORKER/GUEST + `requireUser()`.
- `src/server/services/users.ts` — všechny mutace (create / toggle-active /
  change-password) jsou zpětně zabaleny do `withAudit` (retrofit Stage 2).
- Migrace `prisma/migrations/20260530190054_audit_log` — tabulka `audit_log`,
  BEFORE UPDATE/DELETE triggery (append-only) a `REVOKE UPDATE, DELETE` pro roli
  `app` (viz `scripts/sql/bootstrap-app-role.sql`).
- Admin UI `src/app/(app)/admin/audit/` (`page.tsx` + `actions.ts`) — prohlížeč
  logu s filtry + tlačítko „Ověřit integritu řetězu“.
- CLI `scripts/verify-audit.ts` (`pnpm verify:audit`).

### Krok 3 — co zbývá

- [ ] Cron job (Fly machine schedule nebo GitHub Actions) — denní spuštění
      `verify:audit` + notifikace BOSSovi při selhání.
- [ ] Integrační testy: manipulace s řádkem přes raw SQL → `verifyAuditChain`
      detekuje break a vrátí ID porušeného řádku.
- [ ] Testovací harness obecně (Vitest + testcontainers Postgres) — zatím
      v repu **není** žádný test ani konfigurace test runneru.

## Mapa implementace (klíčové soubory)

| Oblast | Soubory |
| ------ | ------- |
| Infra / config | `Dockerfile`, `fly.toml`, `docker-compose.yml`, `next.config.ts`, `prisma.config.ts`, `.env.example`, `.github/workflows/ci.yml` |
| DB schema + migrace | `prisma/schema.prisma`, `prisma/migrations/*` |
| Auth | `src/server/auth.ts`, `src/server/auth.config.ts`, `src/middleware.ts`, `src/app/(auth)/login/*`, `src/app/(auth)/first-password-change/*`, `src/app/api/auth/[...nextauth]/route.ts` |
| Bezpečnost | `src/server/rate-limit.ts`, `src/lib/crypto.ts`, `src/lib/password-gen.ts` |
| RBAC + audit | `src/server/rbac.ts`, `src/server/audit.ts`, `src/server/audit-context.ts`, `src/server/services/audit.ts`, `scripts/verify-audit.ts`, `scripts/sql/bootstrap-app-role.sql` |
| Správa uživatelů | `src/server/services/users.ts`, `src/app/(app)/admin/users/*` |
| UI baseline | `src/app/layout.tsx`, `src/app/globals.css`, `src/components/ui/*`, `src/components/app-header.tsx` |
| Health / lib | `src/app/healthz/route.ts`, `src/lib/{db,env,dates,utils}.ts` |

## Klíčové konvence (nepřekračovat)

- **Žádné tvrdé mazání** — vše přes `deletedAt` (soft delete). UI nemá „smazat
  trvale“.
- **Každá doménová mutace** prochází `withAudit(...)`; nikdy nezapisovat do
  entit mimo audit wrapper.
- **`audit_log` je append-only** — chráněno DB triggery i `REVOKE`. Nikdy
  nepřidávat UPDATE/DELETE cestu.
- **Oprávnění jen přes `assertCan`** v service layeru; middleware je druhá
  obrana, ne jediná.
- Next.js 16 / Prisma 7 mají breaking changes — viz `AGENTS.md`, čti aktuální
  docs v `node_modules/...` před psaním kódu.

## Jak navázat v další session

```bash
cd /Users/saymoon/Work-GIT/slack/stavebni-denik
pnpm install
docker compose up -d postgres
cp .env.example .env   # pokud .env ještě není
pnpm db:migrate
pnpm dev               # http://localhost:3000  (health: /healthz)
pnpm verify:audit      # ověření hash chainu audit logu
```

Pokračuje se dokončením **Kroku 3** (cron + integrační testy), pak **Krok 4**
(zakázky). Aktuální zadání kroku je v [`docs/plan.md`](./plan.md).
