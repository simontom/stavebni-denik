# Stavební deník

Elektronický stavební deník dle § 157 stavebního zákona (zák. č. 283/2021 Sb.)
a přílohy č. 16 vyhlášky 499/2006 Sb. Aplikace je **single-tenant** — jedna
instance = jedna firma.

> Pro architekturu a rozhodnutí viz [`docs/plan.md`](docs/plan.md);
> aktuální stav vývoje je v [`docs/PROGRESS.md`](docs/PROGRESS.md).

## Tech stack

| Vrstva           | Technologie                                                    |
| ---------------- | -------------------------------------------------------------- |
| Framework        | Next.js 16 (App Router, React 19, RSC + server actions)        |
| DB & ORM         | Postgres 16 + Prisma 7 (driver-adapter model, `@prisma/adapter-pg`) |
| Auth             | Auth.js v5 Credentials + argon2id (Stage 2)                    |
| RBAC             | Service-layer `assertCan(...)` (Stage 3)                       |
| Audit log        | Append-only `audit_log` s hash chain (Stage 3)                 |
| Storage fotek    | Lokální Fly volume `/data`, sharp resize (Stage 5)             |
| Počasí           | Open-Meteo (zdarma, bez API klíče) (Stage 5)                   |
| PDF              | Playwright headless Chromium (Stage 6)                         |
| UI               | Tailwind 4 + shadcn/ui (Radix) + sonner                        |
| Hosting          | Fly.io, Frankfurt region                                       |

## Local development

Předpoklady: Node 22+, pnpm 10+, Docker.

```bash
# 1. Závislosti
pnpm install

# 2. Lokální Postgres (běží v Dockeru na portu 5432)
docker compose up -d postgres

# 3. Env soubor — zkopíruj a uprav, pokud potřeba.
cp .env.example .env  # .env je v .gitignore

# 4. Migrace + Prisma client
pnpm db:migrate

# 5. Spuštění dev serveru
pnpm dev
```

App pojede na <http://localhost:3000>. Health check je na
<http://localhost:3000/healthz>.

## Scripts

| Script                     | Co dělá                                                  |
| -------------------------- | -------------------------------------------------------- |
| `pnpm dev`                 | Next.js dev server.                                      |
| `pnpm build`               | Produkční build (`output: standalone`).                  |
| `pnpm start`               | Spustí produkční build.                                  |
| `pnpm lint`                | ESLint.                                                  |
| `pnpm typecheck`           | `tsc --noEmit`.                                          |
| `pnpm format`              | Prettier (TS, CSS, Prisma).                              |
| `pnpm db:generate`         | Vygeneruje Prisma klienta.                               |
| `pnpm db:migrate`          | `prisma migrate dev` — vývojová migrace + apply.         |
| `pnpm db:migrate:deploy`   | Aplikuje migrace v produkci (běží v `Dockerfile` při startu). |
| `pnpm db:studio`           | Prisma Studio (DB GUI).                                  |
| `pnpm db:reset`            | Smaže DB a znovu aplikuje všechny migrace (jen dev).     |

## Production deployment (Fly.io)

### Jednorázový bootstrap

Předpoklady: `flyctl` (`brew install flyctl`), Fly účet, platná kreditní
karta v billing. Adresa app a region jsou v `fly.toml` (`stavebni-denik`,
`fra`); pokud potřebuješ jiné, edituj `fly.toml` ještě před `fly apps
create`.

```bash
# 0. Přihlášení
fly auth login

# 1. App + persistentní volume + Postgres add-on
fly apps create stavebni-denik
fly volumes create stavebni_denik_data --size 10 --region fra
fly postgres create --name stavebni-denik-db --region fra
fly postgres attach stavebni-denik-db    # injectne DATABASE_URL secret

# 2. Required secrets
fly secrets set \
  AUTH_SECRET="$(openssl rand -base64 32)" \
  AUTH_URL="https://stavebni-denik.fly.dev"

# 3. Optional secrets (každý je no-op když chybí)
# 3a. SMTP alerty pro audit verify failure (volitelné — v-app bell
#     pokrývá tenhle use case automaticky pro každého BOSSe; SMTP
#     je tu jen pro krew, který chce navíc e-mail. Fly.io samo
#     o sobě SMTP nemá; nastavit s externím providerem (Mailgun,
#     SendGrid, Resend), nebo úplně vynechat).
fly secrets set \
  SMTP_HOST="smtp.example.com" \
  SMTP_PORT="587" \
  SMTP_SECURE="false" \
  SMTP_USER="alerts@example.com" \
  SMTP_PASS="..." \
  SMTP_FROM="Stavební deník <alerts@example.com>" \
  ALERT_EMAIL="boss@example.com"

# 3b. Restic + B2 (nebo S3) pro nightly zálohy — viz "Backup & restore"
fly secrets set \
  RESTIC_REPOSITORY="b2:stavebni-denik-backup:/restic" \
  RESTIC_PASSWORD="$(openssl rand -base64 32)" \
  B2_ACCOUNT_ID="<keyID>" \
  B2_ACCOUNT_KEY="<applicationKey>"

# 3c. Sentry runtime + source maps (viz "Monitoring (Sentry)")
fly secrets set \
  SENTRY_DSN="https://...@o0.ingest.sentry.io/0" \
  SENTRY_ENVIRONMENT="production" \
  SENTRY_TRACES_SAMPLE_RATE="0.1" \
  SENTRY_ORG="my-org" \
  SENTRY_PROJECT="stavebni-denik" \
  SENTRY_AUTH_TOKEN="sntrys_..."

# 4. První deploy. `[deploy] release_command` v fly.toml spustí
#    `prisma migrate deploy` proti DB ještě před traffic-routem.
fly deploy

# 5. Nasaď BOSS účet (vygeneruje heslo, vypíše ho jednou)
fly ssh console -C "pnpm tsx scripts/seed.ts"
# Heslo si schovej — vyžaduje se při prvním přihlášení.
```

