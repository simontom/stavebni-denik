# Project: Stavební Deník — Backend Integration & Frontend E2E Tests

## Architecture

- **Backend**: Kotlin 2.1.10, Ktor 3.1.1, jOOQ, Flyway, PostgreSQL 17, Argon2id, JWT auth.
- **Frontend**: Vite 8, React 19, React Router 7, Tailwind CSS 4.
- **Testing**:
  - Backend: JUnit 5 (Jupiter), Testcontainers (PostgreSQL 17-alpine), Ktor `testApplication`, WireMock / MockEngine.
  - Frontend E2E: Playwright, running against live local stack (Ktor backend on 8080 + Vite frontend dev server on 5173/3000 with `/api` proxy).

## Feature Inventory

| #   | Feature                         | Description                                                                                                               | Milestone | Source              |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------- |
| 1   | Gradle JUnit 5 Runner           | Add `useJUnitPlatform()` in `backend/build.gradle.kts` so `./gradlew test` discovers tests                                | M1        | Survey 1            |
| 2   | Backend Runtime Fixes           | Fix `uuidv7()` -> `gen_random_uuid()`, auth `SessionUser` principal, StatusPages 401/403, CORS, DatabaseFactory guard     | M1        | Survey 1, 3         |
| 3   | Image Airlock Validation        | Fix `PhotoService.kt` to enforce 5MB cap, magic byte validation, and sharp/Thumbnailator re-encoding per docs/SECURITY.md | M1        | Survey 3            |
| 4   | External API Mocking            | WireMock / Ktor MockEngine for `WeatherService` (OpenMeteo) and process mock for `PdfExportService` (typst)               | M1        | Survey 1            |
| 5   | Testcontainers Base Harness     | Create `BaseIntegrationTest` with PostgreSQLContainer("postgres:17-alpine") and table cleanup                             | M1        | Survey 1            |
| 6   | Service Integration Tests       | JUnit 5 integration tests for all 17 backend services with real database queries                                          | M1        | Survey 1            |
| 7   | Ktor Route Integration Tests    | Ktor `testApplication` tests for Auth, Projects, Reports, PDF, and Health endpoints                                       | M1        | Survey 1            |
| 8   | Frontend Build & Proxy          | Fix TS6133 in `ProjectDetail.tsx`, configure Vite `/api` proxy to `http://localhost:8080`                                 | M2        | Survey 2, 3         |
| 9   | Frontend Route & Shell Mounting | Mount all pages in `frontend/src/main.tsx` with `<nav aria-label="Hlavní">` application shell                             | M2        | Survey 2            |
| 10  | Frontend / E2E Alignment        | Align Czech strings, UUID regexes, and data-testids in React UI and Playwright specs                                      | M2        | Survey 2            |
| 11  | E2E Database Seeding            | Update `e2e/global-setup.ts` / `e2e-prepare.ts` to seed valid UUID users into PostgreSQL                                  | M2        | Survey 3            |
| 12  | Playwright E2E Suite Execution  | Update `playwright.config.ts` and E2E specs so all 13+ tests pass against the live stack                                  | M2        | Survey 2, 3         |
| 13  | CI Gate & PR Verification       | Fix `.github/workflows/ci.yml`, verify all CI gates pass, create PR against `main`                                        | M3        | Survey 3, AGENTS.md |

## Milestones

| #   | Name                                                | Scope                                                                                                        | Dependencies | Status |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------ | ------ |
| M1  | Backend Integration Tests & Runtime Fixes           | Fix backend bugs, photo airlock, gradle test runner, implement Testcontainers suite for services & routes    | none         | DONE   |
| M2  | Frontend Routing, Vite Proxy & Playwright E2E Tests | Fix frontend TS, wire routes/nav shell, seed DB with UUIDs, update Playwright tests to pass against live app | M1           | DONE   |
| M3  | Full Stack Verification, Security Audit & PR        | Run all CI gates (gradlew test, typecheck, lint, build, playwright), Forensic Audit, create PR               | M1, M2       | DONE   |

## Interface Contracts

### Frontend ↔ Backend

- **Base URL**: `/api` (proxied by Vite to `http://localhost:8080`)
- **Health**: `GET /api/health` -> `{"status":"ok"}`
- **Auth**:
  - `POST /api/auth/login` -> `{"email":"...","password":"..."}` returns cookie `token` or bearer token.
  - `POST /api/auth/logout` -> clears session.
- **Projects**:
  - `GET /api/projects` -> `[{"id":"<UUID>", "name":"...", "status":"...", ...}]`
  - `POST /api/projects` -> `{"name":"...", ...}` -> `{"id":"<UUID>", ...}`
- **Reports**:
  - `GET /api/projects/{projectId}/reports` -> list of reports
  - `POST /api/projects/{projectId}/reports` -> create report
  - `GET /api/reports/{id}/pdf` -> application/pdf

### Test Infrastructure Contracts

- **Backend**: `./gradlew test` (using Java 21) discovers and runs all JUnit 5 unit and integration tests against dynamic Testcontainers PostgreSQL.
- **E2E**: `e2e/global-setup.ts` runs prior to tests and seeds test users (`admin@stavebni-denik.cz`, `manager@stavebni-denik.cz`, etc.) with Argon2id hashes and valid UUIDs in `users` table.
- **Playwright**: `npx playwright test` executes against `http://localhost:5173` (or configured baseURL) with live backend on `http://localhost:8080`.

## Code Layout

- `backend/src/main/kotlin/cz/stavebni/denik/` — Kotlin application source (Application, plugins, routes, services, db, domain)
- `backend/src/test/kotlin/cz/stavebni/denik/` — Kotlin tests (unit tests, integration tests)
- `frontend/src/` — React SPA source (pages, components, main.tsx, api)
- `e2e/` — Playwright test specifications and fixtures
- `scripts/dev/` — Developer and test setup scripts (e2e-prepare.ts)
- `.github/workflows/ci.yml` — GitHub Actions CI pipeline
