# Stav projektu (memory snapshot)

> Živý přehled stavu vývoje. Slouží jako „paměť“ projektu, aby kontext
> nezávisel na historii konkrétní session. Detailní zadání a architektura je
> v [`docs/plan.md`](./plan.md) (verzovaná kopie pracovního plánu Junie z
> `~/.junie/plans/stavebni-denik-nextjs.md`).

**Poslední aktualizace:** 2026-06-17
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
| 5 | Denní záznamy, fotky, počasí, checklist materiálu | ✅ Hotovo |
| 6 | Podpisy, lock, PDF export a produkční hardening | ✅ Hotovo |

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

### Krok 5 — co je hotovo

- Datová vrstva: modely `DailyReport`, `Photo`, `Remark`, `MaterialNeed`,
  `Addendum` v `prisma/schema.prisma` (unique `(projectId, date)`, soft delete,
  signature/lock sloupce už zavedené pro Krok 6) + migrace
  `prisma/migrations/20260616154300_daily_reports`.
- Snapshot počasí: `src/server/weather.ts` — Open-Meteo daily klient s 5 s
  timeoutem, čistá `parseOpenMeteoDaily` a `unavailableWeather` fallback;
  zachycený snapshot se po vytvoření už nepřepisuje (důkazní obsah dne).
- Service `src/server/services/reports.ts` — `createReport`, `updateReport`,
  `setManualWeather`, `addRemark`, `addMaterialNeed`, `setMaterialResolved`,
  `listReportsForProject`, `getReportForUser`, `canCreateReport`. Všechny
  mutace přes `withAudit` a scope přes `canAccessProject`.
- Service `src/server/services/photos.ts` + `src/server/images.ts` (sharp
  pipeline: rotate → resize 1920 px main + 400 px thumb → JPEG, EXIF stripped)
  + `src/server/photo-storage.ts` (DATA_DIR layout `photos/{projectId}/{reportId}/{uuid}.jpg`,
  path-traversal guard, rollback při selhání transakce).
- EXIF metadata: `src/server/exif.ts` (`parseExifSafely` přes `exifr`),
  `Photo.capturedAt` a `Photo.gps` se plní z originálních bajtů PŘED stripem.
  Selhání parseru se mlčky převádí na nully — screenshoty bez EXIFu se
  pohodlně nahrají.
- API: `POST /api/photos/upload` (multipart, per-soubor chyby, scope), `GET
  /api/photos/[id]?variant=thumb` (auth-gated stream přes `Readable.toWeb`).
- UI: `ReportForm`, `ReportPanels` (Remark / Material / ManualWeather),
  `PhotoUploader` (multi-file fetch + `router.refresh()`),
  `DeletePhotoButton` (BOSS, server action), `NewReportDayPicker` na
  detailu zakázky; stránky `projects/[id]/reports/[date]` (view + create) a
  `[date]/edit` (BOSS / autor). Tab „Záznamy“ v detailu zakázky s
  chronologickým výpisem, galerie ukazuje `capturedAt` v tooltipu.
- RBAC matrix rozšířen o `report.*`, `remark.create`, `material.*`,
  `photo.upload`, `photo.delete`. Lock check (`reportLocked`) ve všech
  mutacích kromě `remark.create` (oficiální TDS návštěvy po podpisu).
- Testy:
  - Unit: `weather.test.ts` (12), `images.test.ts` (6),
    `photo-storage.test.ts` (5), `exif.test.ts` (6) — celkem **71/71**.
  - Integration: `reports.int.test.ts` (6 — scope, lock, audit chain) +
    `photos.int.test.ts` (8 — kompletní HTTP cesta `POST
    /api/photos/upload` s mock auth, real sharp + FS + DB; EXIF kolony
    z bajtu skutečně dosednou). Celkem **20/20**.

### Krok 5 — co zbývá

- Nic — krok je dokončen.

### Krok 6 — co je hotovo

