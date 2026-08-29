# Architektura — Stavební deník

Tenhle dokument popisuje **jak je aplikace navržená**: doménový model,
moduly v repu, klíčová rozhodnutí a místa, kde věci jdou jinak než
v "běžné" CRUD appce. Cíl je, aby se na něj dalo odkázat při PR
review nebo při onboardingu nového člověka.

Doplňující čtení:

- [`docs/DEVELOPMENT.md`](./DEVELOPMENT.md) — jak rozjet lokální dev
  (macOS Colima i Windows Docker Desktop).
- [`docs/SECURITY.md`](./SECURITY.md) — bezpečnostní architektura a airlock pipeline pro fotky.
- [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) — jak nasadit na Fly.io.
- [`docs/PROGRESS.md`](./PROGRESS.md) — *kronika* rozhodnutí a změn.
  Tady popisuju **statický stav**; PROGRESS je historie.
- [`docs/plan.md`](./plan.md) — původní specifikace, podle které byl
  MVP postavený.

---

## 1. Doménový kontext (Vyhláška 499/2006)

Aplikace **není generický issue tracker** — je to **elektronický
stavební deník**, který musí splnit požadavky:

- **Stavební zákon § 157** (povinnost vést deník u staveb od určité
  velikosti).
- **Vyhláška 499/2006 Sb., příloha č. 16 + § 6** — co všechno deník
  obsahuje (identifikace stavby, denní záznamy o pracích, počasí,
  **návštěvy a kontroly**, podpisy, dodatky).
- **Stavbyvedoucí (§ 153)** musí mít ČKAIT autorizační číslo —
  v aplikaci je to **`User.role = BOSS` + `User.ckaitNumber NOT NULL`**.
- **Příloha** vyžaduje, aby se po podpisu denní záznam **zamkl**;
  jakákoliv další změna musí jít jako "dodatek" (errata) s autorem
  a časem.

Z toho plyne pár zásadních invariantů, které se prolínají celým kódem:

| Invariant | Kde se vynucuje |
|---|---|
| Žádné tvrdé smazání záznamů. Vše je `deletedAt` soft-delete. | `User`, `Project`, `DailyReport`, `Photo`, `MaterialNeed`, `Remark`, `Visit` — `deletedAt` sloupec, filtrace v queries |
| Po podpisu (`signedAt + lockedAt`) se denní záznam **NESMÍ** měnit. | RBAC matrix (`report.update`: `!r?.reportLocked`), `assertCan` v každém mutating endpointu. Visit `createVisit`/`deleteVisit` taky čeká na unlock — po podpisu musí jít přes addendum. |
| Stavbyvedoucí MUSÍ mít ČKAIT. | `listSiteManagerCandidates` filtruje `role = BOSS AND ckaitNumber IS NOT NULL`. Vynucená validace na vstupu (CreateUserDialog ČKAIT pole označené jako povinné pro BOSS). |
| Audit log je `append-only`, i pro DB roota. | DB trigger blokuje `UPDATE`/`DELETE` na `audit_log`. Hash chain (SHA-256, prev_hash) detekuje retroaktivní změny i kdyby trigger někdo obešel. |
| Počasí v denním záznamu je důkazní snapshot. | `weather` JSONB se zapíše JEDNOU při vytvoření reportu (z Open-Meteo) a NIKDY se nepřepíše. |
| Fotky před zakrytím jsou často jediný důkaz. | PhotoGuidance banner v PhotoUploader; client resize zachovává EXIF (capturedAt + GPS). |
| Návštěvy a kontroly (TDS, BOZP, stavební úřad, …) jsou součástí dne. | `Visit` model navázaný na `DailyReport`. RBAC dovoluje i GUEST roli (typicky TDS) zapsat vlastní návštěvu. Sleduje se `authorId` + `createdAt`. |

---

## 2. Tech stack — krátce