### Při každém releaseu

```bash
git push origin main && fly deploy
```

`fly deploy` strategie je `rolling`: Fly nejprve spustí ephemeral
machine s `release_command` (`prisma migrate deploy`), pak teprve
postupně vymění běžící machine. Když migrace selže (např. konflikt),
deploy se přeruší a aktuální verze běží dál.

### Nightly maintenance

Tři nezávislé úlohy, každá je samostatný GitHub Action / Fly scheduled
machine:

| Co | Kde | Frekvence | Co potřebuje |
| --- | --- | --------- | ------------ |
| Audit chain verify | `.github/workflows/audit-verify.yml` | 04:00 UTC | repo secret `AUDIT_DATABASE_URL` (read-only role) |
| `pg_dump` + photo backup | `fly machine run` schedule (níže) | 02:00 UTC | restic secrets z 3b |
| Open-Meteo / Sentry | průběžně z app | requestem | nic |

```bash
# Vytvořit scheduled machine pro nightly backup (jednou).
fly machine run . \
  --schedule daily \
  --command "/app/scripts/backup.sh" \
  --region fra
```

### Po-deploy ověření

```bash
fly status
fly logs --tail
curl -s https://stavebni-denik.fly.dev/healthz | jq .   # 200 + status: ok
fly ssh console -C "pnpm verify:audit"                  # OK / FAIL na stdout
```

### Rollback

```bash
fly releases                 # vypíše předchozí release id
fly releases rollback <id>   # nasadí předchozí image
```

Pokud migrace přidala sloupec / tabulku, rollback **neumí** schema
vrátit zpět — Prisma migrace jsou one-way. Schema kompatibilita
předchozího kódu s novou DB je odpovědnost autora změny (přidej
sloupec jako `NULLABLE` v jedné migraci, použij ho v další).

## OOM ochrana

Default Fly velikost (`shared-cpu-1x` + 1 GB RAM) je pro Sharp i
Chromium na hraně. Bez ochrany jeden velký PDF export nebo dva
souběžné uploady fotek tu mašinu zabijí.

**SWAP na volume.** `fly.toml` má `swap_size_mb = 512` — Fly při
startu vytvoří 512 MB swapfile na perzistentním volume. To zachytí
přechodné špičky paměti místo OOM killu. Cena: 512 MB navíc na
`/data` volume + lehké zpomalení při swappování.

**PDF fronta.** `renderPdf()` v `src/server/pdf.ts` jde přes
in-process semaphore. Default `PDF_RENDER_CONCURRENCY=1`, takže dva
souběžné požadavky o `/api/projects/[id]/pdf` chromium spustí
postupně. Druhý uživatel uvidí jen mírné zpoždění místo 500. Bumpni
na 2+ teprve když má mašina ≥ 2 GB RAM.

## Backup & restore

