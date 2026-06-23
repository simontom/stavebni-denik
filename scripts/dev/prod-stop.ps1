# ---------------------------------------------------------------------------
# scripts/dev/prod-stop.ps1 — zastaví production server spuštěný přes
# prod-start.ps1
# ---------------------------------------------------------------------------

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Info($msg) { Write-Host "[prod] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[prod] $msg" -ForegroundColor Yellow }

$PidFile = Join-Path $env:TEMP 'stavebni-prod.pid'
$Port    = if ($env:PORT) { $env:PORT } else { '3000' }

if (-not (Test-Path $PidFile)) {
    Warn 'Žádný PID file — server pravděpodobně neběží.'
    # Fallback: zabij cokoliv na :$Port
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        foreach ($c in $conn) {
            Info "Našel jsem PID $($c.OwningProcess) na :$Port — zabíjím."
            Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
        }
    }
    exit 0
}

$pid_ = Get-Content $PidFile -ErrorAction SilentlyContinue
if ($pid_) {
    $proc = Get-Process -Id $pid_ -ErrorAction SilentlyContinue
    if ($proc) {
        Info "Zabíjím PID $pid_..."
        Stop-Process -Id $pid_ -Force -ErrorAction SilentlyContinue
        Remove-Item $PidFile -ErrorAction SilentlyContinue
        Info 'Hotovo.'
    } else {
        Warn "PID $pid_ neběží (zombie PID file?) — mažu."
        Remove-Item $PidFile -ErrorAction SilentlyContinue
    }
}