| Vrstva | Volba | Proč |
|---|---|---|
| Runtime | Node 24+ (s Next 16 standalone) | LTS, podpora native fetch |
| Web framework | **Next.js 16 (App Router) + Turbopack** | React Server Components + Server Actions zjednodušují CRUD UI |
| UI | React 19, **shadcn/ui na Base UI**, Tailwind 4 | shadcn/ui (verze používající `@base-ui/react`, ne Radix — má pár specifik, viz Gotchas) |
| ORM | **Prisma 7 + PrismaPg adapter** | Type-safe schema, snadné migrace |
| DB | Postgres 16 | Triggery na audit_log, JSONB pro weather/payloads, full FTS v plánu |
| Auth | Auth.js v5 (NextAuth) + Credentials provider | JWT session, argon2id hashe |
| Fotky | **sharp** (server resize + EXIF strip) + **exifr** (client + server EXIF parse) + nativní `createImageBitmap` v prohlížeči | Client resize před uploadem = 5× menší payload na LTE |
| PDF | **Playwright + Chromium** přes `/print/project/[id]` server route | Tisk přes plnohodnotný browser engine = stejný výsledek jako Ctrl+P |
| Backup | **restic** → Backblaze B2 | Deduplikované enkryptované zálohy |
| Deploy | **Fly.io** (single-region) | Volume pro `/data`, Fly Postgres, secrets, machines |

Důležité: **Žádný Redis**, **žádné externí queue**, **žádný S3**.
Všechno se vejde do single-binary deployu s Postgres a `/data` volumem.
PDF queue je in-process semafor (`src/server/pdf.ts` `acquirePdfSlot`).

---

## 3. Adresářová struktura

```
.
├─ prisma/
│  ├─ schema.prisma              # Single source of truth pro DB schema
│  └─ migrations/                # Generované migrace + ručně napsané backfilly
│
├─ public/                       # Statika (favicon)
│
├─ scripts/
│  ├─ seed.ts                    # Bootstrap první admin/BOSS účet
│  ├─ verify-audit.ts            # Cron: ověření hash chainu (exit 1 = porušeno)
│  ├─ reconcile-photos.ts        # Cron: disk ↔ DB sweep pro Photo
│  ├─ backup.sh                  # Cron: restic backup do B2
│  └─ dev/                       # Lokální dev helpers (.sh + .ps1)
│
├─ src/
│  ├─ app/                       # Next.js App Router
│  │  ├─ (auth)/                 # Login, first-password-change
│  │  ├─ (app)/                  # Hlavní app (vyžaduje login)
│  │  │  ├─ admin/               # /admin/users, /admin/audit
│  │  │  ├─ projects/[id]/       # Detail zakázky + tabs
│  │  │  └─ projects/[id]/reports/[date]/  # Detail denního záznamu
│  │  ├─ api/                    # REST endpointy
│  │  │  ├─ photos/upload/       # Multipart upload (client-resize aware)
│  │  │  ├─ photos/[id]/         # Auth-gated photo serve
│  │  │  └─ projects/[id]/pdf/   # PDF render přes Playwright
│  │  └─ print/project/[id]/     # SSR-only stránka co Chromium tiskne
│  │
│  ├─ components/                # shadcn/ui (Button, Input, …) + AppHeader
│  ├─ generated/prisma/          # Prisma client (negitovaný, regen na install)
│  │
│  ├─ lib/                       # Pure utility (žádné server-only)
│  │  ├─ crypto.ts               # argon2id hash / verify
│  │  ├─ dates.ts                # cs-CZ + Europe/Prague helpers
│  │  ├─ db.ts                   # Prisma singleton + adapter
│  │  ├─ env.ts                  # Lazy env reader (required/optional)
│  │  ├─ password-gen.ts         # Generování hesel + policy validátor
│  │  └─ photo-client.ts         # Client resize + EXIF harvest
│  │
│  ├─ server/                    # Server-only logika
│  │  ├─ audit.ts                # Hash chain append (`appendAudit`, `withAudit`)
│  │  ├─ audit-hash.ts           # PURE — canonical JSON, SHA-256, verify
│  │  ├─ audit-verify.ts         # Walk celého chainu (verifyAudit)
│  │  ├─ audit-context.ts        # Request → ctx (IP, UA) pro audit
│  │  ├─ auth.ts                 # Auth.js setup + Credentials authorize
│  │  ├─ auth.config.ts          # JWT / session callbacks + edge middleware gate
│  │  ├─ permissions.ts          # PURE RBAC matrix + assertCan
│  │  ├─ rbac.ts                 # Session gates (requireUser/Boss/Admin)
│  │  ├─ rate-limit.ts           # Sliding window proti Postgres
│  │  ├─ images.ts               # sharp pipeline (resize + strip EXIF)
│  │  ├─ exif.ts                 # exifr parse na serveru (fallback)
│  │  ├─ photo-storage.ts        # FS write/delete (DATA_DIR)
│  │  ├─ pdf.ts                  # Playwright wrapper + PDF queue
│  │  ├─ mailer.ts               # Volitelný SMTP (Fly nemá SMTP nativní)
│  │  ├─ weather.ts              # Open-Meteo fetch + SSRF guard
│  │  └─ services/               # Doménové services (CRUD)
│  │     ├─ users.ts
│  │     ├─ projects.ts
│  │     ├─ reports.ts
│  │     ├─ photos.ts
│  │     ├─ notifications.ts
│  │     ├─ audit.ts             # Read-side queries pro /admin/audit
│  │     └─ photos-reconcile.ts  # Pure helper (no server-only)
│  │
│  ├─ types/                     # Next-auth modulové augmentace
│  ├─ proxy.ts                   # Edge middleware (Next 16 rename)
│  └─ instrumentation.ts         # Instrumentace
│
├─ test/
│  ├─ integration/               # Postgres přes Testcontainers
│  └─ (e2e přes Playwright je v ./e2e)
│
├─ docs/
│  ├─ ARCHITECTURE.md            # tenhle soubor
│  ├─ DEVELOPMENT.md             # local dev setup (macOS + Windows)
│  ├─ DEPLOYMENT.md              # Fly.io deploy
│  ├─ PROGRESS.md                # živý log práce + rozhodnutí
│  └─ plan.md                    # původní spec / blueprint
│
├─ Dockerfile                    # 4-stage build (base, deps, builder, runtime)
├─ docker-compose.yml            # Lokální Postgres
├─ fly.toml                      # Fly.io: machine size, volume, env, deploy
├─ next.config.ts                # Security headers, output:standalone
└─ playwright.config.ts          # E2E smoke konfigurace
```

