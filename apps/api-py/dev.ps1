# Запуск API без зависших копий на порту 8000.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Stop-PortListener([int]$Port) {
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object {
            Write-Host "Stopping stale process on :$Port (PID $_)"
            Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
        }
}

# Установленный SkillCue из OneDrive поднимает skillcue-backend на :8000 и перезапускает его.
Get-Process skillcue-backend -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "Stopping installed backend (PID $($_.Id))"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}

Stop-PortListener 8000
Start-Sleep -Seconds 1
Stop-PortListener 8000

$skillcueApp = Get-Process Skillcue -ErrorAction SilentlyContinue
if ($skillcueApp) {
    Write-Host ""
    Write-Host "WARNING: Skillcue.exe is still running (installed app)." -ForegroundColor Yellow
    Write-Host "It will re-occupy port 8000. Close SkillCue before dev, or use another port:" -ForegroundColor Yellow
    Write-Host "  uvicorn app.main:app --reload --port 8001 --reload-exclude data --reload-exclude *.sqlite" -ForegroundColor Yellow
    Write-Host ""
}

$busy = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    throw "Port 8000 is still busy. Close installed SkillCue app and run .\dev.ps1 again."
}

$env:HF_HUB_DISABLE_XET = "1"
& .\.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --port 8000 --reload-exclude "data" --reload-exclude "*.sqlite"
