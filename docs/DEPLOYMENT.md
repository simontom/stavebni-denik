# Deployment — Fly.io

Tenhle dokument popisuje, jak nasadit aplikaci na **Fly.io** (single
region, single machine + persistent volume + Fly Postgres). Je to
jediný oficiálně podporovaný target.

Pro architekturu app viz [`ARCHITECTURE.md`](./ARCHITECTURE.md).
Pro lokální dev viz [`DEVELOPMENT.md`](./DEVELOPMENT.md).

---

## TL;DR — first deploy

```bash
# 0. Předpoklad: máš flyctl + účet na Fly.io
brew install flyctl   # macOS
# Windows: scoop install flyctl  ⌒OR⌒  iwr https://fly.io/install.ps1 -useb | iex
fly auth login

# 1. Vytvořit Fly Postgres
fly postgres create --name stavebni-denik-pg --region prg \
  --vm-size shared-cpu-1x --volume-size 10

# 2. Vytvořit app + persistent volume pro /data
fly apps create stavebni-denik
fly volumes create data --region prg --size 5 --app stavebni-denik

# 3. Attach Postgres (vytvoří DATABASE_URL secret)
fly postgres attach stavebni-denik-pg --app stavebni-denik

# 4. Nastavit secrets (viz § 3)
fly secrets set \
  AUTH_SECRET="$(openssl rand -base64 32)" \
  AUTH_URL="https://stavebni-denik.fly.dev" \
  --app stavebni-denik

# 5. Deploy
fly deploy --app stavebni-denik

# 6. Bootstrap admin (jednou)
fly ssh console --app stavebni-denik -C "node /app/scripts/seed.js"
# Vypíše vygenerované heslo → ulož do bezpečného úložiště!
```

---

## 1. Architektura deploye

```
                   ┌─────────────────────┐
   Uživatel ──→    │ Fly Edge (Anycast)  │
   (HTTPS)         │ TLS termination     │
                   └─────────┬───────────┘
                             │ HTTP/2
                   ┌─────────▼───────────┐
                   │  Fly Machine        │
                   │  region: prg        │
                   │  shared-cpu-1x      │ ← swap_size_mb=512
                   │  1 GB RAM           │
                   │                     │
                   │  ┌───────────────┐  │
                   │  │ node server.js│  │ (Next standalone)
                   │  └───────┬───────┘  │
                   └──────────┼──────────┘
                              │
              ┌───────────────┴────────────────┐
              │                                │
       ┌──────▼──────┐                ┌────────▼────────┐
       │ /data       │                │ Fly Postgres    │
       │ volume      │                │ (separate app)  │
       │ - photos/   │                │                 │
       │ - logs      │                │                 │
       └─────────────┘                └─────────────────┘
              │
              │ nightly cron
              ▼
       ┌──────────────┐
       │ restic →     │
       │ Backblaze B2 │
       └──────────────┘
```

**Klíče:**

- **Single machine, single region.** Aplikace nemá DB cluster a
  spoléhá na in-process semafor pro PDF queue. Multi-instance by
  vyžadoval externí queue / lock service.
- **`/data` volume je SPF (single point of failure)** mezi nightly
  zálohami. Restore z B2 trvá minuty — viz § 5.
- **Fly Postgres app** je separate Fly app, attached přes
  `fly postgres attach` (= secret `DATABASE_URL` se Set automaticky).

---

## 2. `fly.toml` — referenční konfig

V repu je referenční `fly.toml`. Klíčové sekce:

```toml
app = "stavebni-denik"
primary_region = "prg"
swap_size_mb = 512                  # OOM ochrana přes swap na volume

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  DATA_DIR = "/data"
  TZ = "Europe/Prague"
  PORT = "3000"
  OPEN_METEO_BASE = "https://api.open-meteo.com/v1"
  PDF_RENDER_CONCURRENCY = "1"      # PDF queue depth (in-process)

[deploy]
  release_command = "pnpm exec prisma migrate deploy"

[[services]]
  internal_port = 3000
  protocol = "tcp"
  [[services.ports]]
    handlers = ["http"]
    port = 80
    force_https = true
  [[services.ports]]
    handlers = ["tls", "http"]
    port = 443

[[mounts]]
  source = "data"
  destination = "/data"

[[vm]]
  size = "shared-cpu-1x"
  memory = "1gb"
```

