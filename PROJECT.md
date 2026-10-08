# Project: Stavební deník (construction site diary)

## Architecture (current stack)

- **Backend**: Kotlin 2.1, Ktor 3.1, jOOQ 3.21, Flyway 12, **PostgreSQL 18 only** (schema uses `uuidv7()`), Argon2id passwords, JWT in an HttpOnly cookie.
- **Frontend**: Vite 8, React 19, React Router 7, Tailwind CSS 4 (`frontend/`, its own pnpm workspace + lockfile).
- **PDF export** (`GET /api/reports/{id}/pdf`): the `typst` command line tool (installed in the Docker image, pinned by checksum) renders the fixed template `backend/src/main/resources/pdf/report.typ`. User text never becomes part of the template: it travels as JSON data and is shown as plain text, so it cannot be executed as typst code. Each export gets its own temporary directory, a 20 s timeout (the process is killed), and at most two exports run at the same time. Without typst the endpoint answers `503`; it never returns an empty PDF.
- **Docker image** (`Dockerfile`): Ktor + the built SPA + typst on a **glibc** (Ubuntu) Temurin JRE. It must not be Alpine: the password library `argon2-jvm` loads a native library through JNA, and on Alpine (musl libc) the JVM dies with SIGSEGV as soon as a password is hashed (creating a user). The application also hashes and verifies one throwaway password at startup (`PasswordService.ensureWorks`), so such a broken environment fails at deploy time, not at the first account creation.
- **Testing**:
  - Backend: JUnit 5, Testcontainers `postgres:18-alpine`, Ktor `testApplication`, WireMock / MockEngine. Tests use a fake typst; `RealTypstPdfTest` runs the real tool and is skipped when typst is not installed (CI installs it and sets `REQUIRE_TYPST=1`, which turns a missing typst into a failure).
  - E2E: Playwright against the live stack (Ktor on :8080, Vite dev server on :5173 proxying `/api`).
- **Legacy** (being retired, not built by CI): Next.js + Prisma app in `src/`, `prisma/`, `test/` and the nightly `audit-verify.yml` job.

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

| Variable                             | Default                                                                 | Notes                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `JDBC_URL`, `DB_USER`, `DB_PASSWORD` | `jdbc:postgresql://localhost:5432/stavebni_denik`, `denik`, `denik_dev` |                                                                                                                      |
| `APP_ENV`                            | development                                                             | `production` makes `JWT_SECRET` mandatory and cookies `Secure`                                                       |
| `JWT_SECRET`                         | random per process (dev only)                                           | required in production                                                                                               |
| `ALLOW_UNRELEASED_BUILD`             | unset                                                                   | `true` is required to start with `APP_ENV=production` until the release gate is passed (staging with test data only) |
| `UPLOADS_DIR`                        | `./uploads`                                                             | photos in `<dir>/photos` (mount a volume in production)                                                              |
| `CORS_ALLOWED_ORIGINS`               | none (CORS off)                                                         | comma separated; the SPA is same-origin                                                                              |
| `OPEN_METEO_BASE_URL`                | Open-Meteo                                                              | weather snapshot                                                                                                     |

## Sessions

Login creates a server-side session (table `sessions`, valid for 12 hours) and sets an HttpOnly cookie with a JWT that only _names_ the session and the user. Every request looks the session up and loads the user's current role and flags from the database. So:

- logging out, deactivating or deleting a user, or changing a user's role or admin flag ends their sessions at once (the user has to log in again);
- rights claimed inside a token are ignored, and a token whose session is revoked, expired or unknown is refused with `401`, even with a valid signature;
- the application always keeps at least one active administrator: demoting, deactivating or deleting the last one answers `409`.

Not done yet (see the Release gate): password change and reset, login rate limiting, and a cross-site request check.

## Request and upload limits

- Every request body is capped before it is read: **256 KiB** for JSON, **6 MiB** for `POST /api/photos/upload`. Larger requests are answered with `413`.
- An upload carries **one** image of at most **5 MiB**, at most 8 multipart parts, and text fields of at most 256 characters (`400` otherwise). Ktor's `formFieldLimit` applies to every part including the file, so it is set to the request cap and the exact limits are checked in `PhotoRoutes`.
- The image type is checked by its magic bytes (JPEG, PNG, WebP). Its dimensions are read from the **header** and checked (at most 8 megapixels and 12,000 px per side) **before** any pixel is decoded, so a tiny file that claims billions of pixels cannot exhaust memory. A damaged image is a `400`.
- Accepted images are decoded once and stored as new metadata-free JPEGs (fitted into 1920x1080, never scaled up) plus a 400x300 thumbnail. The stored width and height are those of the file on disk.
- The database stores **relative keys** (`photos/<uuid>_orig.jpg`, `photos/<uuid>_thumb.jpg`), never absolute paths, and the API never returns a path. A key is only followed when it has exactly that shape and resolves inside `UPLOADS_DIR`; otherwise the photo answers `404`. If the database write fails, the two files already written are removed.

