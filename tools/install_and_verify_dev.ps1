$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $repoRoot 'apps\desktop\release-dev\SkillCue-Dev-Setup.exe'

Push-Location $repoRoot
try {
  pnpm --filter @interview/desktop dist:dev
  if ($LASTEXITCODE -ne 0) { throw "Dev build failed: $LASTEXITCODE" }
  if (-not (Test-Path -LiteralPath $installer)) { throw "Installer not found: $installer" }

  $install = Start-Process -FilePath $installer -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
  if ($install.ExitCode -ne 0) { throw "Dev installer failed: $($install.ExitCode)" }

  pnpm --filter @interview/desktop verify:dev:overlay
  if ($LASTEXITCODE -ne 0) { throw "Installed overlay E2E failed: $LASTEXITCODE" }

  $voiceRuns = 3
  if ($env:SKILLCUE_E2E_VOICE_RUNS) {
    $parsedRuns = 0
    if (-not [int]::TryParse($env:SKILLCUE_E2E_VOICE_RUNS, [ref]$parsedRuns) -or $parsedRuns -lt 1) {
      throw "SKILLCUE_E2E_VOICE_RUNS must be a positive integer"
    }
    $voiceRuns = $parsedRuns
  }
  1..$voiceRuns | ForEach-Object {
    Write-Host "Installed voice overlay E2E run $_/$voiceRuns"
    pnpm --filter @interview/desktop verify:dev:voice
    if ($LASTEXITCODE -ne 0) {
      throw "Installed voice overlay E2E run $_/$voiceRuns failed: $LASTEXITCODE"
    }
  }
} finally {
  Pop-Location
}