---

## 4. Hlavní moduly a jejich zodpovědnosti

### 4.1 `src/server/audit.ts` — audit log

**Centrální mechanismus pro důvěryhodnost.** Každá doménová mutace
(create/update/delete na user, project, report, photo, …) jde přes
`withAudit()`, který:

1. Spustí transakci.
2. `SELECT FOR UPDATE` na poslední řádek `audit_log` (anti-fork).
3. Spočítá `row_hash = SHA-256(canonicalJSON(payload + prev_hash))`.
4. INSERT do `audit_log` + INSERT/UPDATE doménové tabulky **v jedné
   transakci**.

Doplněno o:

- **DB trigger** v migraci `20260530190054_audit_log` blokuje
  `UPDATE`/`DELETE` na `audit_log` i pro DB roota.
- **`scripts/verify-audit.ts`** prochází celý chain a vrací `exit 1`
  na první rozbité spojení. Cron přes Fly schedule + GitHub Action
  `audit-verify.yml`.
- **`pdf.export` audit row** se píše po úspěšném PDF stažení s
  `anchorHash` (= prvních 16 hex znaků latest `row_hash` v době
  exportu). Stejný hash je v PDF footeru → kdokoli může soubor
  cross-checknout proti audit logu.

### 4.2 `src/server/permissions.ts` + `rbac.ts` — RBAC

**Permissions matrix je čistá funkce** (žádné DB volání, žádné
`server-only`) — unit-testovatelná v izolaci. Akce jsou
exhausive `Action` union, matrix je `Record<Action, predicate>`.

Konvence:

| Akce | Brána |
|---|---|
| `user.create`, `user.update`, `user.deactivate`, `user.activate`, `user.delete`, `audit.read`, `audit.verify` | `u.isAdmin` |
| `project.create/update/delete`, `project.member.manage`, `project.list-all`, `report.sign` | `u.role === "BOSS"` |
| Vše ostatní (resource-level, např. `report.update`, `photo.upload`) | Kombinace `u.role` + `resource.projectMember` + `resource.reportLocked` |

**Klíčové rozdělení (commit `ecafb48`):** `isAdmin` (app-level admin)
je **ortogonální** k `role` (stavbyvedoucí). Majitel firmy je
obvykle `role=BOSS + isAdmin=true`. Venkovní stavbyvedoucí je
`role=BOSS + isAdmin=false`. Účetní co spravuje účty je
`role=WORKER + isAdmin=true`. Per Vyhláška 499/2006 § 153 musí mít
**jen `role=BOSS`** ČKAIT autorizaci — `isAdmin` ne.

Gates v `rbac.ts`:

- `requireUser()` — jakýkoli přihlášený uživatel.
- `requireBoss()` — `role === "BOSS"` (stavbyvedoucí akce).
- `requireAdmin()` — `isAdmin === true` (správa aplikace).
- Pro resource-level akce: `assertCan(user, action, resource)`.

### 4.3 Photo pipeline

Toto je **nejsložitější část MVP** s mobile-specific gotchas.