- Datová vrstva: migrace `20260617121140_add_report_signer_relation`
  (FK `daily_reports.signedById → users.id`, ON DELETE SET NULL) +
  Prisma relace `signedBy` v obou modelech.
- Service `signReport` v `src/server/services/reports.ts` — BOSS-only,
  setuje `signedAt`/`signedById`/`lockedAt` v jedné transakci s
  `withAudit('report.sign')`, idempotentní (re-sign hodí
  `ReportAlreadySignedError`).
- Service `addAddendum` — vyžaduje uzamčený záznam (`ReportNotLockedError`
  jinak), audit jako `report.addendum.create`, povolen pro BOSS/WORKER
  členy (GUEST má dál jen `remark.create`).
- Service `addRemark` rozšířen o `isOfficial?: boolean`; flag projde jen
  pro role `GUEST` (TDS/BOZP/projektant) a `BOSS`, jinak je tiše ignorován.
- UI: `SignReportButton` (BOSS, confirm dialog), `AddendumForm`
  (textarea + submit), oddíl „Dodatky“ na detailu dne. `RemarkForm`
  ukazuje checkbox „Označit jako oficiální“ pouze pokud uživatel může.
  V hlavičce dne se po podpisu zobrazuje kdo a kdy podepsal.
- `getReportForUser` doplňuje `signedByName`, `addenda`, `canSign`,
  `canAddAddendum`, `canMarkRemarkOfficial`.
- **PDF export**: `src/server/pdf.ts` (Playwright + headless Chromium),
  print route `/print/project/[id]?from=&to=`, API
  `GET /api/projects/[id]/pdf?from=&to=`, tlačítko „Stáhnout PDF“
  + „Náhled k tisku“ na tabu Záznamy. Patička každé strany obsahuje
  zkrácený hash poslední audit-log řádky (`getLatestAuditHash`).
- **Backup**: `scripts/backup.sh` (pg_dump + gzip + restic backup
  /data/photos), Dockerfile přidává `postgresql-client` + `restic` +
  Chromium binary download do `/opt/playwright`. README dostalo nový
  oddíl „Backup & restore“ s runbookem.
- **Monitoring**: `instrumentation.ts` v rootu repa volá
  `Sentry.init()` z `@sentry/nextjs` (gated `SENTRY_DSN`), `onRequestError`
  zachycuje chyby route handlerů / server actions. `sendDefaultPii: false`
  → žádná hesla / fotky v Sentry. README sekce „Monitoring (Sentry)“.
- Testy:
  - Unit: 71/71 (žádné nové unit pro Krok 6 — service primárně
    integration-tested s reálnou DB).
  - Integration: `reports.int.test.ts` (8 — sign workflow + addendum +
    official remark), `pdf.int.test.ts` (2 — Playwright smoke, renderPdf
    skutečně vrátí PDF). Celkem **24/24**.
  - E2E: `e2e/smoke.spec.ts` (3 — middleware redirect, špatné údaje,
    /healthz) přes `@playwright/test`. Spouští se `pnpm test:e2e`
    (Playwright si auto-spustí `pnpm dev` přes `webServer` config).
- CI: integration job nově instaluje Chromium přes
  `pnpm exec playwright install --with-deps chromium`.

### Krok 6 — co zbývá

- **Plný E2E flow** (login → projekt → report → fotka → podpis → PDF):
  smoke layer je hotový (`pnpm test:e2e`, 3 testy), ale „dlouhý" flow
  s reálným přihlášením potřebuje seedovaného uživatele a tedy buď
  staging deploy nebo CI workflow s vlastním Postgres + seed krokem.
  Aktuálně smoke spec ověřuje: middleware redirect na `/login`,
  validační chybu při špatných údajích, `GET /healthz` → 200.
- Orchestrátorové alerty (Fly CPU/RAM/disk) — konfigurace na
  straně provideru, ne v repu.

## Mapa implementace (klíčové soubory)

