# Lokální development setup

Tenhle dokument je pro vývojáře — **jak rozjet projekt lokálně** na
macOS i Windows, jaké jsou prerekvizity a jak řešit běžné chyby.

Pro architekturu app viz [`ARCHITECTURE.md`](./ARCHITECTURE.md).
Pro deploy viz [`DEPLOYMENT.md`](./DEPLOYMENT.md).

---

## Prerekvizity (oba OS)

| Tool | Verze | Co dělá |
|---|---|---|
| **Node.js** | 24+ (LTS) | Next 16 runtime, sharp prebuilt binaries |
| **pnpm** | 9+ | Package manager (lockfile commited) |
| **Docker** (Compose) | 24+ | Lokální Postgres |
| **Git** | 2.40+ | (s LF line endings — viz Windows sekce) |

Volitelně pro full testing:

| Tool | Účel |
|---|---|
| Chromium / `pnpm exec playwright install chromium` | PDF render + E2E smoke |
| `restic` (homebrew / scoop) | Manuální backup test |
| `colima` (jen macOS, alternativa Docker Desktop) | Lehčí náhrada Docker Desktopu |

---

## 1. macOS setup

### A) Docker přes **Docker Desktop** (jednodušší)

```bash
brew install --cask docker
# Spustit Docker.app, počkat na green status indicator

# Verify
docker --version
docker compose version
```

### B) Docker přes **Colima** (lehčí, žádné GUI)

```bash
brew install colima docker docker-compose
colima start --cpu 2 --memory 4 --disk 30

# Verify
colima status                # docker socket = unix:///Users/.../docker.sock
docker --version
docker compose version
```

Pro Testcontainers (integration testy) je třeba doexportovat env vars:

```bash
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
```

Doporučení: hodit to do `~/.zshrc` / `~/.bashrc`.

### Node + pnpm:

```bash
# Pokud máš nvm:
nvm install --lts
nvm use --lts

# Pokud máš asdf:
asdf plugin add nodejs
asdf install nodejs latest:24
asdf global nodejs latest:24

# pnpm
npm i -g pnpm@latest
```

---

## 2. Windows setup

### Docker Desktop (doporučeno na Windows)

**Colima na Windows neexistuje** — používej **Docker Desktop** s
WSL2 backendem.

1. **Zapnout WSL2** (PowerShell jako admin):
   ```powershell
   wsl --install -d Ubuntu
   # po restartu počítače
   wsl --set-default-version 2
   ```
2. **Stáhnout & nainstalovat Docker Desktop:**
   <https://www.docker.com/products/docker-desktop>
3. V Docker Desktop → Settings → General → zaškrtnout **"Use WSL 2
   based engine"** + Settings → Resources → WSL Integration →
   povolit Ubuntu.
4. Ověř v PowerShellu:
   ```powershell
   docker --version
   docker compose version
   ```

### Node + pnpm na Windows:

```powershell
# Možnost A: oficiální MSI z https://nodejs.org/ → 24 LTS
# Možnost B: přes Volta (https://volta.sh/) — náš preferovaný
winget install Volta.Volta
volta install node@24
volta install pnpm
```

### Git line endings na Windows

**KRITICKÉ:** projekt používá **LF** end-of-line. Globálně:

```powershell
git config --global core.autocrlf false
git config --global core.eol lf
```

V repu je `.gitattributes` co vynucuje LF pro source soubory, ale
globální nastavení Gitu si fakt zkontroluj — jinak budeš mít diff
proti `main` jen z line endings.

### Cross-platform pozn.

- **Path separators:** kód používá `node:path` (`path.join`,
  `path.resolve`) — fungují na obou OS. Žádné `/` natvrdo.
- **`DATA_DIR`** v `.env` — defaultně `./.dev-data`. Na Windows
  Docker Desktop můžeš nechat jako je; složka se vytvoří automaticky.
- **Shell scripty** (`scripts/dev/*.sh`): na Windows pouštěj přes
  **Git Bash** (přibalený v Git for Windows) nebo přes WSL. Pro
  čistě Windows workflow máme paralelní `.ps1` varianty.

---

## 3. Quick start (oba OS, jednou)

```bash
git clone https://github.com/simontom/stavebni-denik.git
cd stavebni-denik

# 1. Závislosti
pnpm install

# 2. ENV file (zkopíruj template)
cp .env.example .env
# Vygeneruj nový AUTH_SECRET:
#   macOS / WSL / Git Bash:
#     echo "AUTH_SECRET=\"$(openssl rand -base64 32)\"" >> .env
#   PowerShell:
#     "AUTH_SECRET=`"$([Convert]::ToBase64String((1..32 | %{ Get-Random -Maximum 256 })))`"" | Out-File -Append .env

# 3. Postgres
docker compose up -d

# 4. Migrace + Prisma client
pnpm exec prisma migrate dev
pnpm exec prisma generate

# 5. Bootstrap admin
pnpm db:seed
# → vypíše nickname=admin + password=…  (ulož si!)

