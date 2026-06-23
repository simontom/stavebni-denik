# ---------------------------------------------------------------------------
# scripts/dev/setup.ps1 — fresh local dev setup (Windows / PowerShell)
#
# Idempotentní. Pustit z root repa:
#   .\scripts\dev\setup.ps1
#
# Pokud PowerShell brblá na execution policy:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
# ---------------------------------------------------------------------------

$ErrorActionPreference = "Stop"

function Info($msg)    { Write-Host "[setup] $msg" -ForegroundColor Green }
function Warn($msg)    { Write-Host "[setup] $msg" -ForegroundColor Yellow }
function Err($msg)     { Write-Host "[setup] $msg" -ForegroundColor Red }

# Najít root repa
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root

# 1. Prerekvizity
Info "Kontrola prerekvizit..."
foreach ($tool in @("node", "pnpm", "docker")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Err "$tool nenalezen v PATH"
        exit 1
    }
}
$composeVersion = docker compose version 2>$null
if ($LASTEXITCODE -ne 0) {
    Err "docker compose v2 nenalezen"
    exit 1
}
$nodeVersion = (node -p 'process.versions.node.split(".")[0]')
if ([int]$nodeVersion -lt 24) {
    Warn "Node $nodeVersion detekován — projekt vyžaduje Node 24+"
}
$nodeFull = (node -v)
$pnpmFull = (pnpm -v)
Info "OK — node $nodeFull, pnpm $pnpmFull"

# 2. pnpm install
Info "Instalace závislostí..."
pnpm install --frozen-lockfile=false
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# 3. .env
if (-not (Test-Path .env)) {
    Info "Vytvářím .env z .env.example..."
    Copy-Item .env.example .env
    # Vygenerovat AUTH_SECRET — random 32 bytes → base64
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $authSecret = [Convert]::ToBase64String($bytes)
    $content = Get-Content .env
    $content = $content -replace '^AUTH_SECRET=.*', "AUTH_SECRET=`"$authSecret`""
    $content | Set-Content .env -Encoding UTF8
    Info "AUTH_SECRET vygenerován"
} else {
    Info ".env už existuje, přeskočeno"
}

# 4. Postgres
Info "Spouštím Postgres přes docker compose..."
docker compose up -d
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# 5. Wait for Postgres
Info "Čekám na Postgres (max 30 s)..."
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
    Err "Postgres se nespustil za 30 s — zkontroluj 'docker compose logs postgres'"
    exit 1
}

# 6. Migrace + Prisma client
Info "Aplikace migrací..."
pnpm exec prisma migrate dev --skip-seed
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Info "Generování Prisma klienta..."
pnpm exec prisma generate

# 7. Seed
Info "Bootstrap admin..."
Write-Host ""
Write-Host "============================================================"
Write-Host "  POZOR: Heslo se zobrazí JEDNOU. Uložit si ho!"
Write-Host "============================================================"
Write-Host ""
pnpm db:seed
if ($LASTEXITCODE -ne 0) {
    Warn "Seed selhal (možná už admin existuje?)"
}

Write-Host ""
Info "Setup hotov! Spusť dev server: pnpm dev"
Info "Otevři: http://localhost:3000/login"
