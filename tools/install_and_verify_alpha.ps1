$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $repoRoot 'apps\desktop\release-alpha\SkillCue-Alpha-Setup.exe'
$installedApp = Join-Path $env:LOCALAPPDATA 'Programs\skillcue-alpha\SkillCue Alpha.exe'
$installedBackend = Join-Path $env:LOCALAPPDATA 'Programs\skillcue-alpha\resources\backend\skillcue-backend.exe'
$hadChannel = Test-Path Env:SKILLCUE_E2E_CHANNEL
$previousChannel = $env:SKILLCUE_E2E_CHANNEL
$hadBackend = Test-Path Env:SKILLCUE_E2E_BACKEND
$previousBackend = $env:SKILLCUE_E2E_BACKEND
$hadCases = Test-Path Env:SKILLCUE_E2E_CASE_IDS
$previousCases = $env:SKILLCUE_E2E_CASE_IDS

Push-Location $repoRoot
try {
  pnpm --filter @interview/desktop dist:alpha
  if ($LASTEXITCODE -ne 0) { throw "Alpha build failed: $LASTEXITCODE" }
  if (-not (Test-Path -LiteralPath $installer)) { throw "Alpha installer not found: $installer" }

  $install = Start-Process -FilePath $installer -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
  if ($install.ExitCode -ne 0) { throw "Alpha installer failed: $($install.ExitCode)" }
  if (-not (Test-Path -LiteralPath $installedApp)) { throw "Installed Alpha app not found: $installedApp" }
  if (-not (Test-Path -LiteralPath $installedBackend)) { throw "Installed Alpha backend not found: $installedBackend" }

  $env:SKILLCUE_E2E_CHANNEL = 'alpha'
  $env:SKILLCUE_E2E_BACKEND = $installedBackend
  $env:SKILLCUE_E2E_CASE_IDS = 'unseen-sql-null-premise'
  pnpm --filter @interview/desktop verify:dev:overlay
  if ($LASTEXITCODE -ne 0) { throw "Installed Alpha overlay E2E failed: $LASTEXITCODE" }
} finally {
  if ($hadChannel) { $env:SKILLCUE_E2E_CHANNEL = $previousChannel } else { Remove-Item Env:SKILLCUE_E2E_CHANNEL -ErrorAction SilentlyContinue }
  if ($hadBackend) { $env:SKILLCUE_E2E_BACKEND = $previousBackend } else { Remove-Item Env:SKILLCUE_E2E_BACKEND -ErrorAction SilentlyContinue }
  if ($hadCases) { $env:SKILLCUE_E2E_CASE_IDS = $previousCases } else { Remove-Item Env:SKILLCUE_E2E_CASE_IDS -ErrorAction SilentlyContinue }
  Pop-Location
}
