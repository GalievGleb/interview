<#
Смоук-тест бэкенда перед релизом: поднимает процесс, ждёт /health и проверяет,
что критичные endpoint'ы и токен-авторизация работают в собранном виде.

Замороженная сборка (по умолчанию):
  pwsh scripts/smoke-packaged.ps1
  # ожидает apps/api-py/dist/skillcue-backend/skillcue-backend.exe (pyinstaller)

Логика скрипта без сборки (dev-python):
  pwsh scripts/smoke-packaged.ps1 -Dev
#>
[CmdletBinding()]
param(
    [string]$ExePath = "",
    [int]$Port = 8123,
    [int]$BootTimeoutSec = 90,
    [switch]$Dev
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$apiDir = Join-Path $repoRoot 'apps\api-py'
$base = "http://127.0.0.1:$Port"
$token = [Guid]::NewGuid().ToString('N')

function Fail([string]$msg) {
    Write-Host "SMOKE FAIL: $msg" -ForegroundColor Red
    exit 1
}

function Get-StatusCode([string]$url, [hashtable]$headers) {
    try {
        $resp = Invoke-WebRequest -Uri $url -Headers $headers -UseBasicParsing -TimeoutSec 10
        return [int]$resp.StatusCode
    } catch {
        $code = $_.Exception.Response.StatusCode.value__
        if ($code) { return [int]$code }
        return 0
    }
}

# --- Запуск процесса -------------------------------------------------------
$env:SKILLCUE_PORT = "$Port"
$env:SKILLCUE_API_TOKEN = $token

if ($Dev) {
    Write-Host "Starting DEV backend (py -3.12 -m uvicorn) on port $Port..."
    $env:PYTHONPATH = $apiDir
    $proc = Start-Process -FilePath 'py' `
        -ArgumentList @('-3.12', '-m', 'uvicorn', 'app.main:app', '--port', "$Port") `
        -WorkingDirectory $apiDir -PassThru -WindowStyle Hidden
} else {
    if (-not $ExePath) { $ExePath = Join-Path $apiDir 'dist\skillcue-backend\skillcue-backend.exe' }
    if (-not (Test-Path $ExePath)) {
        Fail "frozen backend not found at $ExePath — run 'pyinstaller skillcue-backend.spec' in apps/api-py first (or use -Dev)"
    }
    Write-Host "Starting frozen backend $ExePath on port $Port..."
    $proc = Start-Process -FilePath $ExePath -WorkingDirectory (Split-Path $ExePath) `
        -PassThru -WindowStyle Hidden
}

try {
    # --- 1. /health должен подняться (он публичный — Electron пингует без токена)
    $healthy = $false
    for ($i = 0; $i -lt $BootTimeoutSec; $i++) {
        if ((Get-StatusCode "$base/health" @{}) -eq 200) { $healthy = $true; break }
        if ($proc.HasExited) { Fail "backend process exited with code $($proc.ExitCode) before /health" }
        Start-Sleep -Seconds 1
    }
    if (-not $healthy) { Fail "/health did not return 200 within $BootTimeoutSec s" }
    Write-Host "OK  /health is up"

    # --- 2. Токен-барьер реально работает: без заголовка — 401
    $code = Get-StatusCode "$base/stt/providers" @{}
    if ($code -ne 401) { Fail "/stt/providers without token returned $code, expected 401 (auth barrier missing!)" }
    Write-Host "OK  auth barrier rejects requests without token (401)"

    # --- 3. С токеном ключевые endpoint'ы отвечают
    $auth = @{ 'X-SkillCue-Token' = $token }
    foreach ($path in @('/stt/providers', '/license/status')) {
        $code = Get-StatusCode "$base$path" $auth
        if ($code -ne 200) { Fail "$path with token returned $code, expected 200" }
        Write-Host "OK  $path -> 200"
    }

    Write-Host "SMOKE PASS: backend boots, auth works, core endpoints respond" -ForegroundColor Green
    exit 0
} finally {
    if ($proc -and -not $proc.HasExited) {
        # Убиваем всё дерево: uvicorn/frozen-бинарь плодят дочерние процессы.
        & taskkill /pid $proc.Id /T /F 2>$null | Out-Null
    }
}
