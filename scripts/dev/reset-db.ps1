# ---------------------------------------------------------------------------
# scripts/dev/reset-db.ps1 — wipe local DB and re-seed
# ---------------------------------------------------------------------------

$ErrorActionPreference = "Stop"

function Info($msg) { Write-Host "[reset] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[reset] $msg" -ForegroundColor Yellow }
function Err($msg)  { Write-Host "[reset] $msg" -ForegroundColor Red }

$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root

Warn "Tahle akce SMAŽE LOKÁLNÍ POSTGRES DATA (users, projects, audit log, …)."
Warn "Fyzické JPEG soubory v .dev-data\ zůstanou."
$confirm = Read-Host "Pokračovat? [yes/NO]"
if ($confirm -ne "yes") {
    Info "Zrušeno."
    exit 0
}

Info "Zastavuju Postgres + dropuju volume..."
docker compose down -v
if ($LASTEXITCODE -ne 0) { Warn "compose down -v vrátil chybu, pokračuju" }

Info "Spouštím Postgres znovu..."
docker compose up -d
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Info "Čekám na Postgres..."
$ready = $false
for ($i = 1; $i -le 30; $i++) {
    docker compose exec -T postgres pg_isready -U postgres 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $ready = $true
        Info "Postgres ready"
        break
    }
    Start-Sleep -Seconds 1
}
if (-not $ready) {
    Err "Postgres se nespustil"
    exit 1
}

Info "Aplikace migrací..."
pnpm exec prisma migrate dev --skip-seed
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Info "Bootstrap admin..."
Write-Host ""
Write-Host "============================================================"
Write-Host "  POZOR: Heslo se zobrazí JEDNOU. Uložit si ho!"
Write-Host "============================================================"
Write-Host ""
pnpm db:seed

Write-Host ""
Info "DB resetnuta. Spusť: pnpm dev"
