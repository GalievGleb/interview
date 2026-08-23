# Однокомандный деплой лендинга SkillCue на прод (skill-cue.ru).
#
# Использование:  pwsh scripts/deploy-landing.ps1
#
# Что делает:
#   1. Пакует папку landing/ (без DEPLOY.md) в tar.gz.
#   2. По SSH кладёт её на skillcue-pi и распаковывает в /var/www/skillcue.
#   3. Проверяет живой сайт (главная + sitemap).
#
# Требования: SSH-алиас skillcue-pi в ~/.ssh/config (см. apps/api/deploy/README.md).

$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
$landing = Join-Path $repo "landing"
$archive = Join-Path $env:TEMP "skillcue-landing.tgz"

if (-not (Test-Path $landing)) { throw "Не найдена папка landing/ рядом со скриптом" }

# 1) пакуем (без служебного DEPLOY.md)
if (Test-Path $archive) { Remove-Item $archive }
tar -C $landing --exclude=DEPLOY.md -czf $archive .
Write-Host "Упаковано: $((Get-Item $archive).Length) байт" -ForegroundColor DarkGray

# 2) отправляем и распаковываем
scp -o BatchMode=yes $archive "skillcue-pi:/tmp/skillcue-landing.tgz"
ssh -o BatchMode=yes skillcue-pi "sudo tar -C /var/www/skillcue -xzf /tmp/skillcue-landing.tgz && rm /tmp/skillcue-landing.tgz && echo 'Файлы на сервере'"

# 3) проверяем живой сайт через публичный домен
Start-Sleep -Seconds 2
$main = curl.exe -s -o NUL -w "%{http_code}" --max-time 25 "https://skill-cue.ru/"
$sitemap = curl.exe -s --max-time 25 "https://skill-cue.ru/sitemap.xml"
$urls = ([regex]::Matches($sitemap, '<loc>')).Count
if ($main -eq "200" -and $urls -ge 20) {
  Write-Host "ДЕПЛОЙ ОК: главная 200, sitemap содержит $urls URL" -ForegroundColor Green
} else {
  Write-Host "ПРОВЕРКА НЕ ПРОШЛА: main=$main, sitemap urls=$urls — разберись вручную (ssh skillcue-pi)" -ForegroundColor Red
  exit 1
}