| Oblast | Soubory |
| ------ | ------- |
| Infra / config | `Dockerfile`, `fly.toml`, `docker-compose.yml`, `next.config.ts`, `prisma.config.ts`, `.env.example`, `.github/workflows/ci.yml` |
| DB schema + migrace | `prisma/schema.prisma`, `prisma/migrations/*` |
| Auth | `src/server/auth.ts`, `src/server/auth.config.ts`, `src/proxy.ts`, `src/app/(auth)/login/*`, `src/app/(auth)/first-password-change/*`, `src/app/api/auth/[...nextauth]/route.ts` |
| Bezpečnost | `src/server/rate-limit.ts`, `src/lib/crypto.ts`, `src/lib/password-gen.ts` |
| RBAC + audit | `src/server/rbac.ts`, `src/server/permissions.ts`, `src/server/audit.ts`, `src/server/audit-context.ts`, `src/server/audit-hash.ts`, `src/server/audit-verify.ts`, `src/server/audit-alert.ts`, `src/server/mailer.ts`, `src/server/services/audit.ts`, `scripts/verify-audit.ts`, `scripts/sql/bootstrap-app-role.sql`, `.github/workflows/audit-verify.yml` |
| Testy | `vitest.config.ts`, `vitest.integration.config.ts`, `test/unit/*`, `test/integration/*`, `test/stubs/*`, co-located `src/**/*.test.ts` |
| Správa uživatelů | `src/server/services/users.ts`, `src/app/(app)/admin/users/*` |
| Zakázky | `src/server/services/projects.ts`, `src/app/(app)/projects/*`, `prisma/migrations/20260616141700_projects` |
| Denní záznamy | `src/server/services/reports.ts`, `src/server/weather.ts`, `src/app/(app)/projects/[id]/reports/*`, `prisma/migrations/20260616154300_daily_reports` |
| Fotografie | `src/server/services/photos.ts`, `src/server/images.ts`, `src/server/photo-storage.ts`, `src/app/api/photos/upload/route.ts`, `src/app/api/photos/[id]/route.ts`, `src/app/(app)/projects/[id]/reports/{PhotoUploader,DeletePhotoButton}.tsx` |
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

**Krok 1–6 jsou hotové.** Aplikace je funkčně kompletní per
specifikaci. Aktuální zadání je v [`docs/plan.md`](./plan.md).

Testy: `pnpm test` (unit, 71/71), `pnpm test:integration` (vyžaduje
běžící Docker, 24/24), `pnpm test:e2e` (vyžaduje `pnpm exec playwright
install chromium` + běžící Postgres na 5432, 3/3 smoke).

## Backlog (post-MVP polish)

Co dál po Kroku 6, mimo původní MVP scope:

### Visualizace
- [x] **Multi-project Gantt** na BOSS dashboardu (commit `3a7e19c`).
- [x] **Day-coverage heatmap na detailu zakázky** (commit `808b73e`).
- [x] **Materiálový Gantt** seskupený po zakázkách na dashboardu
  (commit pending).

### Mobile / UX
- [x] **Mobile UX audit** — `capture="environment"` na photo input
  (přímý fotoaparát na telefonu), delete tlačítko v galerii viditelné
  i bez hoveru (touch zařízení), `pointer: coarse` media query
  v `globals.css` zvedá min-height tlačítek/inputů na 44 px (iOS HIG)
  — commit `pending`.
- [x] **Calendar view** v Záznamy tabu — měsíční mřížka (po–ne),
  prev/next navigace přes `?month=YYYY-MM`, kliknutelné dny s barevným
  pozadím podle stavu, dnes ringem (commit `b6db23e`).

### Admin / forensic
- [x] **Audit log filter** — `/admin/audit` má teď datum od/do,
  actor select s nickname + displayName (místo holého UUID), entity
  type select, freetext entity ID, paginace forward přes `?cursor=…`
  s tlačítkem „Načíst starších 100" (commit `99547e6`).
