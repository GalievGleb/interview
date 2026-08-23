<#
  Release a new SkillCue version with one command.

  Steps:
    1. Verify you are on main with a clean working tree.
    2. Bump the version in apps/desktop/package.json (patch by default).
    3. Commit, tag vX.Y.Z, push main + tag.
    4. The tag triggers GitHub Actions (release.yml): build backend + installer
       and publish to GalievGleb/SkillCue (the Download button gets the new build).

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts\release.ps1            # patch: 0.0.40 -> 0.0.41
    powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Bump minor
    powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Watch     # also wait for CI

  Easiest: double-click scripts\release.bat
#>
param(
  [ValidateSet('patch', 'minor', 'major')]
  [string]$Bump = 'patch',
  [switch]$Watch
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

Write-Host "== SkillCue release ==" -ForegroundColor Cyan

# 1. Must be on main with a clean tree
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'main') { throw "Must be on branch main (current: $branch)." }
if (git status --porcelain) {
  throw "Uncommitted changes present. Commit or stash them before releasing."
}

# Fast-forward main so the tag matches origin
git pull --ff-only origin main | Out-Null

# 2. Bump version
Push-Location apps/desktop
$ver = (npm version $Bump --no-git-tag-version).Trim()   # prints vX.Y.Z
Pop-Location
Write-Host "New version: $ver" -ForegroundColor Green

# 3. Commit + tag + push
git add apps/desktop/package.json
git commit -m "chore(release): $ver" | Out-Null
git tag $ver
git push origin main --tags
Write-Host "Pushed. CI is building the installer and publishing to SkillCue." -ForegroundColor Green
Write-Host "Releases: https://github.com/GalievGleb/SkillCue/releases"

# 4. Optionally wait for CI when gh is installed
if ($Watch) {
  $gh = Get-Command gh -ErrorAction SilentlyContinue
  if (-not $gh) {
    Write-Host "gh not installed - skipping wait. Check the Actions tab for status." -ForegroundColor Yellow
    return
  }
  Write-Host "Waiting for the build to finish (a few minutes)..." -ForegroundColor Cyan
  Start-Sleep -Seconds 8
  $rid = (& gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId' 2>$null)
  if ($rid) { & gh run watch $rid --exit-status --interval 25 }
}
