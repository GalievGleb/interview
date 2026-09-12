# Как самостоятельно собрать и выпустить SkillCue

Эта инструкция рассчитана на Windows PowerShell и репозиторий SkillCue.

## Главное различие

- **Stable** (`SkillCue`) — публичная версия. Получает обновления кнопкой в приложении из GitHub Releases репозитория `GalievGleb/SkillCue`.
- **Dev** (`SkillCue Dev`) — приватная тестовая сборка. Она специально собирается с `publish: null` и не обновляется публичной кнопкой. Новый Dev-установщик нужно установить вручную или скачать из GitHub Actions.
- **Alpha** (`SkillCue Alpha`) — отдельная экспериментальная сборка. Не выпускайте её пользователям как Stable.

У Dev и Alpha нет публичного автообновления: их новый отдельный установщик
устанавливается поверх соответствующего приложения без удаления данных. Кнопка
проверки в них объясняет канал, а не обещает загрузку из Stable. Для Alpha:

```powershell
pnpm --filter @interview/desktop dist:alpha
# После успешных тестов запустите apps\desktop\release-alpha\SkillCue-Alpha-Setup.exe
.\apps\api-py\.venv\Scripts\python.exe tools\verify_alpha_voice_sequence.py
```

Alpha-конфигурация сама берёт следующий patch: при версии исходников `0.1.13`
получится `0.1.14-alpha.g<commit>`. Не понижайте установленную `0.1.13-alpha` до
`0.1.12` ради совпадения с номером старой Stable. Проверенный установщик храните
вместе с SHA256 и исходным commit; не пересобирайте другие байты под тем же номером.

## Профили и Google-вход в Alpha

Профили включены сначала только в Alpha. Stable продолжает работать по прежней
лицензии, пока новый контур не пройдёт приёмку. Перед сборкой Alpha нужны две
публичные переменные:

```powershell
$env:SKILLCUE_ACCOUNT_API_URL = 'https://skill-cue.ru/account'
$env:SKILLCUE_GOOGLE_OAUTH_CLIENT_ID = '<Desktop OAuth client ID>'
```

Client ID не является секретом и встраивается в приложение. Секреты Resend,
ЮKassa, JWT и базы данных в установщик не попадают: они существуют только на
сервере. Google-вход использует системный браузер, PKCE и локальный callback
`127.0.0.1`; пароль Google приложение не видит.

Сервер профилей разворачивается отдельно от рабочего шлюза оверлея:

```powershell
py -3.12 apps/api/deploy/deploy.py --host 109.172.47.103 --with-account
```

Сценарий сам создаёт постоянные случайные серверные секреты в игнорируемом Git
файле, разворачивает PostgreSQL, применяет миграции и добавляет HTTPS-маршрут
`/account/`. Для первого запуска нужны локальные переменные `RESEND_API_KEY` и
`SKILLCUE_GOOGLE_OAUTH_CLIENT_ID`; секрет ЮKassa читается из уже настроенного
безопасного хранилища.

После создания отдельного проверенного тестового профиля запустите десятикратную
приёмку. Пароль передаётся только через переменную текущего PowerShell-сеанса и
не записывается в отчёт:

```powershell
$env:SKILLCUE_ACCEPTANCE_EMAIL = '<отдельная тестовая почта>'
$env:SKILLCUE_ACCEPTANCE_PASSWORD = '<временный тестовый пароль>'
.\apps\api-py\.venv\Scripts\python.exe tools\account_acceptance.py --register
.\apps\api-py\.venv\Scripts\python.exe tools\account_acceptance.py --repetitions 10
Remove-Item Env:SKILLCUE_ACCEPTANCE_PASSWORD -ErrorAction SilentlyContinue
```

Первый запуск с `--register` один раз попросит код из письма. Приёмка проверяет
вход, ротацию сессии, два разрешённых устройства, отказ третьему, отвязку
устройства и доступность подписки. Отчёт сохраняется в
`output/account-acceptance.json` без токенов и пароля.

GitHub workflows сейчас запускаются вручную (`workflow_dispatch`). Создание тега
само по себе не запускает сборку. Для публичного выпуска сначала проверьте
установщик со Stable-настройками и обычной лицензией, затем публикуйте именно этот
файл. Проверка успешного Dev/Alpha не заменяет проверку пользовательской Stable.

## Что установить один раз

1. Git.
2. Node.js и Corepack.
3. Python версии, поддерживаемой backend-проектом.
4. GitHub CLI: `gh`.
5. NSIS ставить отдельно обычно не нужно: его загружает `electron-builder`.

Проверка:

```powershell
git --version
node --version
corepack --version
python --version
gh --version
```

## Доступы и креды

Для локальной сборки установщика секреты обычно не нужны. Для публикации нужен GitHub-доступ к `GalievGleb/SkillCue`.