# 6. Spustit dev server
pnpm dev
# → http://localhost:3000
```

Existují **helper skripty** v `scripts/dev/` co tohle dělají
jediným příkazem — viz § 5.

---

## 4. Běžné dev tasks

| Co potřebuju | Příkaz |
|---|---|
| Spustit dev server | `pnpm dev` |
| **Mobile testing** (Turbopack dev na mobile nehydratuje) | `pnpm build && pnpm start` |
| Postgres up / down | `docker compose up -d` / `docker compose down` |
| Resetovat DB do prázdna | `pnpm exec prisma migrate reset` (drop + migrate + seed) |
| Nová migrace | `pnpm exec prisma migrate dev --name xxx` |
| Typecheck | `pnpm typecheck` |
| Lint | `pnpm lint` |
| Unit testy | `pnpm test` |
| Integration testy (potřebují Docker) | `pnpm test:integration` |
| E2E testy (Playwright) | `pnpm test:e2e` |
| Production build (test reálné CSP) | `pnpm build` |
| Production server (po build) | `pnpm start` |
| Ověření audit chainu | `pnpm verify:audit` |
| Disk ↔ DB reconcile fotek | `pnpm reconcile:photos` |

### Integration testy (Postgres přes Testcontainers)

**macOS / Colima:**

```bash
DOCKER_HOST="unix://$HOME/.colima/default/docker.sock" \
TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock \
pnpm test:integration
```

**macOS / Docker Desktop, Windows / Docker Desktop:**

```bash
pnpm test:integration
# (Docker Desktop má std. socket, žádné env vars netřeba)
```

---

## 5. Helper skripty v `scripts/dev/`

Pro pohodlí jsou v repu skripty co automatizují běžné cesty. Mají
verzi pro **shell (`.sh`)** i **PowerShell (`.ps1`)**.

| Skript | Co dělá |
|---|---|
| `setup` | Fresh setup: nainstaluje deps, vytvoří `.env` z template, spustí Postgres, migrace, seed. Idempotentní (přeskakuje hotové kroky). |
| `reset-db` | Stop Postgres → drop volume → restart → migrate → seed (= čistý stav). |
| `up` | Postgres up (compose) + Prisma generate + ověření env. |
| `down` | Postgres down + cleanup hanging Node procesů. |

### macOS / Linux / WSL:

```bash
./scripts/dev/setup.sh        # první run
./scripts/dev/reset-db.sh     # když chceš čistou DB
./scripts/dev/up.sh           # běžný start
./scripts/dev/down.sh         # zastavit a uklidit
```

### Windows (PowerShell):

```powershell
.\scripts\dev\setup.ps1
.\scripts\dev\reset-db.ps1
.\scripts\dev\up.ps1
.\scripts\dev\down.ps1
```

Pokud PowerShell brblá na execution policy:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

---

## 6. Troubleshooting

### "Cannot find module 'server-only'" při spuštění skriptu

Skripty v `scripts/` se spouštějí přes `tsx` mimo Next.js runtime.
Soubory pod `src/server/` co mají `import "server-only"` se z nich
nesmí importovat. Helpery, které potřebujou skripty I server, žijí
bez `server-only` direktivy (např. `src/server/services/photos-
reconcile.ts`).

### "DOCKER_HOST environment variable not set"

Colima na macOS: viz § 1.B (env vars do `~/.zshrc`).
Docker Desktop: zkontroluj, že běží (icon v menu baru).

### Mobile Chrome — file picker nereaguje / Nahrát fotky zašedlé

Známý quirk: `pnpm dev` (Turbopack) **NEhydratuje** React na Android
Chrome přes HTTP LAN IP. Test:

```bash
pnpm build
pnpm start
# Pak připojit mobil na http://<LAN-IP>:3000
```

Detail v `docs/ARCHITECTURE.md` § 5, bod 1.

### "Style sheet could not be loaded" / MIME mismatch po reloadu

Browser drží zastaralou cached verzi HTML s odkazy na chunky, které
už neexistují po `pnpm build`. Hard reload (Cmd+Shift+R / Ctrl+F5)
nebo nové soukromé okno.

### `dev/cmqp...` chunks na disku v `.next/static/`

To je Turbopack dev cache, je v `.gitignore`. Smazat:

```bash
rm -rf .next
# nebo: ./scripts/dev/down.sh
```

### Sentry "DEPRECATION WARNING" v logu

Neškodné. Sentry SDK loaduje package, ale init je gated na
`SENTRY_DSN` (v lokálním devu prázdné → SDK je no-op).

### Vidím `Couldn't load fs` / `Couldn't load zlib` v logu

Turbopack runtime warnings, neškodné. Souvisí s polyfilly pro Node
moduly v browser kontextu.

---

## 7. Před commitem

1. **`pnpm typecheck`** ✅
2. **`pnpm lint`** ✅
3. **`pnpm test`** ✅ (unit, rychlé)
4. **`pnpm test:integration`** ✅ (Postgres testcontainer — pomalejší
   ~40 s)
5. **Smoke v UI** (nepovinné, ale doporučené pro UI změny):
   `pnpm build && pnpm start` → otevři klíčový flow

### Commit message konvence

Používáme **Conventional Commits**:

```
feat(scope): krátký popis

Volitelně delší popis. Bullety. Co se mění a proč.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

Typy: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `perf`,
`build`.

Scope (volitelný): typicky modul (`audit`, `photos`, `auth`, …).

---

## 8. Příště na Windows — co zkontrolovat

Když tahle dev mašina přejde na Windows, projdi tenhle checklist:

- [ ] **WSL2** funkční (`wsl --status`)
- [ ] **Docker Desktop** s WSL2 backendem, integrace s Ubuntu
- [ ] **Node 24 LTS** přes Volta
- [ ] **pnpm** globálně
- [ ] **Git config:** `core.autocrlf false`, `core.eol lf`
- [ ] **`pnpm install`** (Prisma natáhne správné binaries pro
      Windows / WSL)
- [ ] **`.env`** — DATA_DIR může zůstat `./.dev-data`
- [ ] **`docker compose up -d`** a `pnpm exec prisma migrate dev`
- [ ] **`pnpm dev`** funguje na localhost:3000

Pokud nějaký krok selže, otevři issue / přidej do tohoto dokumentu.