---

## 3. Secrets

Nastavují se přes `fly secrets set KEY=value`. **NIKDY** commit
do repa.

| Secret | Povinný | Co dělá |
|---|---|---|
| `DATABASE_URL` | ano (auto z `postgres attach`) | Connection string na Fly Postgres |
| `AUTH_SECRET` | ano | JWT signing secret. **Generuj `openssl rand -base64 32`**. Změna invaliduje všechny session. |
| `AUTH_URL` | ano | Plně-qualified URL appky (např. `https://stavebni-denik.fly.dev`). Auth.js callbacks ji vyžadují. |
| `SENTRY_DSN` | ne | Pokud nastavíš, server errors půjdou do Sentry. Bez něj je SDK no-op. |
| `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` | ne | Pro source-map upload při buildu (build-time, ne runtime) |
| `RESTIC_REPOSITORY` | jen pro backup | např. `b2:stavebni-denik-backup:/restic` |
| `RESTIC_PASSWORD` | jen pro backup | **ULOŽ MIMO Fly** — bez něj zálohy nedešifruješ! |
| `B2_ACCOUNT_ID`, `B2_ACCOUNT_KEY` | jen pro B2 backup | App key omezený na bucket |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | jen pro S3/R2 backup | Alternativa k B2 |
| `ALERT_EMAIL` | ne | Cílová adresa pro SMTP alerty (např. broken audit chain) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | ne | Volitelný relay (Fly nemá SMTP) |
| `NEXT_PUBLIC_APP_NAME` | ne | Branding v UI a metadata (default "Stavební deník") |

Příklad nastavení:

```bash
fly secrets set \
  AUTH_SECRET="$(openssl rand -base64 32)" \
  AUTH_URL="https://stavebni-denik.fly.dev" \
  --app stavebni-denik
```

---

## 4. Bootstrap (jednorázový po prvním deployi)

```bash
# 1. Ověř, že migrace proběhly (`release_command` ve fly.toml):
fly logs --app stavebni-denik | grep "Applying migration"

# 2. Vytvoř bootstrap admina (vypíše vygenerované heslo!):
fly ssh console --app stavebni-denik
> cd /app
> node scripts/seed.js   # zkompilovaná verze TS
# nebo pokud máš tsx v image:
> pnpm db:seed

# Výpis:
#   === Seed complete ===
#   Nickname: admin
#   Password: AbC123!xyz...
#   ULOŽ DO PASSWORD MANAGERU!

# 3. Otevři prohlížeč → https://stavebni-denik.fly.dev/login
# 4. Přihlas se → mustChangePwd=true → změň heslo
```

---

## 5. Backup & restore (Backblaze B2)

Detail v README.md → "Backup & restore". Krátký reference:

### Setup B2

```bash
# 1. Backblaze B2 console: vytvoř bucket "stavebni-denik-backup" + app key
# 2. Fly secrets:
fly secrets set \
  RESTIC_REPOSITORY="b2:stavebni-denik-backup:/restic" \
  RESTIC_PASSWORD="$(openssl rand -base64 32)" \
  B2_ACCOUNT_ID="<keyID>" \
  B2_ACCOUNT_KEY="<applicationKey>" \
  --app stavebni-denik

# 3. ULOŽ RESTIC_PASSWORD mimo Fly (heslový manažer + off-site safe)
```

### Spustit zálohu

```bash
# Ručně:
fly ssh console --app stavebni-denik -C "/app/scripts/backup.sh"

# Nightly (Fly Machines schedule):
fly machine run . --schedule daily \
  --command "/app/scripts/backup.sh" \
  --app stavebni-denik
```

### Restore

```bash
# 1. Z lokálního stroje s restic + secrets:
restic snapshots --tag stavebni-denik-nightly
restic restore <snapshot-id> --target /tmp/restore

# 2. Postgres dump → DB:
gunzip -c /tmp/restore/tmp/<...>/db.sql.gz | \
  fly postgres connect --app stavebni-denik-pg | \
  psql

# 3. Fotky zpět:
rsync -a /tmp/restore/data/photos/ \
  fly-ssh-tunnel:/data/photos/

# 4. Ověř audit chain:
fly ssh console --app stavebni-denik -C "pnpm verify:audit"
```

Pokud `verify:audit` nahlásí porušení, je obnovený stav nedůvěryhodný
— vyber starší snapshot a opakuj.

