# Stavební deník

Elektronický stavební deník dle § 157 stavebního zákona (zák. č. 283/2021 Sb.)
a přílohy č. 16 vyhlášky 499/2006 Sb. Aplikace je **single-tenant** — jedna
instance = jedna firma.

> 📖 **Dokumentace:**
> - [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — jak je app navržená, doménový model, klíčové moduly, gotchas.
> - [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — lokální dev setup (macOS + Windows).
> - [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Fly.io deploy guide.
> - [`docs/plan.md`](docs/plan.md) — původní MVP spec.
> - [`docs/PROGRESS.md`](docs/PROGRESS.md) — živý log práce.

## Tech stack

| Vrstva           | Technologie                                                    |
| ---------------- | -------------------------------------------------------------- |
| Framework        | Next.js 16 (App Router, React 19, RSC + server actions)        |
| DB & ORM         | Postgres 16 + Prisma 7 (driver-adapter model, `@prisma/adapter-pg`) |
| Auth             | Auth.js v5 Credentials + argon2id                              |
| RBAC             | Service-layer `assertCan(...)` + `requireBoss`/`requireAdmin`  |
| Audit log        | Append-only `audit_log` s SHA-256 hash chain + DB trigger      |
| Storage fotek    | Lokální Fly volume `/data`, client resize → sharp pipeline     |
| Počasí           | Open-Meteo (zdarma, bez API klíče) + SSRF allow-list           |
| PDF              | Playwright headless Chromium + in-process queue                |
| UI               | Tailwind 4 + shadcn/ui (Base UI) + sonner                      |
| Hosting          | Fly.io, Frankfurt region                                       |

## Local development — quick start

```bash
# První run (jednou)
./scripts/dev/setup.sh        # macOS / Linux / WSL
.\scripts\dev\setup.ps1       # Windows PowerShell

# Běžný start
./scripts/dev/up.sh           # nebo .ps1
pnpm dev

# Mobile testing (Turbopack dev nehydratuje na mobile!)
pnpm build && pnpm start

# Reset DB
./scripts/dev/reset-db.sh

# Vypnutí
./scripts/dev/down.sh
```

App pojede na <http://localhost:3000>. Health check je na
<http://localhost:3000/healthz>.

Pro detail (prerekvizity, Colima vs Docker Desktop, Windows-specific
setup, troubleshooting) viz [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Scripts

| Script                     | Co dělá                                                  |
| -------------------------- | -------------------------------------------------------- |
| `pnpm dev`                 | Next.js dev server.                                      |
| `pnpm build`               | Produkční build (`output: standalone`).                  |
| `pnpm start`               | Spustí lokálně produkční standalone build (`node .next/standalone/server.js`); nejdřív zkopíruje `public/` + `.next/static/` vedle serveru, jinak by se assety neservírovaly. Vyžaduje předchozí `pnpm build`. |
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

**Disk ↔ DB reconcile.** OOM kill nebo crash uprostřed
`writePhotoVariants` může zanechat osiřelé JPEGy v
`/data/photos/...` bez odpovídajícího řádku v `photos` tabulce
(leak diskového quota), nebo obráceně řádek v DB bez souboru
(404 na photo serve route). `pnpm reconcile:photos` projede oba
zdroje a vypíše rozdíly:

```bash
# read-only report (human-readable)
pnpm reconcile:photos

# stejné, ale jednořádkový JSON pro cron / log scraping
pnpm reconcile:photos --json

# úklid: smaže orphan soubory starší než 5 min (grace window
# kvůli in-flight uploadu)
pnpm reconcile:photos --delete-orphans
```

Exit codes: `0` = clean, `1` = drift detected, `2` = unexpected
error. Strukturovaný log se zapisuje do
`{DATA_DIR}/reconcile-photos.log` (vedle `audit-verify.log`).
Doporučeno spouštět z týdenního cronu — viz `verify-audit.yml`
workflow jako šablona.

## Backup & restore

Nightly snapshot Postgres dumpu + `/data/photos` přes
[restic](https://restic.net/) do **Backblaze B2** (doporučeno).
Skript je v `scripts/backup.sh` a v produkčním image je zkopírovaný
do `/app/scripts/backup.sh`.

### Proč Backblaze B2 (a ne S3 / R2)?

| | B2 | R2 | S3 |
|---|---|---|---|
| Egress / restore poplatek | **$0** | $0 | ~$0.09/GB |
| Storage / GB / měsíc | **$0.006** | $0.015 | $0.023 |
| restic kompatibilita | nativní | přes S3 API | nativní |
| Setup | 5 min (keyID + key) | trochu složitější (CloudFlare účet) | nejvíc kroků |

Pro stavební deník (~ jednotky GB fotek / projekt, restoru jednou
za uherský rok) je **B2 jasně nejlevnější** — desítky korun ročně.
S3/R2 podporujeme dál (přes `RESTIC_REPOSITORY=s3:...` a
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`), ale defaultní cesta
v dokumentaci je B2.

### Konfigurace (Fly secrets — B2)

Krok za krokem pro Backblaze B2:

```bash
# 1. V Backblaze B2 console (https://www.backblaze.com/b2/) vytvoř:
#    - Bucket "stavebni-denik-backup" (private, region "EU-Central")
#    - App key omezený jen na tento bucket
#      (Capabilities: listFiles, readFiles, writeFiles, deleteFiles)

# 2. Nastav Fly secrets:
fly secrets set \
  RESTIC_REPOSITORY="b2:stavebni-denik-backup:/restic" \
  RESTIC_PASSWORD="$(openssl rand -base64 32)" \
  B2_ACCOUNT_ID="<keyID>" \
  B2_ACCOUNT_KEY="<applicationKey>"

# 3. RESTIC_PASSWORD si SCHOVEJ mimo Fly (heslový manažer / bezpečné
#    místo) — bez něj se zálohy NEDEŠIFRUJÍ, restic password reset
#    neexistuje. Doporučení: zapsat zároveň do off-site safe.
```

> **Alternativa — S3 / R2:** `RESTIC_REPOSITORY=s3:https://endpoint/bucket`
> + `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. Stejný restic
> protokol, jiný backend.

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

## Bezpečnost — vrstvy obrany

Stručný přehled toho, jak je aplikace „opevněná". Kompletní threat
model + design rozhodnutí žije v `docs/plan.md`, tady je seznam
**funkcionálních ochran**, aby bylo na první pohled vidět, co je
nasazené.

### HTTP hlavičky (`next.config.ts`)
- **Content-Security-Policy** — `default-src 'self'`, žádné 3rd party
  skripty / iframy. `connect-src` whitelist obsahuje pouze
  `api.open-meteo.com`. `frame-ancestors 'none'` (anti-clickjacking).
  Pozn.: `script-src 'unsafe-inline'` zůstává kvůli Next.js JSON
  injection — nonce-based CSP je TODO.
- **HSTS** `max-age=63072000; includeSubDomains; preload`.
- **X-Frame-Options DENY**, **X-Content-Type-Options nosniff**,
  **Referrer-Policy strict-origin-when-cross-origin**.
- **Permissions-Policy** — `camera=(self), geolocation=(self),
  microphone=()`.

### Autentizace
- **Auth.js v5** s argon2 hashem hesel (resp. via bcrypt-style adapter).
- **Rate-limit přihlášení** (sliding window, Postgres-backed) —
  `5 pokusů / 15 min / nickname` + `20 pokusů / 15 min / IP`.
  Implementace `src/server/rate-limit.ts`.
- **Cookie session** (HttpOnly, Secure v produkci, SameSite).
- **Mandatory password change** při prvním přihlášení
  (`mustChangePwd` flag).

### Rate-limit drahých operací
- **POST `/api/photos/upload`** — `60 / 5 min / user`. Bráni leaked-
  credential útoku spamovat sharp pipeline (OOM risk na 1 GB Fly).
- **GET `/api/projects/[id]/pdf`** — `10 / 5 min / user`. Chromium +
  sharp je nejdražší operace; PDF queue serializuje běh, rate-limit
  cap-uje hloubku fronty.
- Při překročení → `429 Too Many Requests` + `Retry-After` header.

### Audit log (tamper-evident)
- Hash chain (SHA-256 přes serialized row + prev_hash) v `audit_log`.
- DB triggery odmítají `UPDATE`/`DELETE` — append-only na úrovni
  Postgresu, ne aplikace.
- Denní `pnpm verify:audit` (cron / GitHub Actions). Při porušení
  fanout in-app notifikace pro všechny BOSS + volitelný SMTP alert.

### Soubory a path traversal
- Photo serve route `/api/photos/[id]` filtruje absolutní path
  resolvem přes `resolvePhotoAbsolutePath` (odmítá `../`,
  `/etc/passwd`). Auth-gated; 404 místo 403/401 — žádný leak
  existence.
- Photo upload pipeline: client resize na 1920 px (max 60 MP vstup),
  celkový dávkový limit `MAX_BATCH_BYTES = 20 MiB`, server pak `MAX_PIXELS = 8 MP` +
  `MAX_UPLOAD_BYTES = 5 MiB` (tvrdý cap na jednotlivé soubory i celou dávku přes curl / API).
  Soubory ukládány pod UUID, nikdy uživatelské jméno.

### SSRF
- Open-Meteo fetch má **allow-list hostů** (`api.open-meteo.com`,
  `archive-api.open-meteo.com`) + vyžaduje **HTTPS** v produkci.
  Brání útoku přes `OPEN_METEO_BASE` ukazující na internal služby
  (např. AWS IMDS `169.254.169.254`). `NODE_ENV=test` short-circuit
  kvůli mockovaným URL v testech.

### SQL injection
- Všechen raw SQL přes Prisma tagged template (`$queryRaw\`...\${param}\`` /
  `$executeRaw`) → bind params, ne string concatenation. Žádné
  uživatelské vstupy se neslejí do SQL stringu.

### Disk ↔ DB konzistence
- `pnpm reconcile:photos` (cron-friendly) najde:
  - orphan soubory (OOM kill uprostřed uploadu),
  - missing soubory (DB řádek bez bytu na disku).
  - `--delete-orphans` smaže (s 5 min grace window proti in-flight uploadu).

### Co ZBÝVÁ (nice-to-have, není blokátor produkce)
- **Nonce-based CSP** místo `'unsafe-inline'` na script-src.
- **Photo serve rate-limit** (currently jen filesystem read; nízká
  cena).
- **Brute-force protection na password-change** route (currently
  jen na login).

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
