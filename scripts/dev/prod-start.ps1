# ===========================================================================
# scripts/dev/prod-start.ps1 — production server na pozadí (Windows)
#
# Spouští `node .next\standalone\server.js` jako:
#   1. (default) Scheduled Task → přežije zavření PowerShellu i logout,
#      Windows ji automaticky restartuje při crashi (RestartCount=3).
#      Doporučeno pro stabilní lokální dev.
#   2. Volitelně přes -NoTask → jen Start-Process Hidden (bez Task Scheduler).
#      Přežije zavření PowerShellu (Windows nemá process group inheritance
#      jako Unix), ALE NE logout uživatele. Pro krátkodobé použití.
#
# Pro Linux/macOS: scripts/dev/prod-start.sh
#
# Použití:
#   .\scripts\dev\prod-start.ps1           # build pokud chybí + Scheduled Task
#   .\scripts\dev\prod-start.ps1 -Build    # vždy rebuild
#   .\scripts\dev\prod-start.ps1 -Restart  # restart bez rebuildu
#   .\scripts\dev\prod-start.ps1 -NoTask   # Start-Process Hidden (bez Task)
#
# Stop:    .\scripts\dev\prod-stop.ps1
# Log:     Get-Content -Wait $env:TEMP\stavebni-prod.log
# Status:  Get-ScheduledTask -TaskName StavebniDenikProd
# ===========================================================================

[CmdletBinding()]
param(
    [switch]$Build,
    [switch]$Restart,
    [switch]$NoTask
)

$ErrorActionPreference = 'Stop'

function Info($msg) { Write-Host "[prod] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[prod] $msg" -ForegroundColor Yellow }
function Err($msg)  { Write-Host "[prod] $msg" -ForegroundColor Red }

$Root      = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root

$TaskName  = 'StavebniDenikProd'
$LogFile   = Join-Path $env:TEMP 'stavebni-prod.log'
$ErrFile   = Join-Path $env:TEMP 'stavebni-prod.err'
$PidFile   = Join-Path $env:TEMP 'stavebni-prod.pid'
$Port      = if ($env:PORT)     { $env:PORT }     else { '3000' }
$Bind      = if ($env:HOSTNAME) { $env:HOSTNAME } else { '0.0.0.0' }

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    Err 'node nenalezen v PATH. Nainstaluj Node 24+ (Volta nebo nodejs.org).'
    exit 1
}
$NodePath = $NodeCmd.Source

# ── 1) Zastavit existující ─────────────────────────────────────────────────
# 1a) Scheduled Task pokud existuje
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Info "Zastavuji existující Scheduled Task '$TaskName'"
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
}

# 1b) Cokoliv jiného co drží :Port (zombie z Start-Process / minulé session)
$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
    Warn "Na :$Port visí PID $($c.OwningProcess) — zabíjím."
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
}
if ($conns) { Start-Sleep -Seconds 1 }

# 1c) PID file z předchozího -NoTask runu
if (Test-Path $PidFile) {
    $oldPid = Get-Content $PidFile -ErrorAction SilentlyContinue
    if ($oldPid) {
        Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
    }
    Remove-Item $PidFile -ErrorAction SilentlyContinue
}

# ── 2) Build pokud chybí ───────────────────────────────────────────────────
if (-not $Restart) {
    $needsBuild = $Build -or -not (Test-Path '.next\standalone\server.js')
    if ($needsBuild) {
        Info 'pnpm build (standalone bundle)'
        & pnpm build
        if ($LASTEXITCODE -ne 0) { throw 'pnpm build selhal' }
    }

    # ── 3) Kopírovat .next/static + public/ do standalone ──────────────────
    Info 'Kopiruji .next\static a public\ do .next\standalone\'
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
}

# ── 4) Spustit ─────────────────────────────────────────────────────────────
$nodeArgs = @()
if (Test-Path '.env') { $nodeArgs += '--env-file=.env' }
$nodeArgs += '.next\standalone\server.js'

if ($NoTask) {
    # ── Fallback: Start-Process Hidden (žádný auto-restart, žádná persistence
    # přes logout, ale přežije zavření PowerShellu) ────────────────────────
    Info "Spoustim node Hidden (bez Scheduled Tasku) na :$Port"
    $env:PORT     = $Port
    $env:HOSTNAME = $Bind
    $env:NODE_ENV = 'production'
    $proc = Start-Process -FilePath $NodePath `
        -ArgumentList $nodeArgs `
        -RedirectStandardOutput $LogFile `
        -RedirectStandardError $ErrFile `
        -WindowStyle Hidden `
        -PassThru
    $proc.Id | Out-File -FilePath $PidFile -Encoding ascii
}
else {
    # ── Default: Scheduled Task ────────────────────────────────────────────
    Info "Registruji Scheduled Task '$TaskName' na :$Port"

    # Wrapper batch — Scheduled Task vyžaduje absolutni cesty + neumí
    # přesměrování přímo. Wrapper to ošetří.
    $WrapperBat = Join-Path $env:TEMP 'stavebni-prod-wrapper.bat'
    $wrapperContent = @"
@echo off
cd /d "$Root"
set NODE_ENV=production
set PORT=$Port
set HOSTNAME=$Bind
"$NodePath" $($nodeArgs -join ' ') 1>"$LogFile" 2>"$ErrFile"
"@
    Set-Content -Path $WrapperBat -Value $wrapperContent -Encoding ASCII

    $action  = New-ScheduledTaskAction -Execute $WrapperBat
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

    # RestartCount + RestartInterval = launchd KeepAlive ekvivalent
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Days 0) `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -MultipleInstances IgnoreNew

    $principal = New-ScheduledTaskPrincipal `
        -UserId $env:USERNAME `
        -LogonType Interactive `
        -RunLevel Limited

    Register-ScheduledTask -TaskName $TaskName `
        -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
        -Description 'Stavebni denik — production server (Next standalone)' `
        | Out-Null

    Start-ScheduledTask -TaskName $TaskName
}

# ── 5) Health-check ────────────────────────────────────────────────────────
Info 'Cekam na /healthz (max 30 s)'
for ($i = 0; $i -lt 30; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:$Port/healthz" `
            -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($r.StatusCode -eq 200) {
            Info "OK — http://localhost:$Port"
            Info "Log:  Get-Content -Wait $LogFile"
            if ($NoTask) {
                Info 'Stop: .\scripts\dev\prod-stop.ps1'
            } else {
                Info "Status: Get-ScheduledTask -TaskName $TaskName"
                Info 'Stop:   .\scripts\dev\prod-stop.ps1'
            }
            exit 0
        }
    } catch {
        # not ready yet
    }
    Start-Sleep -Seconds 1
}

Err 'Server po 30 s neodpovida. Posledních 40 radku logu:'
if (Test-Path $LogFile) { Get-Content $LogFile -Tail 40 }
if (Test-Path $ErrFile) { Get-Content $ErrFile -Tail 40 }
exit 1
