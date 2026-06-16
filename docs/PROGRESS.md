# Stav projektu (memory snapshot)

> Živý přehled stavu vývoje. Slouží jako „paměť“ projektu, aby kontext
> nezávisel na historii konkrétní session. Detailní zadání a architektura je
> v [`docs/plan.md`](./plan.md) (verzovaná kopie pracovního plánu Junie z
> `~/.junie/plans/stavebni-denik-nextjs.md`).

**Poslední aktualizace:** 2026-06-16
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
| 3 | RBAC a tamper-evident audit log (hash chain) | ✅ Hotovo |
| 4 | Zakázky a identifikační údaje stavby | ✅ Hotovo |
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
- Hash-chain jádro `src/server/audit-hash.ts` (kanonický JSON, SHA-256,
  `verifyAuditRows`) + DB-vázaný walker `src/server/audit-verify.ts`.
- Admin UI `src/app/(app)/admin/audit/` (`page.tsx`, `actions.ts`,
  `AuditRowDetails.tsx`, `VerifyChainButton.tsx`) — prohlížeč logu s filtry,
  detail řádku a tlačítko „Ověřit integritu řetězu“.
- CLI `scripts/verify-audit.ts` (`pnpm verify:audit`) + e-mail alert
  (`src/server/mailer.ts`, `src/server/audit-alert.ts`).
- **Denní cron** `.github/workflows/audit-verify.yml` — spouští `verify:audit`,
  při poškození řetězu padá (notifikace v GitHubu) a posílá e-mail BOSSovi
  (SMTP_* / ALERT_EMAIL secrets).
- **Testy**: Vitest harness (`vitest.config.ts` + `vitest.integration.config.ts`,
  `server-only` stub), unit testy (`audit-hash`, `permissions`, `audit-alert`,
  `mailer`, `password-gen`) a integrační test
  `test/integration/audit-chain.int.test.ts` (Testcontainers Postgres: ověří
  append-only triggery i detekci manipulace přes raw SQL s ID porušeného řádku).
- CI (`.github/workflows/ci.yml`) nově pouští `pnpm test` a samostatný job
  s integračními testy (`pnpm test:integration`).

### Krok 3 — co zbývá

- Nic — krok je dokončen. Nasazovací poznámka: nastavit repo secret
  `AUDIT_DATABASE_URL` (a volitelně SMTP_* / `ALERT_EMAIL`) pro denní cron.

### Krok 4 — co je hotovo

- Datová vrstva: modely `Project` + `ProjectMember` v `prisma/schema.prisma`
  (identifikační údaje stavby dle § 157 / přílohy č. 16 vyhl. 499/2006, GPS pro
  pozdější snapshot počasí, soft delete přes `deletedAt`) a migrace
  `prisma/migrations/20260616141700_projects`.
- Service `src/server/services/projects.ts` — zod validace + `normalizeProjectForm`,
  všechny mutace (`createProject`, `updateProject`, `archiveProject`,
  `restoreProject`, `addProjectMember`, `removeProjectMember`) přes `withAudit`
  (audit akce `project.*`). Stavbyvedoucí musí být aktivní uživatel role BOSS.
- **Přístupový scope**: pure helper `canAccessProject(role, isMember)` v
  `permissions.ts` (BOSS vidí vše, WORKER/GUEST jen zakázky, kde jsou členy);
  promítnuto do `listProjectsForUser` i `getProjectForUser` (nečlen dostane
  `null` — žádný únik existence).
- UI `src/app/(app)/projects/` — seznam (scope + archiv pro BOSS), `new/`
  (formulář, BOSS-only), `[id]/` (záložky Údaje stavby / Členové vč.
  přidání/odebrání člena a archivace/obnovy) a `[id]/edit/`. Sdílený
  `ProjectForm` + klientské `MembersPanel` / `ProjectStatusButton`.
- **Testy**: unit pro `canAccessProject` (`permissions.test.ts`) + integrační
  `test/integration/projects.int.test.ts` (Testcontainers: založení, scope
  člen vs. nečlen, archivace/obnova a integrita audit řetězu).

### Krok 4 — co zbývá

- Nic — krok je dokončen. Denní záznamy (vazba `report → project`) a snímek
  počasí z uložených GPS souřadnic přijdou v Kroku 5.

## Mapa implementace (klíčové soubory)

| Oblast | Soubory |
| ------ | ------- |
| Infra / config | `Dockerfile`, `fly.toml`, `docker-compose.yml`, `next.config.ts`, `prisma.config.ts`, `.env.example`, `.github/workflows/ci.yml` |
| DB schema + migrace | `prisma/schema.prisma`, `prisma/migrations/*` |
| Auth | `src/server/auth.ts`, `src/server/auth.config.ts`, `src/middleware.ts`, `src/app/(auth)/login/*`, `src/app/(auth)/first-password-change/*`, `src/app/api/auth/[...nextauth]/route.ts` |
| Bezpečnost | `src/server/rate-limit.ts`, `src/lib/crypto.ts`, `src/lib/password-gen.ts` |
| RBAC + audit | `src/server/rbac.ts`, `src/server/permissions.ts`, `src/server/audit.ts`, `src/server/audit-context.ts`, `src/server/audit-hash.ts`, `src/server/audit-verify.ts`, `src/server/audit-alert.ts`, `src/server/mailer.ts`, `src/server/services/audit.ts`, `scripts/verify-audit.ts`, `scripts/sql/bootstrap-app-role.sql`, `.github/workflows/audit-verify.yml` |
| Testy | `vitest.config.ts`, `vitest.integration.config.ts`, `test/unit/*`, `test/integration/*`, `test/stubs/*`, co-located `src/**/*.test.ts` |
| Správa uživatelů | `src/server/services/users.ts`, `src/app/(app)/admin/users/*` |
| Zakázky | `src/server/services/projects.ts`, `src/app/(app)/projects/*`, `prisma/migrations/20260616141700_projects` |
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

**Kroky 1–4 jsou hotové.** Pokračuje se **Krokem 5** (denní záznamy, fotky,
počasí, checklist materiálu). Aktuální zadání kroku je v
[`docs/plan.md`](./plan.md).

Testy: `pnpm test` (unit) a `pnpm test:integration` (vyžaduje běžící Docker).
