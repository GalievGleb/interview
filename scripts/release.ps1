<#
  Выпуск новой версии SkillCue одной командой.

  Что делает:
    1. Проверяет, что вы на ветке main и нет незакоммиченных изменений.
    2. Поднимает версию в apps/desktop/package.json (patch по умолчанию).
    3. Коммитит, ставит тег vX.Y.Z и пушит main + тег.
    4. Тег запускает GitHub Actions (release.yml): сборка backend + установщика
       и публикация в GalievGleb/ScillCue (кнопка «Скачать» получает новую версию).

  Запуск:
    powershell -ExecutionPolicy Bypass -File scripts\release.ps1           # patch: 0.1.5 -> 0.1.6
    powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Bump minor
    powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Watch    # ещё и дождаться CI

  Проще: двойной клик по scripts\release.bat
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

# 1. Ветка main и чистое рабочее дерево
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'main') { throw "Нужно быть на ветке main (сейчас: $branch)." }
if (git status --porcelain) {
  throw "Есть незакоммиченные изменения. Закоммитьте их (или спрячьте), потом запускайте релиз."
}

# Свежий main, чтобы тег не разошёлся с origin
git pull --ff-only origin main | Out-Null

# 2. Поднять версию
Push-Location apps/desktop
$ver = (npm version $Bump --no-git-tag-version).Trim()   # печатает vX.Y.Z
Pop-Location
Write-Host "Новая версия: $ver" -ForegroundColor Green

# 3. Коммит + тег + пуш
git add apps/desktop/package.json
git commit -m "chore(release): $ver" | Out-Null
git tag $ver
git push origin main --tags
Write-Host "Запушено. CI собирает установщик и публикует в ScillCue." -ForegroundColor Green
Write-Host "Релизы: https://github.com/GalievGleb/ScillCue/releases"

# 4. (опционально) дождаться CI, если установлен gh
if ($Watch) {
  $gh = Get-Command gh -ErrorAction SilentlyContinue
  if (-not $gh) {
    Write-Host "gh не установлен — пропускаю ожидание. Статус смотрите в Actions." -ForegroundColor Yellow
    return
  }
  Write-Host "Жду завершения сборки (несколько минут)..." -ForegroundColor Cyan
  Start-Sleep -Seconds 8
  $rid = (& gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId' 2>$null)
  if ($rid) { & gh run watch $rid --exit-status --interval 25 }
}
