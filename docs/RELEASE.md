# Выпуск релиза SkillCue

Как собрать установщик и опубликовать его, чтобы работали кнопка «Скачать» и
автообновление. Правила номеров версий — в `docs/VERSIONING.md`.

Архитектура: код в приватном `GalievGleb/interview`, установщики/релизы — в
публичном `GalievGleb/SkillCue` (`apps/desktop/package.json → build.publish`).

## Два независимых приложения: Dev и Stable

На компьютере разработчика могут одновременно стоять две версии:

| Параметр | SkillCue Dev | SkillCue (Stable) |
|---|---|---|
| Windows App ID | `com.interview.assistant.dev` | `com.interview.assistant` |
| Данные | `%APPDATA%/SkillCue Dev` | прежняя пользовательская папка без миграции |
| Локальный backend | `127.0.0.1:8001` | `127.0.0.1:8000` |
| Deep link | `skillcue-dev://` | `skillcue://` |
| Автообновление | всегда выключено | включено из публичного GitHub Release |
| Установщик | `release-dev/SkillCue-Dev-Setup.exe` | `release/SkillCue-Setup.exe` |

Собрать приватную версию можно двойным кликом по `scripts/dev-build.bat` или
командой из корня репозитория:

```powershell
pnpm dist:desktop:dev
```

Dev-сборка получает номер следующего патча с commit SHA, например
`0.0.26-dev.g58e98d21`. Она не загружается в GitHub Releases и не меняет ссылку
для пользователей. В GitHub Actions тот же установщик можно получить ручным
запуском workflow **SkillCue Dev build**; файл хранится как приватный Actions
artifact 14 дней.

По умолчанию Dev использует `Ctrl+Shift+D` для оверлея и `Ctrl+Shift+Enter` для
принудительного ответа, чтобы не конфликтовать с одновременно запущенной Stable.
Секреты API Dev и Stable лежат в разных записях Windows Credential Manager.

Публичный выпуск остаётся отдельным сознательным действием: после проверки Dev
запусти `scripts/release.bat` или `scripts/release.ps1`. Только созданный им тег
`vX.Y.Z` запускает публикацию и меняет публичную ссылку/автообновление.

## Разовая настройка (один раз)

1. **PAT для публикации в SkillCue.** Встроенный `GITHUB_TOKEN` в CI имеет права
   только на `interview` — он НЕ сможет создать релиз в `SkillCue`. Создай
   персональный токен:
   - GitHub → Settings → Developer settings → Personal access tokens →
     Fine-grained token, доступ к репозиторию `GalievGleb/SkillCue`, право
     **Contents: Read and write**.
   - В репозитории `interview`: Settings → Secrets and variables → Actions →
     New secret, имя **`SCILLCUE_RELEASE_TOKEN`**, значение — этот PAT.
   Без него job публикации упадёт с 403/404.

2. **Репозиторий SkillCue** должен существовать (уже есть) и быть публичным,
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
   `SkillCue`** (артефакты + `latest.yml` для автообновления).

## Проверка после релиза

- Релиз появился на `https://github.com/GalievGleb/SkillCue/releases` с `.exe` и
  `latest.yml`.
- Кнопка «Скачать» в боте и на лендинге (`…/SkillCue/releases/latest`) отдаёт файл.
- У установленной прошлой версии через несколько минут всплывает предложение
  обновиться (electron-updater читает `latest.yml` из SkillCue).

## Если публикация упала

- `403/404 при создании релиза` → нет/протух `SCILLCUE_RELEASE_TOKEN` или у PAT
  нет прав Contents:write на SkillCue.
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
`vX.Y.Z`, пушит — CI сам собирает и публикует установщик в `SkillCue`.
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
    return 302 https://github.com/GalievGleb/SkillCue/releases/latest/download/SkillCue-Setup.exe;
}

location = /downloads/SkillCue-macOS-arm64.dmg {
    return 302 https://github.com/GalievGleb/SkillCue/releases/latest/download/SkillCue-macOS-arm64.dmg;
}

location = /downloads/SkillCue-macOS-x64.dmg {
    return 302 https://github.com/GalievGleb/SkillCue/releases/latest/download/SkillCue-macOS-x64.dmg;
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