#### Upload — happy path (client resize aktivní):

```
[mobil / desktop]
  PhotoUploader.tsx
   └─ onChange (file picker)
      └─ preparePhotoForUpload(file)
          1. exifr.parse(file)         — EXIF z ORIGINÁLU (potřebujeme PŘED resize)
          2. createImageBitmap(file)   — browser decode
          3. canvas resize 1920 px     — long edge
          4. canvas.toBlob jpeg q=0.85 — re-encode
          → PreparedPhoto { blob, capturedAt, gps, originalBytes, resizedBytes }

   POST /api/photos/upload
     - multipart: files[], capturedAt[], gps[]   ← parallel arrays

[server]
  app/api/photos/upload/route.ts
   └─ rate-limit (60 / 5 min / user)
   └─ parse multipart
   └─ uploadPhoto(...)
      1. sharp: re-process (rotate + resize 1920 + JPEG strip EXIF)
      2. MAX_PIXELS=8M guard (post-resize cap, ne bypass)
      3. writePhotoVariants → /data/photos/{projectId}/{reportId}/{uuid}.jpg
                            + .thumb.jpg (400 px)
      4. withAudit + INSERT Photo row
         (uses clientCapturedAt + clientGps NOT server EXIF)
```

#### Klíčová rozhodnutí:

- **Klient dělá hlavní zmenšení.** Server `MAX_PIXELS = 8 MP`
  (post-resize cap, 2× nad 1920²). Server stále stripuje EXIF,
  takže klient ho musí harvestnout PŘED resize a poslat zvlášť.
- **Klient `CLIENT_DECODE_MAX_PIXELS = 60 MP`** (soft cap), aby
  i 50 MP foto z Pixel 8 Pro prošlo dekódováním → resize → upload.
- **HEIC handling:** `accept` má `image/heic,image/heif`. iOS Safari
  HEIC dekóduje, Android Chrome ne (vrací JPEG ekvivalent). Pokud
  HEIC nelze dekódovat, `preparePhotoForUpload` shodí
  `PhotoClientPrepareError` a soubor se zařadí do `failures`.
- **Mobile gotcha:** `<input type="file">` přes shadcn `<Input>`
  wrapper na mobile (iOS + Android) polyká `onChange` → nikdy se
  nezavolá. Workaround: použít **nativní `<input>` přímo** s
  Tailwind class kopírujícími shadcn vzhled. Viz `PhotoUploader.tsx`.
- **Dev hydration gotcha:** Next 16 + Turbopack v dev módu **NEhyd-
  ratuje React** na Android Chrome přes HTTP LAN IP. `pnpm dev`
  nestačí pro mobile test — musí být `pnpm build && pnpm start` nebo
  HTTPS deploy.

#### Serve:

```
GET /api/photos/[id]?variant=thumb
  - auth() → 404 pokud nepřihlášen (nikoliv 401 — neunikáme existenci)
  - getPhotoFileForUser: BOSS vidí vše, ostatní jen member projekty
  - resolvePhotoAbsolutePath: defence-in-depth proti path traversal
  - stream file → Response s Cache-Control: private, max-age=86400
```

### 4.4 Audit log views — `/admin/audit`

Read-only přehled hash chainu pro BOSS+isAdmin (přes `assertCan
("audit.read")`).

- Page-size 50 řádků s forward-only kurzor paginací.
- Filtry: actor, action, entityType, datum-range.
- "Verify chain" tlačítko spustí `verifyAuditAction` (= synchronní
  walk, vrací výsledek do UI).

### 4.5 PDF export — `/api/projects/[id]/pdf`

```
1. auth + getProjectForUser (RBAC)
2. rate-limit (10 / 5 min / user)
3. Vyrobit print URL: /print/project/[id]?from=&to=
4. getLatestAuditHash (top of chain)
5. buildFooterTemplate(anchor16)
6. renderPdf({ url, cookieHeader, footerHtml })
   - PDF queue (in-process semafor): max PDF_RENDER_CONCURRENCY=1
   - playwright.chromium.launch headless
   - new context with forwardedCookies (= auth session)
   - page.goto(printUrl) → waitForLoadState 'networkidle'
   - page.pdf({ format: A4, displayHeaderFooter, footerTemplate })
7. appendAudit "pdf.export" { project, range, bytes, anchorHash }
8. Stream PDF zpět s Content-Disposition: attachment
```

