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
} finally {
  Pop-Location
}