## API overview (all under `/api`, JWT cookie auth unless noted)

- `GET /health` (public)
- Auth: `POST /auth/login`, `POST /auth/logout`
- Users (admin): `GET/POST /users`, `PATCH/DELETE /users/{id}`, `POST /users/{id}/activate|deactivate`; `GET /users/options` (project managers)
- Projects: `GET/POST /projects`, `GET /projects/{id}`
  - Members: `GET/POST /projects/{id}/members`, `DELETE /projects/{id}/members/{userId}`
  - Authorized persons: `GET/POST /projects/{id}/authorized-persons`, `POST /authorized-persons/{id}/revoke`
  - Site handovers: `GET/POST /projects/{id}/handovers`, `GET/PUT/DELETE /handovers/{id}`, `POST /handovers/{id}/sign`
  - Reports: `GET/POST /projects/{id}/reports`, `GET/POST /projects/{id}/reports/{idOrDate}`, `POST …/sign`, `POST …/acknowledge`, `GET /reports/{id}/pdf`
- Photos: `POST /photos/upload`, `GET /photos/{id}`, `GET /photos/{id}/thumb`
- Audit log (admin): `GET /audit?limit=200`

Project-scoped endpoints require project membership. App admins can **read** every project, but being an admin gives no right to write: creating, overwriting, signing or acknowledging a report requires real membership of that project.

### Daily reports: signing and acknowledging

- `POST /projects/{id}/reports/{idOrDate}/sign` (and `POST /reports/{reportId}/sign`) signs and locks a report. Only a BOSS who is a member of the project may sign. A report is signed **exactly once**: a second request answers `409` and changes nothing (signer and time stay). A non-member gets `403`.
- `POST …/acknowledge` records that an inspector or investor (a member) has taken note of the report. It only works on a **signed** report and only once; otherwise `409`.
- `GET/POST /reports/{reportId}/…` take a report id only; a bare date is `400` (a date is only unique within a project, so use the project-scoped route). A report id of another project is `404` through `/projects/{id}/reports/{reportId}`.
- Every report change is written to the audit log in the same transaction, with the real report id and a before/after snapshot (`report.create`, `report.update`, `report.lock`, `report.acknowledge`).

## Code layout

- `backend/src/main/kotlin/cz/stavebni/denik/` — application (config, db, domain, plugins, routes, services, util)
- `backend/src/codegen/java/` — jOOQ code generator runner
- `backend/src/generated/jooq/` — generated jOOQ sources (committed)
- `backend/src/test/kotlin/cz/stavebni/denik/` — integration tests
- `frontend/src/` — React SPA (`lib/api.ts` is the API client)
- `e2e/` — Playwright specs; `scripts/dev/e2e-prepare.ts` seeds E2E users
- `.github/workflows/ci.yml` — lint/build, integration, jOOQ drift check, E2E

## Release gate

This build is **not released for real diary data**. While that is true, the app refuses to start with `APP_ENV=production` unless `ALLOW_UNRELEASED_BUILD=true` is set (staging with test data only). The pull request that completes the list below removes that guard.

Before the first release:

- **Sessions:** server-side revocation (a deactivated or demoted user loses access at once), password change and reset, login rate limiting.
- **Authorization:** project membership decided in one place; app admins do not get member rights implicitly.
- **Signed reports:** cannot be signed twice or changed afterwards (also enforced in the database); corrections go through addenda.
- **Audit log:** records what changed (entity ids, before/after), cannot be truncated, latest hash anchored outside the database; the nightly verifier runs against the Kotlin schema.
- **PDF export:** user text cannot inject typst code; timeouts; no blank-PDF fallback; required content.
- **Uploads and requests:** size and dimension limits are checked before decoding.
- **Legal model:** follows zákon 283/2021 Sb. § 166 and vyhláška 131/2024 Sb. (§ 10, příloha 12), confirmed with a lawyer.
- **Operations:** separate database roles for migrations and runtime, backups with a tested restore, a way to create the first admin, GDPR paperwork.

## Follow-ups

- Retire the legacy Next.js/Prisma tree (`src/`, `prisma/`, `test/`, root `package.json`): first replace the E2E seed and the nightly `audit-verify` workflow, which still depend on it.
- Port the audit-chain verifier to Kotlin and retire the Prisma-based nightly job.
- Commit `frontend/pnpm-lock.yaml` and use frozen installs everywhere.
- Update the docs that still describe the old stack (`README.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/DEPLOYMENT.md`, the CI gates in `AGENTS.md`).