Co PDF NEukládáme na disk — je to *view* nad source-of-truth DB.
Reprodukce: najdi `pdf.export` audit row, podle `anchorHash` najdi
bod v chainu, obnov backup, re-render. Detaily v commit
[`bf09b6e`](https://github.com/simontom/stavebni-denik/commit/bf09b6e).

### 4.6 Notifikace (in-app bell)

Místo SMTP používáme **`Notification` tabulku + bell ikona v
`AppHeader`**. Důvod: Fly.io nemá nativní SMTP, externí relay
(SendGrid, Postmark) jsme nechtěli ten první týden přidávat.

- `notifyUser` v `src/server/services/notifications.ts` — silently
  skip pokud recipient ID neexistuje (no throw).
- Akce: `audit.chain_broken`, `report.signed`, `material.added`, …
- `Notification.payload` je JSONB → `Prisma.InputJsonValue` cast.
- **Neprochází `withAudit`** (UI state, ne doménová mutace).
  Hard-delete povolen.

---

## 5. Zásadní gotchas (lessons learned)

Tyhle věci jsme objevili bolestivě, stojí za to si je zapsat:

1. **Next 16 + Turbopack + mobile Chrome over HTTP LAN** → React se
   NEHYDRATUJE. `pnpm dev` na mobilu nefunguje. Workaround:
   `pnpm build && pnpm start`. Production na HTTPS toto nemá.

2. **CSP v produkci potřebuje `'unsafe-eval'`** — bundled deps
   (next-auth JWT, crypto polyfilly) používají `eval`/`new Function`.
   Lepší dlouhodobé řešení: nonce-based CSP (TODO).

3. **Zod 4 `.optional()` × FormData null** — `data.get()` vrací
   `string | null`. `.optional()` akceptuje pouze `undefined`. Pro
   form fields s null použij `.nullish()` nebo pre-normalize přes
   `String(data.get(x) ?? "")`.

4. **shadcn/ui na Base UI vs Radix** — `SelectValue` v Base UI
   defaultně ukazuje raw value. Musí se předat children jako funkce:
   `<SelectValue>{(value) => labelFor(value)}</SelectValue>`.

5. **shadcn `<Input>` polyká `onChange` u `type="file"` na mobile.**
   Pro file inputy používej nativní `<input>` přímo. Pro
   "Pořídit foto" tlačítko **používej `<label htmlFor=...>`** (label
   trigger), ne JS `ref.click()` (mobile Chrome to ignoruje).

6. **Base UI `<Button>` má `nativeButton=true` default** — když
   chceš render do `<Link/>` (`render={<Link/>}`), musíš nastavit
   `nativeButton={false}`. V našem wrapperu `src/components/ui/button.
   tsx` je to autodetekovaný podle přítomnosti `render` propu.

7. **`audit_log` má append-only trigger.** V testech ho **NESMÍŠ**
   mazat (`deleteMany` shodí). Integration testy používají unikátní
   nicknames / odd-id, aby se předchozí audit rows nepletly.

8. **`'use client'` komponenta s `useSyncExternalStore`** je
   bezpečná pro SSR/hydrataci pokud `getServerSnapshot` vrací
   stabilní hodnotu. Pokud client by se mohl strukturálně lišit od
   serveru (např. `dismissed === true` → `return null`),
   `dynamic({ssr: false})` z `next/dynamic` to vyřeší — ale vyhni
   se mu, pokud to nutně nepotřebuješ (může způsobit remount
   problémy).

9. **`output: standalone` v `next.config.ts`** → `pnpm start` (= `next
   start`) ve standalone módu sice nastartuje, ale **NEUMÍ správně
   servovat `_next/static/*`** — vrací `text/plain` místo
   `application/javascript`. Browser pak kvůli `X-Content-Type-Options:
   nosniff` chunky odmítne s `NS_ERROR_CORRUPTED_CONTENT` a frontend
   nehydratuje. V logu vedle toho vidíš warning *"next start does not
   work with output: standalone"*.

   **Správný způsob:** `node .next/standalone/server.js`. Ale ten
   potřebuje `.next/static` a `public/` zkopírované **dovnitř**
   `.next/standalone/` (standalone bundle je úmyslně neobsahuje).
   Helper `scripts/dev/prod-start.{sh,ps1}` to dělá automaticky.

10. **Aplikace nepoužívá komplexní loggovací frameworky**, ale nativní stdout loggování optimalizované pro Grafanu.

---

## 6. Data model — ER diagram (textový)

```
User ─┐
      ├──< Session
      ├──< ProjectMember >── Project ─┐
      ├──< Project (siteManager)      │
      ├──< DailyReport (author)       │
      │                               │
      └── AuditLog (actor)            │
                                      ▼
                                DailyReport ─┐
                                              ├──< Photo
                                              ├──< Remark
                                              ├──< MaterialNeed
                                              └──< Addendum

Notification ─── recipient → User
```

**Klíče:**

- `User.nickname` unique (lowercase, identity).
- `User.deletedAt` → soft delete (přihlášení zakázáno přes
  `authorize()`, vypadá z dropdownů přes `where: { deletedAt: null }`).
- `User.isAdmin` orthogonální k `role`.
- `Project.siteManagerId` → User (musí mít `role=BOSS + ckaitNumber`).
- `DailyReport (projectId, date)` unique — jeden záznam za den.
- `DailyReport.signedAt + lockedAt` — po podpisu lock.
- `DailyReport.workersByTrade` JSONB — pole `[{trade,count}]`.
- `DailyReport.weather` JSONB — frozen snapshot z Open-Meteo.
- `Photo.pathOriginal` / `pathThumb` — relativní k `DATA_DIR`.
- `Photo.gps` JSONB — `{lat, lon}` nebo null.
- `MaterialNeed.resolved` flag (UI tab Material Gantt).
- `AuditLog.rowHash`, `.prevHash` — SHA-256 hex (`64` znaků).
- `AuditLog.ts` — explicitní (NE `DEFAULT CURRENT_TIMESTAMP`),
  protože hash zahrnuje `ts` a verifier ho recomputuje.

---

## 7. Bezpečnostní vrstvy — krátce

(Detailněji v README.md → „Bezpečnost — vrstvy obrany".)

- **HTTP headers:** CSP (frame-ancestors none, no third-party),
  HSTS, XFO DENY, Permissions-Policy (camera/geo self only).
- **Auth:** argon2id (OWASP 2024 params), JWT session (HttpOnly,
  Secure, SameSite=Lax), `mustChangePwd` flow po prvním loginu.
- **Rate limit (Postgres-backed sliding window):**
  - login: 5 / 15 min / nickname + 20 / 15 min / IP
  - photo upload: 60 / 5 min / user
  - PDF render: 10 / 5 min / user
- **Path traversal:** `resolvePhotoAbsolutePath` odmítá cokoliv mimo
  `DATA_DIR`.
- **SSRF:** Open-Meteo allow-list (`api.open-meteo.com` /
  `archive-api.open-meteo.com`) + HTTPS-only v produkci.
- **SQL injection:** veškerý raw SQL přes Prisma tagged template
  (parametrizované).
- **Audit log:** append-only DB trigger + hash chain detekce.
- **Disk konzistence:** `pnpm reconcile:photos` najde orphan +
  missing soubory mezi DB a `/data`.

---

## 8. Kde co najít — quick lookup

| Hledám… | Soubor |
|---|---|
| Definice DB schema | `prisma/schema.prisma` |
| Co znamená "audit chain" | `src/server/audit-hash.ts` (pure) + `src/server/audit.ts` (wrappers) |
| Kdo smí co | `src/server/permissions.ts` MATRIX |
| Edge middleware (auth gate) | `src/proxy.ts` + `src/server/auth.config.ts` `authorized()` |
| ENV proměnné | `src/lib/env.ts` (centralized, lazy, required/optional) |
| Photo pipeline | `src/lib/photo-client.ts` (client) + `src/server/images.ts` (server) + `src/server/services/photos.ts` (orchestrace) |
| PDF wrapper | `src/server/pdf.ts` + `src/app/print/project/[id]/page.tsx` (print view) |
| Backup script | `scripts/backup.sh` |
| Reconcile script | `scripts/reconcile-photos.ts` |
| Seed | `scripts/seed.ts` (vytvoří bootstrap admin) |

---

## 9. Změny vs. původní plan.md

`docs/plan.md` byl původní MVP specifikace. Od té doby se posunulo:

- **`split-admin-boss`** — `isAdmin` flag oddělen od `role=BOSS`
  (Vyhláška § 153 vyžaduje ČKAIT pro stavbyvedoucího, ne pro app
  admina). Detail v commit `ecafb48`.
- **Client-side photo resize** — viz § 4.3.
- **PDF nearchivujeme** — viz § 4.5.
- **Notification bell místo SMTP** — viz § 4.6.
- **Material Gantt napříč reporty** v project detail tabu — nový
  read-only view pro BOSS+WORKER.

Detailní log změn v `docs/PROGRESS.md`.
