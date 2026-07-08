# Выпуск релиза SkillCue

Как собрать установщик и опубликовать его, чтобы работали кнопка «Скачать» и
автообновление. Правила номеров версий — в `docs/VERSIONING.md`.

Архитектура: код в приватном `GalievGleb/interview`, установщики/релизы — в
публичном `GalievGleb/ScillCue` (`apps/desktop/package.json → build.publish`).

## Разовая настройка (один раз)

1. **PAT для публикации в ScillCue.** Встроенный `GITHUB_TOKEN` в CI имеет права
   только на `interview` — он НЕ сможет создать релиз в `ScillCue`. Создай
   персональный токен:
   - GitHub → Settings → Developer settings → Personal access tokens →
     Fine-grained token, доступ к репозиторию `GalievGleb/ScillCue`, право
     **Contents: Read and write**.
   - В репозитории `interview`: Settings → Secrets and variables → Actions →
     New secret, имя **`SCILLCUE_RELEASE_TOKEN`**, значение — этот PAT.
   Без него job публикации упадёт с 403/404.

2. **Репозиторий ScillCue** должен существовать (уже есть) и быть публичным,
   чтобы покупатели могли скачивать без авторизации.

3. **(после домена) Адрес гейтвея.** По умолчанию в сборку зашит
   `https://skill-cue.ru/v1` (`electron/main.ts → SKILLCUE_GATEWAY_URL`). Если
   собираешь до поднятия домена или на другом адресе — задай переменную окружения
   `SKILLCUE_GATEWAY_URL` перед сборкой.

## Выпуск версии

```bash
# 1. main зелёный (тесты/линт прошли).
# 2. Версия:
cd apps/desktop && npm version patch --no-git-tag-version   # 0.1.1 -> 0.1.2
# 3. CHANGELOG.md: перенеси пункты из [Unreleased] в новую версию.
git commit -am "chore(release): v0.1.2"
# 4. Тег строго = версии в package.json:
git tag v0.1.2
git push origin main --tags
```

Пуш тега `v*` запускает `.github/workflows/release.yml`:
1. PyInstaller собирает бэкенд + смоук `/health`.
2. `electron-builder --publish always` собирает установщик и **публикует релиз в
   `ScillCue`** (артефакты + `latest.yml` для автообновления).

## Проверка после релиза

- Релиз появился на `https://github.com/GalievGleb/ScillCue/releases` с `.exe` и
  `latest.yml`.
- Кнопка «Скачать» в боте и на лендинге (`…/ScillCue/releases/latest`) отдаёт файл.
- У установленной прошлой версии через несколько минут всплывает предложение
  обновиться (electron-updater читает `latest.yml` из ScillCue).

## Если публикация упала

- `403/404 при создании релиза` → нет/протух `SCILLCUE_RELEASE_TOKEN` или у PAT
  нет прав Contents:write на ScillCue.
- `tag уже существует` → релиз с этим тегом уже был; подними версию.
- Сборка бэкенда упала на hidden-imports → см. `apps/api-py/PACKAGING.md`.
- `Cannot compute electron version` → должно быть `build.electronVersion` в
  `apps/desktop/package.json` (иначе electron-builder не соберётся в pnpm-монорепо).

## TL;DR выпустить обновление (для будущих сессий / ИИ)

Одной командой из корня репозитория (дерево должно быть чистым, ветка `main`):

```
powershell -ExecutionPolicy Bypass -File scripts\release.ps1        # bump patch + tag + push
# или двойной клик: scripts\release.bat
```

Скрипт поднимает версию в `apps/desktop/package.json`, коммитит, ставит тег
`vX.Y.Z`, пушит — CI сам собирает и публикует установщик в `ScillCue`.
Мониторинг (если есть gh): `gh run watch <id>` — токен берётся из git credential:
`GH_TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')`.
Установщик называется стабильно `SkillCue-Setup.exe` (`nsis.artifactName`), релиз
публикуется сразу (`publish.releaseType: release`).

## Как сайт отдаёт установщик (ВАЖНО — почему «скачивалась старая версия»)

Кнопки «Скачать» на лендинге ведут на `/downloads/SkillCue-Setup.exe`. Раньше это
был **статический файл на сервере** (`/opt/skillcue/landing/downloads/…`), который
НЕ обновлялся при новом релизе → пользователи качали старую сборку.

Теперь в nginx стоит редирект (файл `/etc/nginx/sites-enabled/skillcue.conf`,
внутри HTTPS-server-блока):

```nginx
location = /downloads/SkillCue-Setup.exe {
    return 302 https://github.com/GalievGleb/ScillCue/releases/latest/download/SkillCue-Setup.exe;
}
```

То есть `skill-cue.ru/downloads/SkillCue-Setup.exe` всегда редиректит на **последний
релиз GitHub**. Копировать `.exe` на сервер вручную больше НЕ нужно. Лидбот
(`tools/leadbot/config.json → download_url`) уже указывает на тот же
`…/releases/latest/download/SkillCue-Setup.exe`. Проверка после релиза:
`curl -sIL https://skill-cue.ru/downloads/SkillCue-Setup.exe` → 302 → github → 200.

⚠️ Версия намеренно сброшена на `0.0.1` (перезапуск нумерации перед публичным
стартом). Авто-апдейт с более старших сборок (0.1.x) на 0.0.1 НЕ придёт — это ок,
реальной базы установок ещё нет; дальше катим 0.0.2, 0.0.3, …
