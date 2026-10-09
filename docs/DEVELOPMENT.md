# Lokální vývoj

Architektura, pravidla a konfigurace jsou v [`../PROJECT.md`](../PROJECT.md). Tady je jen to, jak věci spustit.

## Co potřebujete

- JDK 21 (backend se jinou verzí nesestaví; Gradle používá toolchain 21)
- Node 22+ a pnpm (verze, kterou používá CI, je v `.github/workflows/ci.yml`, proměnná `PNPM_VERSION`)
- Docker (PostgreSQL 18 a testy přes Testcontainers)
- volitelně `typst` na PATH (jinak vrací export PDF `503`; testy skutečného typstu se přeskočí, v CI jsou povinné)

## Spuštění

```bash
docker compose up -d                 # PostgreSQL 18, uživatel denik / heslo denik_dev, databáze stavebni_denik
./gradlew :backend:run               # Ktor na :8080, Flyway migruje schéma při startu
pnpm --prefix frontend install
pnpm --prefix frontend dev           # Vite na :5173, /api se proxyuje na :8080
```

Konfigurace backendu jde přes proměnné prostředí (tabulka v `PROJECT.md`, kapitola „Runtime configuration“); `.env.example` je vzor. Bez `JWT_SECRET` se v dev režimu použije náhodné tajemství na jeden běh, takže restart backendu odhlásí všechny.

## První uživatel a obnova hesla

Čerstvá databáze nemá uživatele. Příkazy běží proti stejné databázi jako aplikace:

```bash
./gradlew :backend:shadowJar
java -cp backend/build/libs/backend-all.jar cz.stavebni.denik.cli.AdminCliKt create-admin <přezdívka> "<jméno>"
java -cp backend/build/libs/backend-all.jar cz.stavebni.denik.cli.AdminCliKt reset-password <přezdívka>
java -cp backend/build/libs/backend-all.jar cz.stavebni.denik.cli.AdminCliKt audit-head
java -cp backend/build/libs/backend-all.jar cz.stavebni.denik.cli.AdminCliKt audit-verify [<id>:<hash>]
```

Heslo se vypíše jednou a platí 7 dní; při prvním přihlášení se musí změnit. `audit-head` a `audit-verify` jen čtou (nemigrují schéma). Návratové kódy jsou v `PROJECT.md`.

## Testy

```bash
./gradlew test                                    # celý backend; potřebuje Docker
./gradlew :backend:test --tests '*SomeTest'       # jeden test
pnpm --prefix frontend lint
pnpm --prefix frontend build                      # tsc + vite build
```

E2E (Playwright) běží z kořene repozitáře proti běžícímu backendu a PostgreSQL:

```bash
pnpm install
pnpm exec playwright install chromium
pnpm typecheck                                    # TypeScript E2E kódu
pnpm test:seed-guard                              # zkouška pojistky, že seed nepoběží proti cizí databázi
pnpm test:e2e                                     # spustí si Vite sám, backend musí běžet na :8080
```

E2E seed (`scripts/dev/e2e-prepare.ts`) zakládá účty `e2e-admin` a `e2e-investor` přímo v databázi a odmítne pracovat s čímkoli jiným než s databází na tomto počítači (`DATABASE_URL`, výchozí je lokální compose databáze). Test `full-flow` stahuje PDF, takže potřebuje `typst`; bez něj selže právě tam.

## Databáze a jOOQ

Schéma patří Flyway migracím (`backend/src/main/resources/db/migration`). Po každé změně migrace:

```bash
./gradlew :backend:generateJooq                   # spustí PostgreSQL v Testcontainers, vygeneruje zdroje
git status --short backend/src/generated/jooq     # změny commitněte; CI hlídá, aby byly aktuální
```

Lokální databáze, která už aplikovala starší verzi migrace, se zahodí a založí znovu: `docker compose down -v && docker compose up -d`.

## Fotky

Ukládají se do `UPLOADS_DIR` (výchozí `./uploads`, v adresáři `photos`). Server je při nahrání znovu zakóduje, takže se do úložiště nikdy nedostane původní soubor.

## Git

Každá změna na vlastní větvi, pull request do `main`, merge commit. Husky před commitem přeformátuje změněné soubory (prettier).
