# Stavební deník

Elektronický stavební deník podle § 157 stavebního zákona (zákon č. 283/2021 Sb.) a vyhlášky č. 131/2024 Sb. (příloha 12). Aplikace je **single-tenant**: jedna instance patří jedné firmě.

> **Stav:** sestavení ještě není uvolněné pro skutečná data deníku. V produkčním režimu se aplikace bez `ALLOW_UNRELEASED_BUILD=true` nespustí (jen pro testovací data). Podmínky uvolnění jsou v [`PROJECT.md`](PROJECT.md), kapitola „Release gate“.

## Dokumentace

| Soubor                                       | Obsah                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [`PROJECT.md`](PROJECT.md)                   | **Hlavní dokument:** architektura, pravidla, bezpečnost, API, role, audit, konfigurace, otevřené úkoly (anglicky). |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | Lokální vývoj, testy, E2E, práce s databází.                                                                       |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)   | Nasazení na Fly.io, první administrátor, zálohy.                                                                   |

## Technologie

| Vrstva   | Technologie                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------ |
| Backend  | Kotlin 2.1, Ktor 3.1 (Netty), jOOQ 3.21, Flyway, PostgreSQL 18, Argon2id                               |
| Frontend | Vite 8, React 19, React Router 7, Tailwind CSS 4                                                       |
| Audit    | Append-only `audit_log` s řetězem SHA-256 hashů, databázové triggery, ověření příkazem `audit-verify`  |
| Fotky    | ImageIO: kontrola hlavičky před dekódováním, přeuložení do nového JPEG bez metadat, otočení podle EXIF |
| PDF      | `typst` (pevná šablona, uživatelský text jde jen jako data)                                            |
| Testy    | JUnit 5 + Testcontainers (PostgreSQL 18), Playwright                                                   |
| Hosting  | Fly.io (Frankfurt), jeden Docker obraz: Ktor + sestavené SPA + typst                                   |

## Rychlý start

Potřebujete JDK 21, Node 22+, pnpm a Docker.

```bash
docker compose up -d                 # PostgreSQL 18 na localhost:5432
./gradlew :backend:run               # backend na http://localhost:8080 (migrace proběhnou samy)
pnpm --prefix frontend install       # jednou
pnpm --prefix frontend dev           # SPA na http://localhost:5173 (proxy na backend)
```

Databáze je prázdná, nikdo se nemůže přihlásit. První administrátora vytvoří příkaz (vypíše vygenerované heslo, které je nutné při prvním přihlášení změnit):

```bash
java -cp backend/build/libs/backend-all.jar cz.stavebni.denik.cli.AdminCliKt create-admin alice "Alice Nováková"
```

(předtím `./gradlew :backend:shadowJar`). Podrobnosti a ostatní příkazy: [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Testy

```bash
./gradlew test                        # backend (Testcontainers spustí PostgreSQL sám)
pnpm --prefix frontend lint && pnpm --prefix frontend build
pnpm install && pnpm exec playwright install chromium && pnpm test:e2e   # E2E, backend musí běžet
```

## Pravidla repozitáře

- Nikdy se necommituje přímo do `main`: každá změna je na vlastní větvi a jde přes pull request; musí projít všechny kontroly CI.
- Změna schématu = nová Flyway migrace + `./gradlew :backend:generateJooq` a commit vygenerovaných zdrojů.
- Zranitelnosti se do veřejného repozitáře nepopisují podrobně.
