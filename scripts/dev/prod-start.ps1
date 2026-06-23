# ---------------------------------------------------------------------------
# scripts/dev/prod-start.ps1 — production server na pozadí (standalone bundle)
#
# Windows verze prod-start.sh. Stejná logika:
#   - next.config.ts má `output: "standalone"` → musíme spustit
#     `.next/standalone/server.js` přes Node, ne `pnpm start`.
#   - Standalone bundle nemá v sobě `.next/static` ani `public/`,
#     ty musíme zkopírovat dovnitř před startem.
#   - Spuštění jako Background Job → přežije zavření PowerShellu.
#
# Použití:
#   .\scripts\dev\prod-start.ps1            # build pokud chybí + start
#   .\scripts\dev\prod-start.ps1 -Build     # vždy rebuild
#
# Stop:  .\scripts\dev\prod-stop.ps1
# Log:   Get-Content -Wait $env:TEMP\stavebni-prod.log
# ---------------------------------------------------------------------------

[CmdletBinding()]
param(
    [switch]$Build
)

$ErrorActionPreference = 'Stop'

function Info($msg) { Write-Host "[prod] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[prod] $msg" -ForegroundColor Yellow }
function Err($msg)  { Write-Host "[prod] $msg" -ForegroundColor Red }

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root

$LogFile = Join-Path $env:TEMP 'stavebni-prod.log'
$PidFile = Join-Path $env:TEMP 'stavebni-prod.pid'
$Port    = if ($env:PORT)     { $env:PORT }     else { '3000' }
$Bind    = if ($env:HOSTNAME) { $env:HOSTNAME } else { '0.0.0.0' }

# ── 1) Zabij předchozí instanci ────────────────────────────────────────────
if (Test-Path $PidFile) {
    $oldPid = Get-Content $PidFile -ErrorAction SilentlyContinue
    if ($oldPid) {
        $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
        if ($proc) {
            Warn "Předchozí prod běží (PID $oldPid) — zabíjím."
            Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }
    }
    Remove-Item $PidFile -ErrorAction SilentlyContinue
}

# Fallback: zabij cokoliv na :$Port
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    foreach ($c in $conn) {
        Warn "Na :$Port visí PID $($c.OwningProcess) — zabíjím."
        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 1
}

# ── 2) Build (pokud chybí nebo -Build) ─────────────────────────────────────
$needsBuild = $Build -or -not (Test-Path '.next\standalone\server.js')
if ($needsBuild) {
    Info 'pnpm build (standalone bundle)'
    pnpm build
    if ($LASTEXITCODE -ne 0) { throw 'pnpm build selhal' }
}

# ── 3) Kopírovat .next/static + public/ do standalone ──────────────────────
Info 'Kopíruji .next/static a public/ do .next/standalone/'
if (Test-Path '.next\standalone\.next\static') {
    Remove-Item '.next\standalone\.next\static' -Recurse -Force
}
if (Test-Path '.next\standalone\public') {
    Remove-Item '.next\standalone\public' -Recurse -Force
}
New-Item -ItemType Directory -Force -Path '.next\standalone\.next' | Out-Null
Copy-Item -Recurse '.next\static' '.next\standalone\.next\static'
if (Test-Path 'public') {
    Copy-Item -Recurse 'public' '.next\standalone\public'
}

# ── 4) Spuštění detached jako PowerShell Job ───────────────────────────────
Info "Startuji prod server (standalone) na :$Port"

$nodeArgs = @()
if (Test-Path '.env') {
    $nodeArgs += '--env-file=.env'
}
$nodeArgs += '.next\standalone\server.js'

# Start-Process s -WindowStyle Hidden + redirekt na log = detached
$env:PORT     = $Port
$env:HOSTNAME = $Bind
$proc = Start-Process -FilePath 'node' `
    -ArgumentList $nodeArgs `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError "$LogFile.err" `
    -WindowStyle Hidden `
    -PassThru

$proc.Id | Out-File -FilePath $PidFile -Encoding ascii

# ── 5) Health-check ────────────────────────────────────────────────────────
Info 'Cekam na /healthz'
for ($i = 0; $i -lt 30; $i++) {
    $p = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
    if (-not $p) {
        Err "Proces $($proc.Id) umřel během startu. Posledních 40 řádků logu:"
        if (Test-Path $LogFile)       { Get-Content $LogFile -Tail 40 }
        if (Test-Path "$LogFile.err") { Get-Content "$LogFile.err" -Tail 40 }
        Remove-Item $PidFile -ErrorAction SilentlyContinue
        exit 1
    }
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:$Port/healthz" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($r.StatusCode -eq 200) {
            Info "OK — PID $($proc.Id) — http://localhost:$Port"
            Info "Log:  Get-Content -Wait $LogFile"
            Info 'Stop: .\scripts\dev\prod-stop.ps1'
            exit 0
        }
    } catch {
        # not ready yet, retry
    }
    Start-Sleep -Seconds 1
}

Err 'Server po 30 s neodpovídá. Posledních 40 řádků logu:'
if (Test-Path $LogFile)       { Get-Content $LogFile -Tail 40 }
if (Test-Path "$LogFile.err") { Get-Content "$LogFile.err" -Tail 40 }
exit 1
