# ===========================================================================
# scripts/dev/prod-stop.ps1 — zastaví production server (Windows)
#
# Zastaví Scheduled Task NEBO Start-Process Hidden instanci (podle toho
# co prod-start.ps1 zvolil). Fallback: zabíj cokoliv na :3000.
#
# Použití:
#   .\scripts\dev\prod-stop.ps1
#   .\scripts\dev\prod-stop.ps1 -Purge   # smaže i Scheduled Task definici
# ===========================================================================

[CmdletBinding()]
param([switch]$Purge)

$ErrorActionPreference = 'Stop'

function Info($msg) { Write-Host "[prod] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[prod] $msg" -ForegroundColor Yellow }

$TaskName = 'StavebniDenikProd'
$PidFile  = Join-Path $env:TEMP 'stavebni-prod.pid'
$Wrapper  = Join-Path $env:TEMP 'stavebni-prod-wrapper.bat'
$Port     = if ($env:PORT) { $env:PORT } else { '3000' }

# ── 1) Scheduled Task ──────────────────────────────────────────────────────
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Info "Zastavuji Scheduled Task '$TaskName'"
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($Purge) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false `
            -ErrorAction SilentlyContinue
        if (Test-Path $Wrapper) { Remove-Item $Wrapper -Force }
    }
}

# ── 2) PID file z -NoTask runu ─────────────────────────────────────────────
if (Test-Path $PidFile) {
    $pid_ = Get-Content $PidFile -ErrorAction SilentlyContinue
    if ($pid_) {
        $proc = Get-Process -Id $pid_ -ErrorAction SilentlyContinue
        if ($proc) {
            Info "Zabijim PID $pid_"
            Stop-Process -Id $pid_ -Force -ErrorAction SilentlyContinue
        }
    }
    Remove-Item $PidFile -ErrorAction SilentlyContinue
}

# ── 3) Fallback: cokoliv na :$Port ─────────────────────────────────────────
Start-Sleep -Seconds 1
$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
    Warn "Na :$Port po stopu visí PID $($c.OwningProcess) — zabíjím."
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
}

Info 'Hotovo.'
