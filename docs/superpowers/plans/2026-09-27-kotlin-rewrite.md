# Stavební deník Kotlin Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the Czech electronic construction diary from TypeScript/Next.js to Kotlin/Ktor with 100% feature parity, Typst PDF export, and deployment to Fly.io 1GB.

**Architecture:** Ktor 3.x backend serving a React 19 + Vite SPA from the same container. PostgreSQL 18 with jOOQ for type-safe queries, Flyway for migrations, UUID v7 for IDs. Typst CLI for PDF generation. JWT in HttpOnly cookies for auth.

**Tech Stack:** Kotlin 2.1, Ktor 3.x, jOOQ 3.19, Flyway 10, PostgreSQL 18, Typst CLI 0.12, React 19, Vite, Tailwind CSS, shadcn/ui

**Spec:** `C:\Users\nanuk\.gemini\antigravity\brain\c0bb3e0e-0589-4885-a7be-b64a673f920c\design-spec.md`

## Global Constraints

- Kotlin 2.1+, Java 21 (Temurin)
- All IDs are PostgreSQL `UUID DEFAULT uuidv7()` (PG 18 native)
- All timestamps are `TIMESTAMPTZ` stored as `Instant` in Kotlin
- Czech language throughout (UI labels, error messages, comments in English)
- `kotlinx.serialization` for all JSON (no Jackson)
- Every DB mutation must go through `auditedTransaction()` HOF
- RBAC via explicit `can(user, action, resource)` — no annotations
- Git: never push to `main`, always PR via `feat/kotlin-rewrite`
- TDD: write failing test first, then implement

---

## Phase 1: Project Scaffolding & Database

### Task 1.1: Gradle Project Setup (Backend)

**Files:**

- Create: `backend/build.gradle.kts`
- Create: `backend/settings.gradle.kts`
- Create: `backend/src/main/kotlin/cz/stavebni/denik/Application.kt`
- Create: `backend/src/main/resources/application.yaml`
- Create: `backend/gradle.properties`
- Create: `settings.gradle.kts` (root)
- Create: `build.gradle.kts` (root)

**Interfaces:**

- Produces: Working Gradle project that compiles and starts Ktor on port 8080 with a health endpoint `GET /api/health` returning `{"status":"ok"}`

- [ ] **Step 1: Create root Gradle wrapper and settings**

```kotlin
// settings.gradle.kts (root)
rootProject.name = "stavebni-denik"
include("backend")
```

```kotlin
// build.gradle.kts (root)
plugins {
    kotlin("jvm") version "2.1.10" apply false
    kotlin("plugin.serialization") version "2.1.10" apply false
}
```

- [ ] **Step 2: Create backend/build.gradle.kts with all dependencies**

```kotlin
// backend/build.gradle.kts
plugins {
    kotlin("jvm") version "2.1.10"
    kotlin("plugin.serialization") version "2.1.10"
    id("io.ktor.plugin") version "3.1.1"
    id("org.jooq.jooq-codegen-gradle") version "3.19.16"
    id("org.flywaydb.flyway") version "10.22.0"
    application
}

application {
    mainClass.set("cz.stavebni.denik.ApplicationKt")
}

val ktorVersion = "3.1.1"
val jooqVersion = "3.19.16"

dependencies {
    // Ktor server
    implementation("io.ktor:ktor-server-core:$ktorVersion")
    implementation("io.ktor:ktor-server-netty:$ktorVersion")
    implementation("io.ktor:ktor-server-content-negotiation:$ktorVersion")
    implementation("io.ktor:ktor-serialization-kotlinx-json:$ktorVersion")
    implementation("io.ktor:ktor-server-cors:$ktorVersion")
    implementation("io.ktor:ktor-server-auth:$ktorVersion")
    implementation("io.ktor:ktor-server-auth-jwt:$ktorVersion")
    implementation("io.ktor:ktor-server-status-pages:$ktorVersion")
    implementation("io.ktor:ktor-server-rate-limit:$ktorVersion")
    implementation("io.ktor:ktor-server-sessions:$ktorVersion")

    // Ktor client (for weather API)
    implementation("io.ktor:ktor-client-core:$ktorVersion")
    implementation("io.ktor:ktor-client-cio:$ktorVersion")
    implementation("io.ktor:ktor-client-content-negotiation:$ktorVersion")

    // Database
    implementation("org.jooq:jooq:$jooqVersion")
    implementation("org.jooq:jooq-kotlin:$jooqVersion")
    implementation("org.jooq:jooq-kotlin-coroutines:$jooqVersion")
    implementation("org.postgresql:postgresql:42.7.4")
    implementation("com.zaxxer:HikariCP:6.2.1")
    implementation("org.flywaydb:flyway-core:10.22.0")
    implementation("org.flywaydb:flyway-database-postgresql:10.22.0")

    // Auth
    implementation("com.auth0:java-jwt:4.4.0")
    implementation("de.mkammerer:argon2-jvm:2.11")

    // Serialization
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    // Validation
    implementation("io.konform:konform:0.7.0")

    // Image processing
    implementation("net.coobird:thumbnailator:0.4.20")

    // Logging
    implementation("ch.qos.logback:logback-classic:1.5.12")

    // Testing
    testImplementation("io.ktor:ktor-server-test-host:$ktorVersion")
    testImplementation("org.jetbrains.kotlin:kotlin-test:2.1.10")
    testImplementation("io.ktor:ktor-client-content-negotiation:$ktorVersion")
    testImplementation("org.testcontainers:testcontainers:1.20.4")
    testImplementation("org.testcontainers:postgresql:1.20.4")
    testImplementation("org.testcontainers:junit-jupiter:1.20.4")
}

kotlin {
    jvmToolchain(21)
}

tasks.test {
    useJUnitPlatform()
}
```

