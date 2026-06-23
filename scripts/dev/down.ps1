# ---------------------------------------------------------------------------
# scripts/dev/down.ps1 — clean shutdown
# ---------------------------------------------------------------------------

$ErrorActionPreference = "Continue"

function Info($msg) { Write-Host "[down] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[down] $msg" -ForegroundColor Yellow }

$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root

Info "Zastavuju Postgres..."
docker compose down
if ($LASTEXITCODE -ne 0) {
    Warn "compose down selhalo (možná už neběží?)"
}

# Hanging Node procesy na portu 3000
$conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    $procIds = $conn | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique
    Warn "Visící Node procesy na portu 3000 (PID: $procIds) — zabíjím."
    foreach ($procId in $procIds) {
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
} else {
    Info "Žádné procesy na portu 3000"
}

Info "Hotovo."
