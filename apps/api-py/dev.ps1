# Запуск API без зависших копий на порту 8000.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object {
        Write-Host "Stopping stale process on :8000 (PID $_)"
        Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
    }

$env:HF_HUB_DISABLE_XET = "1"
& .\.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --port 8000 --reload-exclude "data" --reload-exclude "*.sqlite"
