# Версионирование и релизы SkillCue

Единая схема, чтобы номера версий были предсказуемыми, а автообновление
десктопа работало без ручной возни.

## 1. Схема номеров — SemVer (`MAJOR.MINOR.PATCH`)

`vMAJOR.MINOR.PATCH`, например `v0.4.2`. Смысл частей для нашего продукта:

| Часть | Когда увеличиваем | Примеры |
|-------|-------------------|---------|
| **MAJOR** | Ломающее изменение для пользователя: несовместимый формат лицензий, смена протокола live, переезд на новый гейтвей | `1.0.0` → `2.0.0` |
| **MINOR** | Новая функция без ломки: новый STT-движок, режим интервью, экран | `0.4.0` → `0.5.0` |
| **PATCH** | Багфиксы, тексты, мелкая полировка | `0.4.1` → `0.4.2` |

**Сейчас мы в `0.x`** — это официальный «бета/до-релизного» диапазон SemVer: до
`1.0.0` можно двигаться быстро, MINOR может нести и мелкую ломку. `1.0.0`
выпускаем, когда продукт стабилен и пошли платящие пользователи.

Правило разрешения споров: если сомневаешься между MINOR и PATCH — бери MINOR;
между MAJOR и MINOR в `0.x` — бери MINOR.

## 2. Один источник правды

Версия живёт в **`apps/desktop/package.json` → `"version"`**. Отсюда её берёт
electron-builder для сборки, имени установщика и `latest.yml` автообновления.
Git-тег обязан совпадать: `package.json = 0.4.2` ⇔ тег `v0.4.2`.

Бэкенд (`apps/api-py`) и гейтвей отдельных версий не имеют — их версия = версия
релиза десктопа, с которым они собраны.

## 3. Conventional Commits (уже используем)

Сообщения коммитов: `type(scope): описание`. Типы определяют, какую часть версии
двигать при следующем релизе:

- `feat:` → MINOR
- `fix:` → PATCH
- `docs:` / `chore:` / `refactor:` / `test:` → без бампа сами по себе
- `feat!:` или футер `BREAKING CHANGE:` → MAJOR

Примеры из истории репозитория: `feat(stt): …`, `fix(ui): …`, `docs(design): …`.

## 4. Как выпустить релиз (пошагово)

```bash
# 1. Убедись, что main зелёный (тесты/линт прошли).
# 2. Подними версию в apps/desktop/package.json (руками или npm version).
#    Пример для минорной:
cd apps/desktop && npm version minor --no-git-tag-version   # 0.4.2 -> 0.5.0

# 3. Обнови CHANGELOG.md (см. ниже), закоммить:
git commit -am "chore(release): v0.5.0"

# 4. Поставь тег ровно как версию и запушь тег:
git tag v0.5.0
git push origin main --tags
```

Пуш тега `v*` запускает `.github/workflows/release.yml`: собирает бэкенд
(PyInstaller), затем `electron-builder --publish always` → создаёт **GitHub
Release** с установщиком и `latest.yml`. Десктоп со встроенным `electron-updater`
сам подхватывает обновление (см. `setupAutoUpdater` в `electron/main.ts`).

## 5. Что должно совпадать (иначе автообновление сломается)

- `apps/desktop/package.json` version **==** git-тег (без `v` в package.json, с `v` в теге).
- **Раздельные репозитории (осознанно):** код — приватный `GalievGleb/interview`,
  релизы/установщики — публичный `GalievGleb/ScillCue`. Поэтому все три места
  должны указывать на `ScillCue`:
  - `apps/desktop/package.json → build.publish.repo = "ScillCue"` (сюда
    electron-builder публикует и отсюда electron-updater берёт обновления);
  - `download_url` лидбота (`tools/leadbot/config.json`) → `…/ScillCue/releases/latest`;
  - ссылки «Скачать» на лендинге → тот же `…/ScillCue/releases/latest`.
  - CI (`release.yml`) должен получать `GH_TOKEN` с правом публикации в `ScillCue`.

## 6. CHANGELOG.md

Держим человекочитаемый список в `CHANGELOG.md` в формате Keep a Changelog:
секции `Added / Changed / Fixed` под каждой версией. Заполняем при релизе из
коммитов между прошлым и новым тегом:

```bash
git log v0.4.2..HEAD --pretty="- %s"
```

## 7. Быстрая шпаргалка

```
Багфикс          → PATCH (0.4.1 → 0.4.2), коммиты fix:
Новая фича        → MINOR (0.4.2 → 0.5.0), коммиты feat:
Ломка/1.0         → MAJOR, feat!: или BREAKING CHANGE
Релиз             → бамп package.json → тег vX.Y.Z → git push --tags → CI сам публикует
```
