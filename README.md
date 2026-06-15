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
- **Stage 3 — RBAC a tamper-evident audit log** — 🚧 rozpracováno.
- Stage 4–6 — čeká (zakázky → denní záznamy → podpisy/PDF/hardening).