Nightly snapshot Postgres dumpu + `/data/photos` přes
[restic](https://restic.net/) do Backblaze B2 / Cloudflare R2 / S3.
Skript je v `scripts/backup.sh` a v produkčním image je zkopírovaný
do `/app/scripts/backup.sh`.

### Konfigurace (Fly secrets)

```bash
fly secrets set \
  RESTIC_REPOSITORY="b2:stavebni-denik-backup:/restic" \
  RESTIC_PASSWORD="$(openssl rand -base64 32)" \
  B2_ACCOUNT_ID="<keyID>" \
  B2_ACCOUNT_KEY="<applicationKey>"
```

(Pro S3/R2 použij `s3:https://endpoint/bucket` a `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`.) `RESTIC_PASSWORD` si **schovej** — bez něj
zálohy nedešifruješ.

### Spuštění zálohy

```bash
# Ručně z běžící Fly machine (jednorázový dry-run):
fly ssh console -C "/app/scripts/backup.sh"

# Nebo přes naplánovanou Fly machine (nightly v 02:00 UTC):
fly machine run . --schedule daily --command "/app/scripts/backup.sh"
```

První běh inicializuje restic repo a uloží `RESTIC_PASSWORD` lokálně
zakešovaný; pak už jen přidává deduplikované snapshoty.

### Retention

`scripts/backup.sh` po každém běhu spustí `restic forget --prune` s:

- 7 denních snapshotů
- 4 týdenní
- 12 měsíčních

### Restore (runbook)

```bash
# 1. Vyber snapshot, ze kterého chceš obnovit:
restic snapshots --tag stavebni-denik-nightly

# 2. Obnov dump + fotky do /restore:
restic restore <snapshot-id> --target /restore

# 3. Restartuj DB v čisté podobě a načti dump:
gunzip -c /restore/tmp/<...>/db.sql.gz | psql "$DATABASE_URL"

# 4. Vrať fotky na perzistentní volume:
rsync -a /restore/data/photos/ /data/photos/

# 5. Ověř integritu audit chainu po restoru:
pnpm verify:audit
```

Pokud `verify:audit` nahlásí porušení, je obnovený stav nedůvěryhodný
— vyber starší snapshot a opakuj.

## Monitoring (Sentry)

Server + edge errors jsou hlášené do [Sentry](https://sentry.io/) pokud
je `SENTRY_DSN` v env. Když je prázdné (lokální vývoj, CI), SDK je
úplně neaktivní — žádný síťový provoz, žádná režie.

```bash
fly secrets set \
  SENTRY_DSN="https://...@o0.ingest.sentry.io/0" \
  SENTRY_ENVIRONMENT="production" \
  SENTRY_TRACES_SAMPLE_RATE="0.1"
```

`instrumentation.ts` v rootu repa registruje `Sentry.init()` při startu
workeru a `onRequestError` zachycuje chyby z route handlerů / server
actions / RSC.

PII (cesty, request body) se **nenahrávají** (`sendDefaultPii: false`)
— hesla z `/login` ani fotky z `/api/photos/upload` se v Sentry
neobjeví.

### Source maps (volitelné)

`next.config.ts` je obalený `withSentryConfig`, který při produkčním
buildu nahraje source maps do Sentry — minified server stack traces se
v UI mapují zpět na TS řádky. Wrapper je no-op když chybí
`SENTRY_AUTH_TOKEN`, takže `pnpm dev` / CI bez secretu nic nedělá.

```bash
fly secrets set \
  SENTRY_ORG="my-org" \
  SENTRY_PROJECT="stavebni-denik" \
  SENTRY_AUTH_TOKEN="sntrys_..." \
  SENTRY_RELEASE="$(git rev-parse --short HEAD)"
```

Healthcheck `/healthz` (DB + volume probe) běží průběžně z orchestrátoru
a doporučené alerty na Fly pokrývají CPU/RAM/disk.

## Project layout

```
.
├─ prisma/
│  ├─ schema.prisma           # User + Session (Stage 1); další modely přibudou.
│  └─ migrations/             # SQL migrace generované Prisma CLI.
├─ src/
│  ├─ app/                    # Next.js App Router.
│  │  ├─ layout.tsx           # Cs lokalizace, Europe/Prague TZ, Toaster.
│  │  ├─ page.tsx             # Placeholder landing.
│  │  ├─ healthz/route.ts     # DB + volume probe.
│  │  └─ globals.css          # Tailwind 4 + shadcn tokeny.
│  ├─ generated/prisma/       # Prisma klient (negitovaný, regen na install).
│  └─ lib/
│     ├─ db.ts                # Prisma singleton + PrismaPg adapter.
│     ├─ env.ts               # Lazy env accessor s required/optional.
│     ├─ utils.ts             # `cn()` (shadcn).
│     └─ dates.ts             # Europe/Prague formátování.
├─ .env.example               # Šablona env proměnných.
├─ .github/workflows/ci.yml   # Lint + typecheck + build.
├─ Dockerfile                 # 4-stage build s Playwright Chromium libs.
├─ docker-compose.yml         # Lokální Postgres.
├─ fly.toml                   # Fly.io deploy config.
├─ next.config.ts             # `output: standalone`.
└─ prisma.config.ts           # Prisma 7 config s DATABASE_URL.
```

## Roadmap

Detailní plán v [`docs/plan.md`](docs/plan.md), živý stav v
[`docs/PROGRESS.md`](docs/PROGRESS.md).

- **Stage 1 — Bootstrap, infra a deploy-skeleton** — ✅ hotovo.
- **Stage 2 — Autentizace a správa uživatelů** — ✅ hotovo.
- **Stage 3 — RBAC a tamper-evident audit log** — ✅ hotovo.
- **Stage 4 — Zakázky a identifikační údaje stavby** — ✅ hotovo.
- **Stage 5 — Denní záznamy, fotky, počasí, materiál** — ✅ hotovo.
- **Stage 6 — Podpisy, lock, PDF export a produkční hardening** — ✅
  hotovo (sign + PDF + backup + Sentry + smoke e2e foundation;
  rozšířený login-to-PDF E2E čeká na staging deploy).