- [x] **In-app notifikace** — nová Prisma model `Notification`
  + migrace `20260619141212_notifications`, service `notifyUser` /
  `notifyByRole` / `listNotificationsForUser` / `markNotificationRead`
  / `markAllNotificationsRead` / `deleteNotification`,
  bell ikona v `AppHeader` s nepřečteným badge a dropdown panelem,
  `/notifications` stránka s `?filter=unread` toggle, `verify-audit`
  cron při poškození chainu fan-outuje `audit.chain_broken` notifikaci
  všem aktivním BOSS uživatelům (SMTP zůstává volitelný fallback,
  Fly.io ho neumí samo o sobě). 6 nových integration testů
  (recipient scoping, FK violations, mark read / delete idempotence)
  — celkem 31 integration. Commit pending.

### Domain polish
- [x] **Materiál „přesunout do dalšího dne"** — server `rolloverMaterial`
  atomicky v jedné `withAudit` transakci vyřídí zdroj a vytvoří kopii
  na cílovém dni; nová audit akce `material.rollover`. UI v
  `MaterialsPanel`: tlačítko „Přesunout" + select pozdějších
  nezamčených dnů (commit pending).

### Maintenance
- [x] **Větší major bumps**: typescript 5 → 6, @types/node 20 → 25,
  testcontainers + @testcontainers/postgresql 11 → 12 (commit `521e22a`).
  ESLint 9 → 10 zatím **blocked** — `eslint-plugin-react`
  (transitivní z `eslint-config-next`) ještě nepodporuje nové
  rule-context API; čekáme buď na patch pluginu nebo nový
  `eslint-config-next`.
- [x] **Sentry source maps** přes `withSentryConfig` — wrapper je
  no-op bez `SENTRY_AUTH_TOKEN`, takže lokál i CI bez secretu nic
  nedělá. README dostalo sekci s Fly secrets receptem.

### Deploy
- [x] **Fly deploy artefakty + runbook** — `fly.toml` doplněn o
  `[deploy] release_command` (`prisma migrate deploy` před traffic-routem)
  a komentáře k secrets / volume / VM, README dostal kompletní sekci
  „Production deployment (Fly.io)" s bootstrap + release + nightly
  maintenance + post-deploy verify + rollback runbookem (commit
  pending).
- [ ] **Provést produkční `fly deploy`** — vyžaduje Fly účet,
  kreditku, secrety (`AUTH_SECRET`, `RESTIC_*`, volitelně `SMTP_*`
  a `SENTRY_*`). Po deployi nastavit repo secret `AUDIT_DATABASE_URL`
  pro nightly audit-verify workflow.
- [ ] **Full login → PDF E2E** spec proti staging deployi (smoke
  layer v `e2e/smoke.spec.ts` je hotový jako základ).

### Hardening & resilience (nové, 2026-06-22)

Podněty od uživatele + Gemini konverzace + Buldo článek o
fotodokumentaci.

#### OOM ochrana na malé Fly VM (1 GB)
- [x] **SWAP na Fly machine** — `fly.toml` má `swap_size_mb = 512`
  (swapfile na perzistentním volume, přežije restart) + README
  sekce „OOM ochrana" (commit pending).
- [x] **PDF fronta** — in-process semaphore v `src/server/pdf.ts`
  (`acquirePdfSlot`), default `PDF_RENDER_CONCURRENCY=1`
  konfigurovatelný env proměnnou. 2 nové unit testy
  (serialisation + slot release on throw) — celkem 73 unit
  (commit pending).

#### Photo upload pipeline
- [x] **Klient-side resize** na 1920 px před uploadem (uspoří RAM
  + bandwidth; sharp zůstane jako serverová pojistka). Hotovo —
  `src/lib/photo-client.ts` (`preparePhotoForUpload`) +
  `PhotoUploader.tsx` napojen, kvalita 0.85, `console.info` summary
  „MB → KB". Commit pending.
- [x] **Server max-resolution guard** — odmítnout nadměrné rozlišení
  s jasnou hláškou ještě před spuštěním sharp pipeline. Hotovo —
  `MAX_PIXELS = 64_000_000` v `src/server/images.ts` + nový test;
  `ImageTooLargeError` se vrací z `processImage` ještě před resize
  fází. Commit pending.