Авторизуйтесь интерактивно:

```powershell
gh auth login
gh auth status
```

Не записывайте GitHub-токены, OpenAI-ключи, ключи шлюза, SSH-ключи или содержимое production `.env` в этот файл, Git, команды с аргументами или логи. Если CI требует секрет, добавляйте его через GitHub → Settings → Secrets and variables → Actions.

Для `electron-builder --publish always` может понадобиться временная переменная `GH_TOKEN`. Получайте её из безопасного хранилища и удаляйте после команды:

```powershell
$env:GH_TOKEN = '<temporary GitHub token>'
# команда публикации
Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
```

Предпочтительный вариант ниже использует уже авторизованный `gh` и не требует помещать токен в команду.

## Подготовка исходников

```powershell
Set-Location C:\Users\gleb\Projects\SkillCue
git status --short
corepack enable
pnpm install --frozen-lockfile
```

Рабочее дерево перед релизом должно быть чистым. Не собирайте Stable из папки с экспериментальными или незакоммиченными изменениями: они попадут в приложение и backend.

## Версия и описание релиза

Для каждого публичного обновления увеличьте версию, например `0.1.12` → `0.1.13`, во всех релизных метаданных:

- `package.json`
- `apps/desktop/package.json`
- `apps/api/package.json`
- `packages/shared/package.json`
- `apps/api-py/pyproject.toml`
- `apps/api-py/app/main.py`
- начале массива в `apps/desktop/src/lib/releaseNotes.ts`
- новом разделе в `CHANGELOG.md`

Версия должна быть выше установленной — иначе автообновление её не предложит.

## Проверки перед сборкой

```powershell
node tools/verify_release_metadata.mjs . "v0.1.13"
pnpm --filter @interview/desktop test
pnpm --filter @interview/desktop typecheck
pnpm --filter @interview/desktop exec tsc -p tsconfig.electron.json --noEmit
pnpm --filter @interview/desktop lint
git diff --check
```

Если любая команда завершилась ошибкой, релиз не публикуйте.

## Сборка Stable

Команда собирает Python backend, renderer, Electron и NSIS-установщик:

```powershell
pnpm --filter @interview/desktop dist:full
```

После успешной сборки проверьте наличие файлов:

```powershell
Get-Item apps\desktop\release\SkillCue-Setup.exe
Get-Item apps\desktop\release\latest.yml
Get-Item apps\desktop\release\SkillCue-Setup.exe.blockmap
```

`latest.yml` и `.blockmap` обязательны для нормальной работы автообновления.

## Публикация Stable через GitHub CLI

Сначала закоммитьте и отправьте проверенные изменения:

```powershell
git add <только файлы этого релиза>
git commit -m "release: SkillCue 0.1.13"
git push origin HEAD
```

Создайте тег и релиз, подставив фактическую версию:

```powershell
$version = '0.1.13'
git tag "v$version"
git push origin "v$version"
gh release create "v$version" `
  apps/desktop/release/SkillCue-Setup.exe `
  apps/desktop/release/SkillCue-Setup.exe.blockmap `
  apps/desktop/release/latest.yml `
  --repo GalievGleb/SkillCue `
  --title "SkillCue $version" `
  --notes "Исправления и улучшения SkillCue $version."
```

Если релиз уже создан, загрузите файлы повторно только осознанно:

```powershell
gh release upload "v$version" `
  apps/desktop/release/SkillCue-Setup.exe `
  apps/desktop/release/SkillCue-Setup.exe.blockmap `
  apps/desktop/release/latest.yml `
  --repo GalievGleb/SkillCue --clobber
```

## Проверка опубликованного обновления

```powershell
gh release view "v$version" --repo GalievGleb/SkillCue
gh release download "v$version" --repo GalievGleb/SkillCue --pattern latest.yml --dir $env:TEMP
```

На компьютере с предыдущей Stable-версией:

1. Откройте SkillCue.
2. Нажмите проверку обновлений.
3. Убедитесь, что предлагается новая версия.
4. Установите её и проверьте номер в настройках.
5. Проверьте основной пользовательский сценарий, ради которого выпускался патч.

## Сборка Dev без публикации

```powershell
pnpm --filter @interview/desktop dist:dev
```

Установщик появится в `apps/desktop/release-dev`. Его нужно передавать и устанавливать вручную. Публичный Stable updater Dev-сборку не обслуживает.

## Безопасный откат

Не удаляйте предыдущий GitHub Release. Если новый релиз оказался неисправным:

1. Пометьте проблемный релиз как draft или удалите только его публикацию через GitHub.
2. Исправьте ошибку.
3. Выпустите следующую версию, например `0.1.14`; не пытайтесь заставить клиентов откатиться заменой `latest.yml` на меньшую версию.

Никогда не используйте `git reset --hard`, принудительный push или удаление production-секретов как часть обычного выпуска.
