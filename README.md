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
| Storage fotek    | Lokální Fly/Railway volume `/data`, sharp resize (Stage 5)     |
| Počasí           | Open-Meteo (zdarma, bez API klíče) (Stage 5)                   |
| PDF              | Playwright headless Chromium (Stage 6)                         |
| UI               | Tailwind 4 + shadcn/ui (Radix) + sonner                        |
| Hosting          | Fly.io / Railway, Frankfurt region                             |

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

```bash
# Jednorázové
fly apps create stavebni-denik
fly volumes create stavebni_denik_data --size 10 --region fra
fly postgres create --name stavebni-denik-db --region fra
fly postgres attach stavebni-denik-db
fly secrets set \
  AUTH_SECRET="$(openssl rand -base64 32)" \
  AUTH_URL="https://stavebni-denik.fly.dev"

# Při každém releaseu
fly deploy
```

Migrace běží automaticky při startu kontejneru
(`prisma migrate deploy && node server.js` v `Dockerfile`).

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
- **Stage 6 — Podpisy, lock, PDF export a produkční hardening** — 🚧
  podpisy + PDF + backup hotové; Sentry monitoring a smoke E2E čekají.
