<# Build the private, side-by-side SkillCue Dev installer without publishing it. #>
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

Write-Host "== SkillCue Dev build ==" -ForegroundColor Cyan
pnpm --filter '@interview/desktop' dist:dev
if ($LASTEXITCODE -ne 0) { throw "SkillCue Dev build failed." }

$installer = Join-Path $root 'apps\desktop\release-dev\SkillCue-Dev-Setup.exe'
if (-not (Test-Path -LiteralPath $installer)) {
  throw "Installer was not created: $installer"
}

Write-Host "Developer installer is ready:" -ForegroundColor Green
Write-Host $installer
Write-Host "This build is private and was not published." -ForegroundColor DarkGray