- [x] **EXIF z klienta** — po klientském resize se EXIF ztratí;
  parsovat ho v prohlížeči a poslat `capturedAt` + `gps` separátními
  poli. Hotovo — klient harvestuje EXIF přes `exifr` před resize,
  posílá paralelní pole `capturedAt[]`/`gps[]`, route je rozparsuje
  a předá do `uploadPhoto` jako `clientCapturedAt`/`clientGps`;
  server EXIF parser zůstává jako fallback (legacy klienti,
  integration testy bez paralelních polí). 2 nové integration testy
  ověřují, že klient vyhrává a že prázdná pole = null. Commit
  pending.
- [x] **Disk ↔ DB reconcile** — script `pnpm reconcile:photos`
  najde osiřelé soubory (pad / OOM kill v půlce uploadu) a osiřelé
  DB řádky bez souboru. Spustitelné z `/admin` i z cronu. Hotovo —
  `src/server/services/photos-reconcile.ts` (čistý helper s grace
  window 5 min proti race s in-flight uploady), `scripts/reconcile-
  photos.ts` (CLI s `--json` + `--delete-orphans`, exit 0/1/2),
  zápis do `{DATA_DIR}/reconcile-photos.log`, dokumentace v README
  → OOM ochrana. 10 unit + 3 integration testů (orphan/missing,
  soft-delete keep, --delete-orphans surgical). Commit pending.

#### Backup
- [x] **Roundtrip integration test** — pg_dump → restic backup →
  restic restore → psql restore → ověření schématu + audit chainu
  v jednom containeru (commit pending).
- [x] **B2 jako Doporučená cesta** v README. Hotovo: nová podsekce
  „Proč Backblaze B2" s porovnávací tabulkou (egress / cena /
  setup) — B2 je defaultní cesta v dokumentaci, S3/R2 zůstávají
  jako alternativy.

#### Doménové & UX hinty
- [x] **PDF archivace** — rozhodnutí: **NEukládat** soubory na
  disk. PDF je *view* (derivát) nad source-of-truth daty v DB
  (audit_log + reports + photos). Místo toho audituj akci `pdf.
  export` s anchor hashem (totéž je v PDF footeru) — soubor je
  self-anchoring k bodu v hash chainu, reprodukce z backupu
  + re-render dá identický obsah. Hotovo: nová akce `pdf.export`
  v `audit-hash.ts`, appendAudit po úspěšném renderu v PDF route,
  3 nové integration testy.
- [ ] **„Co a kdy fotit"** checklist na photo upload kartě
  (https://www.buldo.cz/fotodokumentace-stavby-a-nejcastejsi-chyby-stavebniku/):
  základy → instalace před zakrytím → hrubá stavba/izolace →
  dokončovací → odkaz na článek, dismissible.

#### Security
- [x] **Hardening review** — CSP (už nasazené), login rate-limit (už),
  path-traversal v photo serve (už — `resolvePhotoAbsolutePath`), raw
  SQL surface (všechno tagged-template ✅). **Nově přidáno**:
  - rate-limit `POST /api/photos/upload` 60/5 min/user → 429 +
    Retry-After (`PHOTO_UPLOAD_USER_LIMIT`),
  - rate-limit `GET /api/projects/[id]/pdf` 10/5 min/user → 429 +
    Retry-After (`PDF_RENDER_USER_LIMIT`),
  - SSRF guard na Open-Meteo: allow-list `api.open-meteo.com` +
    HTTPS-only v produkci, `NODE_ENV=test` short-circuit.
  - README sekce „Bezpečnost — vrstvy obrany" se kompletním přehledem
    všech vrstev (CSP, auth, rate-limit, audit log, file upload,
    SSRF, SQL injection, disk reconcile, otevřené TODO).
  - 2 nové unit testy (weather SSRF guard) + 1 integration (upload
    rate-limit 429 s pre-filled bucketem).
  - Commit pending.