- [ ] **Step 3: Create minimal Application.kt with health endpoint**

```kotlin
// backend/src/main/kotlin/cz/stavebni/denik/Application.kt
package cz.stavebni.denik

import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.netty.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.serialization.json.Json

fun main(args: Array<String>) = EngineMain.main(args)

fun Application.module() {
    install(ContentNegotiation) {
        json(Json { ignoreUnknownKeys = true })
    }

    routing {
        get("/api/health") {
            call.respond(mapOf("status" to "ok"))
        }
    }
}
```

- [ ] **Step 4: Create application.yaml**

```yaml
# backend/src/main/resources/application.yaml
ktor:
  deployment:
    port: 8080
  application:
    modules:
      - cz.stavebni.denik.ApplicationKt.module
```

- [ ] **Step 5: Verify it compiles**

Run: `cd backend && ../gradlew compileKotlin`
Expected: BUILD SUCCESSFUL

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "feat: initialize Kotlin/Ktor backend project with Gradle"
```

---

### Task 1.2: Flyway Migration — Baseline Schema

**Files:**

- Create: `backend/src/main/resources/db/migration/V1__initial_schema.sql`

**Interfaces:**

- Consumes: Prisma migration SQL from `prisma/migrations/20260926000000_init/migration.sql`
- Produces: Complete PostgreSQL 18 schema with UUID v7 columns, enums, triggers, indexes

- [ ] **Step 1: Read current Prisma migration and convert to Flyway baseline**

Key conversions from Prisma SQL:

- All `TEXT` primary key columns → `UUID DEFAULT uuidv7()`
- All `TEXT` foreign key columns → `UUID`
- Add `set_updated_at()` trigger function
- Add `prevent_audit_mutation()` trigger function
- Keep all `ON DELETE CASCADE` constraints
- Keep all PostgreSQL ENUMs (`Role`, `RemarkType`)
- Add `password_changed_at TIMESTAMPTZ` to users table

- [ ] **Step 2: Write complete V1__initial_schema.sql**

(Full SQL file derived from Prisma migration — must contain ALL tables, enums, triggers, indexes, constraints)

- [ ] **Step 3: Commit**

```bash
git add backend/src/main/resources/db/migration/V1__initial_schema.sql
git commit -m "feat: add Flyway V1 baseline schema (from Prisma, UUID v7)"
```

---

### Task 1.3: Database Connection & jOOQ Code Generation

**Files:**

- Modify: `backend/build.gradle.kts` (add jOOQ codegen config)
- Create: `docker-compose.yml` (dev PostgreSQL 18)
- Create: `backend/src/main/kotlin/cz/stavebni/denik/db/DatabaseFactory.kt`

**Interfaces:**

- Consumes: V1 migration from Task 1.2
- Produces: `DatabaseFactory.init()` function, HikariCP pool, Flyway migration on startup, jOOQ generated classes in `backend/build/generated-sources/jooq/`

- [ ] **Step 1: Create docker-compose.yml for dev PostgreSQL**

```yaml
services:
  db:
    image: postgres:18-alpine
    environment:
      POSTGRES_DB: stavebni_denik
      POSTGRES_USER: denik
      POSTGRES_PASSWORD: denik_dev
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

- [ ] **Step 2: Create DatabaseFactory.kt**

