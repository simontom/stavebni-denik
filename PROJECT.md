# Project: Stavební deník (construction site diary)

## Architecture (current stack)

- **Backend**: Kotlin 2.1, Ktor 3.1, jOOQ 3.21, Flyway 12, **PostgreSQL 18 only** (schema uses `uuidv7()`), Argon2id passwords, JWT in an HttpOnly cookie.
- **Frontend**: Vite 8, React 19, React Router 7, Tailwind CSS 4 (`frontend/`, its own pnpm workspace + lockfile).
- **Testing**:
  - Backend: JUnit 5, Testcontainers `postgres:18-alpine`, Ktor `testApplication`, WireMock / MockEngine.
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

## Runtime configuration (backend)

| Variable                             | Default                                                                 | Notes                                                          |
| ------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| `JDBC_URL`, `DB_USER`, `DB_PASSWORD` | `jdbc:postgresql://localhost:5432/stavebni_denik`, `denik`, `denik_dev` |                                                                |
| `APP_ENV`                            | development                                                             | `production` makes `JWT_SECRET` mandatory and cookies `Secure` |
| `JWT_SECRET`                         | random per process (dev only)                                           | required in production                                         |
| `UPLOADS_DIR`                        | `./uploads`                                                             | photos in `<dir>/photos` (mount a volume in production)        |
| `CORS_ALLOWED_ORIGINS`               | none (CORS off)                                                         | comma separated; the SPA is same-origin                        |
| `OPEN_METEO_BASE_URL`                | Open-Meteo                                                              | weather snapshot                                               |

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

Project-scoped endpoints require project membership; app admins can open every project.

## Code layout

- `backend/src/main/kotlin/cz/stavebni/denik/` — application (config, db, domain, plugins, routes, services, util)
- `backend/src/codegen/java/` — jOOQ code generator runner
- `backend/src/generated/jooq/` — generated jOOQ sources (committed)
- `backend/src/test/kotlin/cz/stavebni/denik/` — integration tests
- `frontend/src/` — React SPA (`lib/api.ts` is the API client)
- `e2e/` — Playwright specs; `scripts/dev/e2e-prepare.ts` seeds E2E users
- `.github/workflows/ci.yml` — lint/build, integration, jOOQ drift check, E2E

## Follow-ups

See `claude/pr60-fix-plan.md` in the project docs: retire the legacy Next.js/Prisma tree, port the audit-chain verifier to Kotlin, ship the SPA + typst from one Docker image.