---

## 6. Monitoring + alerty

| Co | Kde |
|---|---|
| **Server errors** | Sentry (pokud `SENTRY_DSN` nastaven) |
| **Healthcheck** | `/healthz` (DB + volume probe) — Fly machines health check |
| **Audit chain integrity** | Daily cron `pnpm verify:audit` → exit 1 + in-app notification pro každého isAdmin uživatele |
| **CPU / RAM / disk** | Fly dashboard, alerty v Fly UI |
| **Backup success** | restic exit code + log do `/data/backup.log` |
| **PDF render slowness** | Sentry transaction (pokud SENTRY_DSN) + `getPdfQueueDepth` exportovat do `/healthz` (TODO) |

---

## 7. Update / re-deploy

```bash
# Po push do main:
git pull
fly deploy --app stavebni-denik

# Fly automaticky:
#   1. Build Dockerfile
#   2. Spustí release_command (= prisma migrate deploy)
#   3. Vytvoří nový machine, spustí, healthcheck OK → swap traffic
#   4. Zruší starý machine
```

### Rollback

```bash
fly releases --app stavebni-denik
fly releases rollback <version> --app stavebni-denik
```

**Pozor na migrace.** Pokud nový deploy přidal sloupec a rollback to
nevrátí, schema bude mít sloupec, ale starý kód ho nezná (= většinou
OK, Prisma ignoruje extra sloupce). Pokud nový deploy DROP-uje
sloupec, rollback NEPOMŮŽE — kód bude chtít sloupec, který už není.
Zkontroluj migraci před deployem.

---

## 8. Po-deploy checklist

```
[ ] fly status --app stavebni-denik → machine running, healthy
[ ] fly logs --app stavebni-denik | grep "Ready in"
[ ] curl -fsS https://stavebni-denik.fly.dev/healthz → 200
[ ] Login na /login funguje
[ ] /admin/audit má pdf.export / session.signin entries
[ ] Backup secrets nastaveny → fly ssh console -C "/app/scripts/backup.sh" → exit 0
[ ] Daily cron schedule existuje pro backup + verify:audit
```

---

## 9. Známé limity

- **Single-region, single-machine.** Pro multi-region by se PDF
  queue + audit log (s `FOR UPDATE` lock) musela přepracovat na
  cross-instance synchronizaci.
- **Fly Postgres free tier** stačí pro pár stovek záznamů. Při růstu
  → škálovat machine přes `fly postgres update`.
- **SMTP přes Fly nefunguje nativně.** Pokud chceš e-mail alerty,
  potřebuješ externí relay (SendGrid, Postmark, Mailgun). V app se
  to gate-uje na `SMTP_*` secrets — bez nich aplikace alerty
  zobrazuje JEN v in-app notification bell.
- **`/data` volume je SPF.** Strategie: nightly restic backup do
  off-site B2 + `pnpm reconcile:photos` cron pro detekci orphan/
  missing souborů.

---

## 10. Místa, která možná budou potřeba laděním

| Co | Kde |
|---|---|
| PDF render timeout (default 120 s) | `fly.toml` → `[deploy] timeout` nebo `app/api/projects/[id]/pdf/route.ts` `export const maxDuration` |
| PDF queue size (default 1) | `PDF_RENDER_CONCURRENCY` env (vyšší jen na ≥ 2 GB RAM) |
| Swap size | `fly.toml` → `swap_size_mb` |
| Photo upload rate-limit | `src/server/rate-limit.ts` → `PHOTO_UPLOAD_USER_LIMIT` |
| Login rate-limit | `src/server/rate-limit.ts` → `LOGIN_NICKNAME_LIMIT` / `LOGIN_IP_LIMIT` |
| Audit retention | (žádná — audit_log je append-only forever) |
| Photo retention | (žádná — `Photo.deletedAt` je soft, soubory zůstávají) |

Co **NEMĚŇ** bez konzultace:

- **Audit hash chain canonical JSON** — `src/server/audit-hash.ts`
  `canonicalJSON()`. Jakákoliv změna invaliduje celý historický
  chain.
- **Photo path layout** — `{DATA_DIR}/photos/{projectId}/{reportId}/
  {uuid}.jpg`. Změna by potřebovala batch migrace souborů.
- **DB triggery na `audit_log`** — append-only ochrana.