```kotlin
package cz.stavebni.denik.db

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import org.flywaydb.core.Flyway
import org.jooq.DSLContext
import org.jooq.SQLDialect
import org.jooq.impl.DSL

object DatabaseFactory {
    lateinit var dsl: DSLContext
        private set

    fun init(jdbcUrl: String, user: String, password: String) {
        val ds = HikariDataSource(HikariConfig().apply {
            this.jdbcUrl = jdbcUrl
            this.username = user
            this.password = password
            maximumPoolSize = 10
            isAutoCommit = false
            transactionIsolation = "TRANSACTION_READ_COMMITTED"
        })

        Flyway.configure()
            .dataSource(ds)
            .locations("classpath:db/migration")
            .load()
            .migrate()

        dsl = DSL.using(ds, SQLDialect.POSTGRES)
    }
}
```

- [ ] **Step 3: Wire DatabaseFactory into Application.kt**
- [ ] **Step 4: Configure jOOQ code generation in build.gradle.kts**
- [ ] **Step 5: Start PostgreSQL, run Flyway, generate jOOQ classes**

Run: `docker compose up -d && cd backend && ../gradlew flywayMigrate jooqCodegen`

- [ ] **Step 6: Verify generated jOOQ classes exist**
- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "feat: add DatabaseFactory, Flyway migration, jOOQ codegen"
```

---

## Phase 2: Domain Layer (parallelizable tasks)

### Task 2.1: RBAC — Role, Action, can()

**Files:**

- Create: `backend/src/main/kotlin/cz/stavebni/denik/domain/Role.kt`
- Create: `backend/src/main/kotlin/cz/stavebni/denik/domain/Action.kt`
- Create: `backend/src/main/kotlin/cz/stavebni/denik/domain/Rbac.kt`
- Test: `backend/src/test/kotlin/cz/stavebni/denik/domain/RbacTest.kt`

### Task 2.2: Audit Chain — auditedTransaction() HOF

**Files:**

- Create: `backend/src/main/kotlin/cz/stavebni/denik/services/AuditService.kt`
- Test: `backend/src/test/kotlin/cz/stavebni/denik/services/AuditServiceTest.kt`

### Task 2.3: JSONB Converters & jOOQ Configuration

**Files:**

- Create: `backend/src/main/kotlin/cz/stavebni/denik/db/JsonbConverters.kt`
- Create: data class files for all 6 JSONB column types

---

## Phase 3: Auth Layer

### Task 3.1: Password Hashing (Argon2)

### Task 3.2: JWT Token Service

### Task 3.3: Auth Routes (login, logout, change-password, me)

### Task 3.4: Rate Limiting Plugin

---

## Phase 4: Core Services

### Task 4.1: User Service (CRUD + admin operations)

### Task 4.2: Project Service (CRUD + members + authorized persons)

### Task 4.3: Report Service (CRUD + sign + acknowledge + addendum)

### Task 4.4: Photo Service (upload + airlock + delete)

### Task 4.5: Weather Client (Open-Meteo)

### Task 4.6: Notification Service

### Task 4.7: Material Service (resolve + rollover)

### Task 4.8: Visit Service

### Task 4.9: Remark Service

### Task 4.10: Site Handover Service

### Task 4.11: Dashboard & Statistics Service

### Task 4.12: CSV Export Service

### Task 4.13: Legislative Validation Service

---

## Phase 5: PDF Export

### Task 5.1: Typst Template (stavebni_denik.typ)

### Task 5.2: PdfExportService (Kotlin → JSON → Typst CLI)

### Task 5.3: PDF Route with rate limiting

---

## Phase 6: Frontend (React 19 + Vite)

### Task 6.1: Vite + React project scaffolding

### Task 6.2: Auth pages (login, change password)

### Task 6.3: Dashboard page

### Task 6.4: Projects list + create/edit

### Task 6.5: Project detail (reports calendar, members, authorized persons)

### Task 6.6: Daily report view + create/edit

### Task 6.7: Photo upload + gallery

### Task 6.8: Admin: users management

### Task 6.9: Admin: audit log viewer

### Task 6.10: Notifications dropdown

---

## Phase 7: Infrastructure

### Task 7.1: Dockerfile (multi-stage build)

### Task 7.2: fly.toml configuration

### Task 7.3: CI/CD (GitHub Actions)

---

## Phase 8: Integration & Polish

### Task 8.1: E2E tests (Playwright)

### Task 8.2: Photo reconciliation script

### Task 8.3: Final security review

### Task 8.4: Performance testing (1GB RAM validation)
