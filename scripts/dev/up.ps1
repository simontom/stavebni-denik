# ---------------------------------------------------------------------------
# scripts/dev/up.ps1 — start Postgres + ověřit env (bez migrace)
# ---------------------------------------------------------------------------

$ErrorActionPreference = "Stop"

function Info($msg) { Write-Host "[up] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[up] $msg" -ForegroundColor Yellow }

$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root

if (-not (Test-Path .env)) {
    Warn ".env neexistuje — spusť scripts\dev\setup.ps1 nejdřív."
    exit 1
}

Info "Spouštím Postgres..."
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
    Warn "Postgres trvá podezřele dlouho — zkontroluj 'docker compose logs postgres'"
}

Info "Prisma generate..."
pnpm exec prisma generate

Write-Host ""
Info "Hotovo. Spusť dev server: pnpm dev"
Info "Nebo prod build: pnpm build && pnpm start"
