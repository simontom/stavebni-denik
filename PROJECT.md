# Project: Stavební deník (construction site diary)

## Architecture (current stack)

- **Backend**: Kotlin 2.1, Ktor 3.1, jOOQ 3.21, Flyway 12, **PostgreSQL 18 only** (schema uses `uuidv7()`), Argon2id passwords, JWT in an HttpOnly cookie.
- **Frontend**: Vite 8, React 19, React Router 7, Tailwind CSS 4 (`frontend/`, its own pnpm workspace; `frontend/pnpm-lock.yaml` is committed and CI and the image build install with `--frozen-lockfile`, so a `package.json` that disagrees with it fails the build).
- **PDF export** (`GET /api/reports/{id}/pdf`): the `typst` command line tool (installed in the Docker image, pinned by checksum) renders the fixed template `backend/src/main/resources/pdf/report.typ`. User text never becomes part of the template: it travels as JSON data and is shown as plain text, so it cannot be executed as typst code. Each export gets its own temporary directory, a 20 s timeout (the process is killed), and at most two exports run at the same time. Without typst the endpoint answers `503`; it never returns an empty PDF.
- **Docker image** (`Dockerfile`): Ktor + the built SPA + typst on a **glibc** (Ubuntu) Temurin JRE. It must not be Alpine: the password library `argon2-jvm` loads a native library through JNA, and on Alpine (musl libc) the JVM dies with SIGSEGV as soon as a password is hashed (creating a user). The application also hashes and verifies one throwaway password at startup (`PasswordService.ensureWorks`), so such a broken environment fails at deploy time, not at the first account creation. **The application does not run as root:** the entrypoint (`/app/entrypoint.sh`, written by the Dockerfile) starts as root only to give the data volume (`/data/uploads`, root-owned when Fly mounts it) to the user `app`, then drops privileges with `setpriv` before the JVM starts; the CI boot test checks the process user and the owner of the photo directory. **Memory:** `JAVA_TOOL_OPTIONS` caps the heap at 40 % of the machine (`-XX:MaxRAMPercentage=40`) and ends the process on an out-of-memory error (Fly restarts it); the rest is for what the heap does not hold: Argon2 (up to 4 x 64 MiB native), image decoding, class metadata, threads and the typst processes. `fly.toml` asks for a `shared-cpu-1x` machine with **1 GB** (Fly's default is 256 MB); change that value together with the percentage.
- **Testing**:
  - Backend: JUnit 5, Testcontainers `postgres:18-alpine`, Ktor `testApplication`, WireMock / MockEngine. Tests use a fake typst; `RealTypstPdfTest` runs the real tool and is skipped when typst is not installed (CI installs it and sets `REQUIRE_TYPST=1`, which turns a missing typst into a failure).
  - E2E: Playwright against the live stack (Ktor on :8080, Vite dev server on :5173 proxying `/api`).
- **Legacy** (being retired, not built by CI): Next.js + Prisma app in `src/`, `prisma/`, `test/`, and the scripts under `scripts/` that use it.

## jOOQ code generation

Generated classes live in `backend/src/generated/jooq` and are meant to be committed, so builds, tests and Docker/Fly builds never need a database.

```bash
./gradlew :backend:generateJooq   # starts postgres:18-alpine via Testcontainers, runs Flyway, generates Kotlin
```

Run it after every migration change and commit the result. CI job "jOOQ codegen drift check" regenerates the sources and fails the PR when they differ from what is committed (modified, added or deleted files); it uploads the fresh output as the `jooq-generated-sources` artifact.

To check for drift locally (needs Docker; empty output means in sync):

```bash
./gradlew :backend:generateJooq && git status --short backend/src/generated/jooq
```

If two branches change the schema, never merge the generated files by hand: resolve the migrations, then regenerate.

Schema changes go into new Flyway migrations (`backend/src/main/resources/db/migration/V<n>__*.sql`). Nothing alters the schema at runtime.

**Until the first release the baseline `V1__initial_schema.sql` could still be edited** (no production database exists). That was last done on 2026-10-08: the former `V2` defaults were folded into `V1`, a report's date became a real `DATE`, `weather` became nullable, and the legal-record foreign keys became `ON DELETE RESTRICT`. From now on every schema change is a new migration (`V2`, `V3`, …); the rule "a released migration never changes" starts with the first release tag.

After pulling a change that edited `V1`, a local database that already applied the old `V1`/`V2` fails Flyway's validation. Recreate it (the data is test data):

```bash
docker compose down -v && docker compose up -d   # then start the backend again
```

## Runtime configuration (backend)

| Variable                             | Default                                                                  | Notes                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `JDBC_URL`, `DB_USER`, `DB_PASSWORD` | `jdbc:postgresql://localhost:5432/stavebni_denik`, `denik`, `denik_dev`  |                                                                                                                                                  |
| `APP_ENV`                            | development                                                              | `production` makes `JWT_SECRET` mandatory and cookies `Secure`                                                                                   |
| `JWT_SECRET`                         | random per process (dev only)                                            | required in production                                                                                                                           |
| `ALLOW_UNRELEASED_BUILD`             | unset                                                                    | `true` is required to start with `APP_ENV=production` until the release gate is passed (staging with test data only)                             |
| `UPLOADS_DIR`                        | `./uploads`                                                              | photos in `<dir>/photos` (mount a volume in production)                                                                                          |
| `STATIC_DIR`                         | unset (SPA not served)                                                   | directory of the built SPA; the Docker image sets `/app/static`; Ktor then serves the SPA from the same origin                                   |
| `CORS_ALLOWED_ORIGINS`               | none (CORS off)                                                          | comma separated; the SPA is same-origin                                                                                                          |
| `PWNED_PASSWORDS_URL`                | on in production (`https://api.pwnedpasswords.com/range`), off elsewhere | range endpoint of the Pwned Passwords service; `off` disables the breached-password check                                                        |
| `ENTRY_DATE_WINDOW`                  | on                                                                       | `off` disables the late-entry rule below (a data import, a demo); on by default                                                                  |
| `CLIENT_IP_HEADER`                   | unset (TCP peer address)                                                 | name of the header a trusted reverse proxy sets to the client address (`Fly-Client-IP` on Fly); only set it when every request passes that proxy |
| `OPEN_METEO_BASE_URL`                | Open-Meteo                                                               | weather snapshot                                                                                                                                 |

## Sessions

Login creates a server-side session (table `sessions`, valid for 12 hours) and sets an HttpOnly cookie with a JWT that only _names_ the session and the user. Every request looks the session up and loads the user's current role and flags from the database. So:

- logging out, deactivating or deleting a user, or changing a user's role or admin flag ends their sessions at once (the user has to log in again);
- rights claimed inside a token are ignored, and a token whose session is revoked, expired or unknown is refused with `401`, even with a valid signature;
- the application always keeps at least one active administrator: demoting, deactivating or deleting the last one answers `409`.

## Passwords and login limits

- **Policy** (`PasswordPolicy`): 12 to 256 characters with a lower-case letter, an upper-case letter, a digit and a special character. The change-password form shows the same checklist; the server enforces it.
- **Temporary passwords:** an account made by an administrator, and an account whose password an administrator reset, has `mustChangePwd`. Such a session may only call `POST /api/auth/change-password`; everything else answers `403` with `code: PASSWORD_CHANGE_REQUIRED` (the SPA then shows the change form). This is decided from the database on every request, so whoever handed out the password cannot go on acting as that user. **A generated password expires after 7 days** (`users.passwordExpiresAt`, set by account creation, administrator reset and both command-line commands, cleared when the user chooses a password): a correct but expired password is refused at login with `401` and `code: PASSWORD_EXPIRED` (only someone who knows the password sees it), no session is opened, and an administrator issues a new one. A wrong password gets the ordinary answer, expired or not.
- **Change:** needs the current password; wrong answers are limited to 5 per 15 minutes per user; all the user's other sessions end. **Reset** (administrators, `Action.UserPasswordReset`): new generated password shown once (`Cache-Control: no-store`), every session of the user ends, a login lockout of the account is lifted. Neither password nor hash is written to the audit log.
- **Login limits** (table `rate_limit_attempts`, failures only): 30 failures per client address and 20 per account name within 15 minutes, then `429` with `Retry-After`. An attempt is **reserved before the password is checked** (under a database lock per key) and **given back only when it succeeds**, so any number of requests that arrive at the same moment cannot all slip under the limit, a refused request is not recorded (asking again does not extend the wait), and a success removes only its own attempt, not the failures of others. A client on IPv6 is counted as its **/64 prefix** (an IPv4-mapped address as the IPv4 address): rotating the last 64 bits gains nothing. The address comes from `CLIENT_IP_HEADER` when it is configured, otherwise from the TCP peer; `X-Forwarded-For` and the request body are never trusted. A known name can therefore be locked for up to 15 minutes by someone else; an administrator reset lifts it.
- **Breached passwords:** a new password is checked against the Pwned Passwords range API (`BreachedPasswordService`) and refused when it appears in a known breach. Only the first five hex characters of its SHA-1 leave the server (k-anonymity, with padding); the password is never sent. It fails open: if the service is unreachable, slow (2 s limit) or answers nonsense, the password is accepted and a warning is logged. Passwords generated by the application are not checked.
- `users.passwordChangedAt` records when the user last _chose_ a password; a temporary password (new account, administrator or command-line reset) clears it.
- **A login cannot outlive a reset.** The password is checked outside a transaction, so a reset (which ends all sessions) could land before the session is inserted. The session is therefore opened in a transaction that locks the user row and compares the stored password hash with the one that was checked: if it changed, no session is opened and the answer is the ordinary `401`. Changing one's own password does the same: it is refused with `409` when the password was reset or changed after it was checked, instead of overwriting the newer one. A request that was already running when a reset happened still finishes (the session is looked up once per request); that window is milliseconds and the reset ends everything after it.
- Unknown, deactivated and deleted accounts take the same time as a wrong password and get the same answer. Argon2 runs off the request threads, at most 4 at a time.

## Request and upload limits

- Every request body is capped before it is read: **256 KiB** for JSON, **6 MiB** for `POST /api/photos/upload`. Larger requests are answered with `413`.
- An upload carries **one** image of at most **5 MiB**, at most 8 multipart parts, and text fields of at most 256 characters (`400` otherwise). Ktor's `formFieldLimit` applies to every part including the file, so it is set to the request cap and the exact limits are checked in `PhotoRoutes`.
- The image type is checked by its magic bytes. Its dimensions are read from the **header** and checked **before** any pixel is decoded, so a tiny file that claims billions of pixels cannot exhaust memory: a **JPEG may claim up to 64 megapixels** (a phone photo is 12 to 50), other formats up to 16 megapixels (the JDK decodes them in full), at most 16,000 px per side; more is a `400`. A big JPEG is decoded **already reduced** (the reader skips pixels while decoding), so about 4 megapixels at most are held in memory whatever the size of the original. A damaged image is a `400`. (JDK limits: WebP files pass the magic-byte check but the JDK has no WebP reader, so they end as a `400`; HEIC is not supported.)
- Accepted images are decoded once and stored as new metadata-free JPEGs (fitted into 1920x1080, never scaled up) plus a 400x300 thumbnail. **The camera's orientation (EXIF) is applied before the metadata is thrown away**, so a portrait photo is not stored on its side; a damaged EXIF block never rejects a photo. The stored width and height are those of the file on disk. Image work runs off the request threads, **two images at a time**; the engine drops a connection that sends nothing for 60 seconds (`requestReadTimeoutSeconds`), and the file is read on the IO dispatcher, not on a request thread.
- A photo belongs to **the entry the request names**: `reportId` is required (no "newest entry of the project" guess), and a bare date needs `projectId` (dates repeat across projects). The form offers photo upload only for a saved, unsigned entry. Errors never repeat what the database or a library said. A stored photo is served with `Cache-Control: private, no-cache`, so a logout or a lost membership takes effect.
- The database stores **relative keys** (`photos/<uuid>_orig.jpg`, `photos/<uuid>_thumb.jpg`), never absolute paths, and the API never returns a path. A key is only followed when it has exactly that shape and resolves inside `UPLOADS_DIR`; otherwise the photo answers `404`. If the database write fails, the two files already written are removed.

## API overview (all under `/api`, JWT cookie auth unless noted)

- `GET /health` (public)
- Auth: `POST /auth/login`, `POST /auth/logout`, `POST /auth/change-password`
- Users (admin): `GET/POST /users`, `PATCH/DELETE /users/{id}`, `POST /users/{id}/activate|deactivate`, `POST /users/{id}/reset-password`; `GET /users/options` (project managers)
- Projects: `GET/POST /projects`, `GET /projects/{id}`
  - Members: `GET/POST /projects/{id}/members`, `DELETE /projects/{id}/members/{userId}`
  - Authorized persons: `GET/POST /projects/{id}/authorized-persons`, `POST /authorized-persons/{id}/revoke`
  - Site handovers: `GET/POST /projects/{id}/handovers`, `GET/PUT/DELETE /handovers/{id}`, `POST /handovers/{id}/sign`
  - Reports: `GET/POST /projects/{id}/reports`, `GET/POST /projects/{id}/reports/{idOrDate}`, `POST …/sign`, `POST …/acknowledge`, `GET /reports/{id}/pdf`
    - `POST /projects/{id}/reports` only creates (201, or 409 when the day has an entry); `POST …/reports/{date}` saves: it creates the entry or changes only the fields the request mentions. A bad or missing body is a 4xx and changes nothing.
    - **Two people editing one entry:** every entry carries `updatedAt`. A save that sends it back as `expectedUpdatedAt` is a compare-and-set on the locked row: if somebody else saved in between it is refused with `409` and `code: STALE_VERSION` (the SPA then offers to load the other version) and nothing is overwritten. A save without it is last-one-wins. The SPA always sends it for an existing entry, and for a day that looked empty when the form loaded it sends `expectNew: true`: if somebody created the entry in the meantime, the save is refused with the same `STALE_VERSION` instead of replacing it. `POST …/sign` accepts the same `expectedUpdatedAt` in its body: a signature covers a version, and a signer who names the one they saw is refused (`STALE_VERSION`) when the stored one is different. The form only offers "Podepsat a uzamknout" for a saved entry without unsaved changes (so a signature never covers words that were not saved), and is read-only once the entry is signed.
    - **Workers:** an entry holds a list of `{trade, count}`, at most 50 trades, each with a name and a whole head count from 0 to 100,000. Nothing is defaulted (a trade without a count used to become 1, which invented data in a legal record) and a malformed list is a `400`; the form has one row per trade.
- Photos: `POST /photos/upload`, `GET /photos/{id}`, `GET /photos/{id}/thumb`
- Audit log (admin): `GET /audit?limit=200`

### Roles: what a person may do follows their role in the project

A person has **two kinds of role**, and they do different things:

- the **role in a project** (`project_members.role`: BOSS = stavbyvedoucí / project manager, WORKER, INSPECTOR, INVESTOR) decides **everything they may do inside that project**: the same person can be the manager of one project and an ordinary worker in another. It is passed to every permission decision (`Resource.role`) and read from the database inside the transaction, so a changed role applies to the very next request. The API shows it as `myRole` on a project (null for an administrator who is not a member), and the SPA offers actions by it;
- the **global role** of the account (`users.role`) is the role a person usually has: it is the default offered when adding them to a project, and it decides **who may create a project** (global BOSS, because the creator becomes the project's manager). It gives no right inside a project.
- the **administrator flag** is independent of both: it opens user administration and the audit log, lets the person read every project, and is the audited way in (below). It gives no write right in a project.

What each project role may do (the matrix is pinned by `RbacTest`):

|                                       | BOSS                       | WORKER | INSPECTOR | INVESTOR |
| ------------------------------------- | -------------------------- | ------ | --------- | -------- |
| write a report / add a photo          | yes                        | yes    | no        | no       |
| correct a report                      | any                        | own    | no        | no       |
| sign a report                         | yes                        | no     | no        | no       |
| delete a photo                        | yes                        | no     | no        | no       |
| acknowledge a signed report           | no                         | no     | yes       | yes      |
| sign a site handover protocol         | yes                        | yes    | yes       | yes      |
| manage members and authorized persons | yes (and an administrator) | no     | no        | no       |

**Members.** Only the project's manager, or an application administrator as the audited way in (decision D1), may add a member or change a role. Nobody changes their own role (an administrator who joined as a worker cannot promote themselves afterwards). The project's **site manager** (`projects.siteManagerId`) can be neither removed nor given another role, and a project is never left without a manager. The role of a membership has **no database default** (migration V7): a forgotten column must not make someone a manager who may sign the diary.

Project-scoped endpoints require project membership. App admins can **read** every project, but being an admin gives no right to write: creating, overwriting, signing or acknowledging a report, uploading or removing a photo, and creating, changing, deleting or signing a site handover protocol all require real membership of that project. The membership is judged inside the transaction, on rows locked `FOR UPDATE`, never assumed. **Joining a project as an administrator is the audited way in** (decision D1): a project manager of the project, or an administrator, may add members (an administrator adds themselves), and the audit row names the project, the user and the role before and after. An administrator cannot change their own role (they could otherwise make themselves a project manager and then a member of any project); changing someone's role or administrator flag ends their sessions and is audited with before and after, and fixing a display name does not log anyone out.

**Signed records are immutable in the database too** (migration V5, triggers that compare the whole row): a signed daily report cannot be changed or deleted (only the acknowledgement can still be added), photos cannot be added to, changed on or removed from a signed report, and a signed handover protocol cannot be changed or deleted. The application checks all of this first; a photo whose processing was still running when the report was signed is refused at insert time, not given to the signed record. The audit rows of photos, handovers, authorised persons and members carry the entity id and before/after snapshots (a photo's row holds the SHA-256 of both stored files).

### Daily reports: signing and acknowledging

- `POST /projects/{id}/reports/{idOrDate}/sign` (and `POST /reports/{reportId}/sign`) signs and locks a report. Only a member whose role **in that project** is BOSS may sign (a global BOSS who is only a worker here may not). A report is signed **exactly once**: a second request answers `409` and changes nothing (signer and time stay). A non-member gets `403`.
- `POST …/acknowledge` records that an inspector or investor (a member) has taken note of the report. It only works on a **signed** report and only once; otherwise `409`.
- `GET/POST /reports/{reportId}/…` take a report id only; a bare date is `400` (a date is only unique within a project, so use the project-scoped route). A report id of another project is `404` through `/projects/{id}/reports/{reportId}`.
- Every report change is written to the audit log in the same transaction, with the real report id and a before/after snapshot (`report.create`, `report.update`, `report.lock`, `report.acknowledge`).

## Entry dates and late entries

A new daily entry is **on time** for today and for any day since the previous working day (Monday to Friday; public holidays are not considered): on a Monday that is Friday, Saturday, Sunday and Monday. An entry for an **earlier** day is a **late entry**: it needs a reason (at most 1,000 characters), is flagged (`isLateEntry`, `lateEntryReason`) and the flag and reason are part of the record, the audit snapshot and the PDF (`Pozdní zápis:`). An entry for a day in the **future** is refused. "Today" is the date in Prague (decision D10). Only a _new_ entry is checked: correcting an existing one is not a new entry, and the reason of a late entry stays. A flagged entry without a reason cannot exist in the database either (check constraint, migration V3). The form asks for the reason when it opens a day before the previous working day, and does not offer a date in the future.

## Weather

The weather of a day is **entered by hand** (decision D12): a free-text condition (the form suggests common ones), the lowest and the highest temperature. Everything is optional; an entry with no value is stored as no weather, and sending an empty `weather` object on a save clears it, while leaving `weather` out keeps what is stored. Temperatures must lie between -60 and 60 °C and the lowest cannot exceed the highest; the text is at most 200 characters. The PDF shows it as readable text (`zataženo, 8,5 až 15 °C`, or `Neuvedeno`), and the audit snapshot keeps that same text, because snapshots hold no decimals (a number's textual form could change on the way through `jsonb` and break the hash chain). **Not done:** filling the weather in automatically from Open-Meteo; its free API is non-commercial, so that needs a commercial key first. `WeatherService` still exists for that purpose but nothing calls it.

## Cross-site requests

The session cookie is `SameSite=Lax`. In addition, `CrossSiteRequestGuard` refuses every state-changing request (anything but GET, HEAD, OPTIONS) under `/api/` that a browser makes on behalf of another site, with `403`:

1. an `Origin` listed in `CORS_ALLOWED_ORIGINS` is accepted;
2. otherwise `Sec-Fetch-Site` decides: `same-origin` and `none` pass, `same-site` and `cross-site` are refused;
3. browsers without that header send `Origin` on every POST: its host has to equal the `Host` the request was sent to;
4. with neither header (scripts, curl, tests) the request passes: only a browser can be tricked into a cross-site request.

Behind the Vite dev proxy the page and the API are the same origin for the browser (`Sec-Fetch-Site: same-origin`), so nothing needs configuring.

## Code layout

- `backend/src/main/kotlin/cz/stavebni/denik/` — application (config, db, domain, plugins, routes, services, util)
- `backend/src/codegen/java/` — jOOQ code generator runner
- `backend/src/generated/jooq/` — generated jOOQ sources (committed)
- `backend/src/test/kotlin/cz/stavebni/denik/` — integration tests
- `frontend/src/` — React SPA (`lib/api.ts` is the API client)
- `e2e/` — Playwright specs; `scripts/dev/e2e-prepare.ts` seeds E2E users
- `.github/workflows/ci.yml` — lint/build, integration (with real typst), jOOQ drift check, Docker image build + boot test (release gate, security headers, non-root user, volume ownership), E2E
- `.github/dependabot.yml` — weekly update pull requests for `frontend/` (npm/pnpm), the Gradle build (root and `backend/`), GitHub Actions and the Docker base images; the legacy root npm tree is switched off. Versions kept in plain `val xVersion = "…"` lines of the Kotlin build scripts may not be seen by Dependabot (a version catalog would fix that).

## Audit log

Every change goes through `AuditService`: the audit row and the business change share one transaction, appenders are serialised by an advisory lock, and each row carries the hash of the previous one (a chain). The database refuses `UPDATE`, `DELETE` (migration V1) and `TRUNCATE` (V2) on `audit_log` with triggers. Those triggers stop mistakes and an application that holds ordinary privileges; **whoever owns the table can still switch them off**, and a log that was cut short, or emptied, is still a valid chain. So the newest row has to be **recorded outside the database**, and checked against:

```bash
fly ssh console -C "java -cp /app/app.jar cz.stavebni.denik.cli.AdminCliKt audit-head"          # prints <id>:<hash>; store it somewhere the database owner cannot reach
fly ssh console -C "java -cp /app/app.jar cz.stavebni.denik.cli.AdminCliKt audit-verify 1234:ab12…"   # chain + that row 1234 still exists unchanged
```

`audit-verify` exits `0` when the chain is intact (and the anchor, if given, is found unchanged) and `1` when it is not, printing the reason; `3` means the check **could not run** (database unreachable, schema missing): that is neither "intact" nor "broken", and an unattended check must treat it as a failure. Both audit commands only read: they **do not migrate** the schema, so a read-only database role is enough and a scheduler cannot change a database that another version of the application owns. Without an anchor the check cannot see a cut tail. The same check is available to administrators as `GET /api/audit/verify` and `GET /api/audit/verify?anchor=<id>:<hash>`, which also returns the current `head`. An anchor stays valid while the log grows. **Not automated yet:** the scheduled job that _records_ the head (a private repository, an RFC 3161 timestamp, the PDF footer: decision D4). The nightly workflow `audit-verify.yml` runs the Kotlin command above (secrets `AUDIT_JDBC_URL`, `AUDIT_DB_USER`, `AUDIT_DB_PASSWORD`, optional variable `AUDIT_ANCHOR`); **it fails while it is not configured**, so that nobody believes the log is watched when it is not (disable the workflow until a production database exists). The database must be reachable from GitHub's runners; otherwise run the same command where the database is. Separate database roles for migrations and for the application (decision D5) are also open; V1 and V2 already revoke `UPDATE`, `DELETE` and `TRUNCATE` from a role named `app` when it exists.

## First administrator and password recovery

A fresh database has no users, so nobody can log in. Two operator commands run against the database from inside the application image (same `JDBC_URL`, `DB_USER`, `DB_PASSWORD` as the application; they migrate the schema if needed):

```bash
# first administrator (refused as soon as an active administrator exists)
fly ssh console -C "java -cp /app/app.jar cz.stavebni.denik.cli.AdminCliKt create-admin alice 'Alice Novakova'"

# the only administrator is locked out or forgot the password: new temporary password, all sessions end, a login lockout is lifted
fly ssh console -C "java -cp /app/app.jar cz.stavebni.denik.cli.AdminCliKt reset-password alice"
```

Both print a generated password once, to standard output only (framework logging is reduced to warnings and errors, which share the terminal); it is stored only as an Argon2id hash, the account has to change it at the first login, and the audit log records the action without an acting user and without the password. `create-admin` makes the account a project manager (BOSS) with the administrator flag; further users are created in the application. Exit codes: `0` done, `1` refused (for example an administrator already exists), `2` wrong usage. Locally: `java -cp backend/build/libs/backend-all.jar cz.stavebni.denik.cli.AdminCliKt …` after `./gradlew :backend:shadowJar`.

## Release gate

This build is **not released for real diary data**. While that is true, the app refuses to start with `APP_ENV=production` unless `ALLOW_UNRELEASED_BUILD=true` is set (staging with test data only). The pull request that completes the list below removes that guard.

Before the first release:

- **Sessions:** ~~server-side revocation, password change and reset, login rate limiting, breached-password check, Origin / Sec-Fetch-Site check~~ done.
- **Authorization:** project membership decided in one place; app admins do not get member rights implicitly.
- **Signed reports:** cannot be signed twice or changed afterwards (also enforced in the database); corrections go through addenda.
- **Audit log:** records what changed (entity ids, before/after); ~~cannot be truncated~~ done (V2 trigger); the check against an anchor recorded outside the database exists (see "Audit log"). Still open: the scheduled job that records the head and runs the check (the nightly verifier still runs against the legacy schema), separate database roles.
- **PDF export:** user text cannot inject typst code; timeouts; no blank-PDF fallback; required content.
- **Uploads and requests:** size and dimension limits are checked before decoding.
- **Legal model:** follows zákon 283/2021 Sb. § 166 and vyhláška 131/2024 Sb. (§ 10, příloha 12), confirmed with a lawyer.
- **Operations:** separate database roles for migrations and runtime, backups with a tested restore, ~~a way to create the first admin~~ done (see above), GDPR paperwork.

## Follow-ups

- `RemarkService`, `VisitService` and `MaterialService` have **no routes and no UI** (only their tests use them). They follow the project role now, but they do not write audit rows or take the in-transaction locks the other services do. Before any route is added they must go through `AuditService.auditedWrite`; or delete them if the legal model (příloha 12) does not need them.
- Only users with a ČKAIT number should be able to hold the BOSS role of a project (decision D2); today any member can be made BOSS by a project manager or an administrator, audited.
- Retire the legacy Next.js/Prisma tree (`src/`, `prisma/`, `test/`, root `package.json`): first replace the E2E seed (`scripts/dev/e2e-prepare.ts`), which still depends on it; `scripts/verify-audit.ts` is then dead too.
- Update the docs that still describe the old stack (`README.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/DEPLOYMENT.md`, the CI gates in `AGENTS.md`).
