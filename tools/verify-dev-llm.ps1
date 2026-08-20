$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

function Repair-Utf8Text([string]$value) {
  try {
    return [Text.Encoding]::UTF8.GetString([Text.Encoding]::GetEncoding(1252).GetBytes($value))
  } catch {
    return $value
  }
}

$backend = Join-Path $env:LOCALAPPDATA 'Programs\skillcue-dev\resources\backend\skillcue-backend.exe'
if (-not (Test-Path -LiteralPath $backend)) {
  throw 'Installed SkillCue Dev backend was not found.'
}

$port = Get-Random -Minimum 18100 -Maximum 18900
$token = [guid]::NewGuid().ToString('N')
$database = Join-Path $env:TEMP "skillcue-readiness-$token.sqlite"
$oldPort = $env:SKILLCUE_PORT
$oldToken = $env:SKILLCUE_API_TOKEN
$oldChannel = $env:SKILLCUE_BUILD_CHANNEL
$oldDatabase = $env:DATABASE_URL
$process = $null

try {
  $env:SKILLCUE_PORT = [string]$port
  $env:SKILLCUE_API_TOKEN = $token
  $env:SKILLCUE_BUILD_CHANNEL = 'dev'
  $env:DATABASE_URL = "sqlite:///$($database.Replace('\', '/'))"
  $process = Start-Process -FilePath $backend -WindowStyle Hidden -PassThru

  $headers = @{
    'X-SkillCue-Token' = $token
    'Content-Type' = 'application/json'
  }
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    Start-Sleep -Milliseconds 300
    try {
      Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 1 | Out-Null
      $ready = $true
      break
    } catch {
      # Keep waiting for the isolated backend.
    }
  }
  if (-not $ready) {
    throw 'The isolated SkillCue Dev backend did not start.'
  }

  $result = Invoke-RestMethod `
    -Method Post `
    -Uri "http://127.0.0.1:$port/providers/readiness" `
    -Headers $headers `
    -Body '{}' `
    -TimeoutSec 30

  if (-not $result.ok) {
    throw "The provider answered, but response quality validation failed. Model: $($result.model)"
  }

  Write-Host "OK: SkillCue Dev returned a validated answer through $($result.model) in $([math]::Round($result.latency_ms / 1000, 1)) s."
  Write-Host "Smoke question: $(Repair-Utf8Text $result.question)"
  Write-Host "Answer: $(Repair-Utf8Text $result.answer)"
} finally {
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
  }
  $env:SKILLCUE_PORT = $oldPort
  $env:SKILLCUE_API_TOKEN = $oldToken
  $env:SKILLCUE_BUILD_CHANNEL = $oldChannel
  $env:DATABASE_URL = $oldDatabase
  if (Test-Path -LiteralPath $database) {
    Remove-Item -LiteralPath $database -Force
  }
}
