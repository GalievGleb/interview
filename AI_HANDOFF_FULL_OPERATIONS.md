# SkillCue: полный handoff для другой ИИ

> Назначение: дать другой ИИ достаточно контекста, чтобы безопасно работать с
> репозиторием, собирать и устанавливать локальную Dev-версию, делать GitHub push,
> выпускать Stable-релизы и обслуживать gateway.
>
> Этот файл **не содержит значений секретов**. Никогда не проси ИИ копировать
> токены, ключи или пароли в чат, командную строку, Git, отчёт или лог. Секреты
> должны читаться только из защищённого хранилища/окружения непосредственно тем
> процессом, которому они нужны.

## 0. Инструкция для ИИ — прочитать первой

Рабочая папка:

```text
C:\Users\gleb\Projects\SkillCue
```

Перед любыми действиями:

1. Прочитай `CLAUDE.md`, `README.md`, `SECURITY.md`, `docs/RELEASE.md`,
   `docs/VERSIONING.md`, этот файл и релевантные `AGENTS.md`, если они появятся.
2. Выполни `git status --short`, `git branch --show-current`, `git remote -v`.
3. Считай все существующие изменения собственностью пользователя. Ничего не
   сбрасывай, не удаляй и не перезаписывай ради «чистоты».
4. Не выполняй `git reset --hard`, `git clean -fd`, `git checkout -- .`,
   `git restore .`, force-push или рекурсивное удаление рабочей папки.
5. Не делай `git add .`: сначала составь точный список файлов текущей задачи и
   проверь их diff. В дереве могут одновременно находиться изменения нескольких
   задач.
6. Не коммить и не пушь, пока пользователь явно не разрешил push/commit либо
   текущий запрос прямо не требует этого.
7. Не запускай production deploy только потому, что пользователь сказал «push».
   Git push, Stable release и server deploy — три разных действия.
8. Перед утверждением «готово» запусти релевантные тесты и покажи их фактический
   результат. Не маскируй упавший gate.

## 1. Карта проекта

- Приватный репозиторий исходников: `GalievGleb/interview`.
- Локальный remote `origin`: `https://github.com/GalievGleb/interview.git`.
- Основная ветка: `main`.
- Публичный репозиторий установщиков/автообновлений:
  `GalievGleb/SkillCue`.
- Desktop: `apps/desktop` — Electron + React + TypeScript.
- Рабочий backend desktop: `apps/api-py` — FastAPI/Python, пакуется PyInstaller.
- Gateway/billing: `apps/api` — Node/TypeScript; это отдельный серверный слой.
- Stable installer публикуется в публичный `SkillCue`, а исходники остаются в
  приватном `interview`.
- Требования: Node `>=22.13`, Python `>=3.11` (на этой машине используется 3.12),
  `pnpm@11.21.0`.

## 2. Текущая важная продуктовая граница

В коде присутствует новый typed/structured screen pipeline, но он намеренно
оставлен за выключенным rollout-флагом:

```text
STRUCTURED_SCREEN_ROLLOUT_READY=false
```

Фактический статус на 2026-09-02:

- stable/production не могут включить typed path даже hostile client-полем;
  backend дополнительно требует `SKILLCUE_BUILD_CHANNEL=dev`;
- desktop разрешает typed path только для `development`/`devbuild`, но rollout
  пока false;
- legacy path остаётся поведением по умолчанию и отдельно покрыт тестами;
- typed state хранится только в памяти renderer, имеет TTL/epoch ownership и не
  должен попадать в SQLite, localStorage или privacy-safe отчёты;
- pipeline уже разделяет экран на typed observation, bounded ledger,
  deterministic merge, answer validation и максимум один repair;
- analysis/find-defect показывается только из application-owned ledger, без
  второго генеративного synthesis-вызова;
- узкий общий профиль «одна Python-функция, один SELECT по одному ID,
  `list[dict]`» компонуется приложением и затем проходит тот же validator;
- checklist имеет строгий count/scope/novelty gate и отдельный bounded budget.

Но включать rollout **нельзя**. Последний обязательный live gate:

```text
output/verification/real-interview-overlay/screen-live-structured-3x3-fix10.json
```

дал `5/9 PASS`: checklist `3/3`, SQL `2/3`, GitLab multi-frame `0/3`.
GitLab сохранял 7–11 findings в typed state, но semantic gate не подтвердил
обязательные prior/current defect conclusions. Одна SQL-попытка не попала в
строгий deterministic profile и завершилась `invalid_screen_answer`. Это
настоящий NO-GO, а не повод повторять suite до случайного зелёного результата.
Предшествующий single-run `screen-live-structured-one-fix10.json` был `3/3`, но
он не отменяет провал 3×3.

До Dev-активации другая ИИ должна строгими RED→GREEN тестами закрыть именно эти
две причины, затем получить новый single `3/3` и новый независимый `3×3 = 9/9`.
Только после этого можно поставить rollout true, собрать/установить **только
SkillCue Dev** и выполнить installed-Dev new→continue smoke. Stable, публичный
release и production server для этого не трогать.

Typed core и часть тестов сейчас могут быть untracked. Перед commit обязательно
проверить `git status --short` и явно добавить все новые `screen_task_*`,
`screen_answer_validator*`, desktop screen state/runtime/coordinator modules и
их тесты. Не считать clean checkout воспроизводимым, пока эти файлы не tracked.

## 3. Где находятся секреты и как с ними обращаться

### Никогда не делать

- Не вставлять значения секретов в этот файл, README, `.env.example`, issue,
  commit message, PR, shell history или ответ ИИ.
- Не выполнять команды, которые печатают весь `env`, весь Credential Manager,
  keyring, `gateway.env` или Git credential.
- Не передавать секрет через CLI-аргумент: аргументы видны другим процессам.
- Не коммитить `.env`, `gateway.env`, `.admin_secret`, `.license_signing_key`,
  приватные ключи, SQLite с идентичностью/лицензией или временные live reports с
  сырыми ответами.
- Не вшивать OpenAI/OpenRouter ключ издателя в desktop installer.

### Локальный Windows Dev

- Provider keys хранятся через Python `keyring`/Windows Credential Manager.
- Dev и Stable используют отдельные записи secure storage.
- OAuth/пароли HH хранятся через Electron `safeStorage`.
- Для временного live-процесса секрет можно передать через переменную окружения
  родительского процесса, не печатать и удалить в `finally`/после команды:

```powershell
$env:OPENAI_API_KEY = '<получить безопасно, не печатать>'
try {
  # одна разрешённая команда
} finally {
  Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
}
```

### GitHub Actions secrets

В приватном репозитории `GalievGleb/interview` используются:

- `SCILLCUE_RELEASE_TOKEN` — **имя намеренно написано именно так**, с `SCI...`.
  Это fine-grained PAT к публичному `GalievGleb/SkillCue` с правом
  `Contents: Read and write`. Не переименовывать без одновременного изменения
  workflow.
- `SKILLCUE_OPENAI_API_KEY` — только для приватного Dev build workflow, если он
  действительно нужен выбранному workflow. Никогда не помещать его в artifact.
- `GITHUB_TOKEN` — автоматически выдаётся GitHub Actions; вручную не создавать.

Проверять только наличие имён, не значения:

```powershell
gh secret list --repo GalievGleb/interview
```

Если `gh` не авторизован:

```powershell
gh auth status
gh auth login
```

Авторизацию проходит пользователь интерактивно. ИИ не должна просить PAT в чат.

### Production gateway: `/opt/skillcue/gateway.env`

Файл на сервере должен иметь mode `600`; значения не выводить. Основные имена:

- `GATEWAY_PORT`, `REDIS_URL`
- `OPENROUTER_API_KEY`
- `GATEWAY_UPSTREAM_BASE`, `GATEWAY_UPSTREAM_STYLE`
- `OPENAI_API_KEY`, `OPENAI_STT_BASE_URL` — STT
- `OPENAI_CHAT_API_KEY`, `OPENAI_CHAT_BASE_URL`, `OPENAI_CHAT_REQUIRED` — отдельный
  direct-chat/screen бюджет
- `GATEWAY_ADMIN_SECRET`
- `LICENSE_PRIVATE_KEY_HEX`, опционально `LICENSE_PUBLIC_KEY_HEX`
- `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY`, `YOOKASSA_RETURN_URL`
- возможные лимиты `GATEWAY_STT_SECONDS_*`, model allow/block lists и иные уже
  существующие переменные

При миграции env надо сохранять **все неизвестные текущие строки и секреты**,
менять только явно названные ключи, сохранять владельца и mode. Полный
`apps/api/deploy/deploy.py` нельзя запускать вслепую: он способен построить env из
неполного локального набора и затереть серверные значения.

Приватный ключ лицензии локально: `apps/api-py/.license_signing_key` — игнорируется
Git. Потеря делает выпуск старой линии ключей невозможным, утечка компрометирует
лицензии. Его резервная копия должна быть в password manager/offline vault.

Code signing, если подключён:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`

Их задают только в защищённой CI-среде; не хранить в репозитории.

## 4. Начальная установка зависимостей

Из корня:

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @interview/shared build

py -3.12 -m venv apps\api-py\.venv
apps\api-py\.venv\Scripts\python.exe -m pip install -r apps\api-py\requirements.txt
apps\api-py\.venv\Scripts\python.exe -m pip install -r apps\api-py\requirements-dev.txt
```

Если `.venv` уже существует, не пересоздавать без причины.

## 5. Обычная работа с Git и GitHub

### Перед изменением

```powershell
Set-Location C:\Users\gleb\Projects\SkillCue
git branch --show-current
git status --short
git fetch origin --prune
git log --oneline --decorate -10
```

Если рабочее дерево грязное, не делать `git pull --rebase` автоматически. Сначала
понять, чьи изменения, и закончить/зафиксировать текущую работу. Не использовать
stash без явного согласия пользователя: он скрывает общие изменения.

### Безопасный commit

```powershell
git diff -- path\to\file1 path\to\file2
git diff --check -- path\to\file1 path\to\file2
git add -- path\to\file1 path\to\file2
git diff --cached --stat
git diff --cached
git commit -m "fix(scope): краткое описание"
```

Conventional commits:

- `fix:` — исправление;
- `feat:` — функция;
- `test:`, `docs:`, `refactor:`, `chore:` — соответствующий тип;
- `feat!:`/`BREAKING CHANGE:` — ломающее изменение.

Перед push:

```powershell
git status --short
git log --oneline origin/main..HEAD
git push origin main
```

Если push отклонён из-за новых remote commits — остановиться, изучить расхождение,
не force-push. Для просмотра CI:

```powershell
gh run list --repo GalievGleb/interview --limit 10
gh run watch <RUN_ID> --repo GalievGleb/interview
```

### Что проверить на утечки перед commit

```powershell
git diff --cached --name-only
git diff --cached | Select-String -Pattern 'sk-[A-Za-z0-9_-]{12,}|sk-or-|ghp_|github_pat_|BEGIN .*PRIVATE KEY|GATEWAY_ADMIN_SECRET=.+|YOOKASSA_SECRET_KEY=.+'
```

Совпадение не всегда означает утечку (пример может быть заглушкой), но commit надо
остановить и проверить вручную. Не печатать найденное значение в ответ.

## 6. Локальная Dev-сборка — только компьютер владельца

Dev и Stable независимы:

| | Dev | Stable |
|---|---|---|
| App ID | `com.interview.assistant.dev` | `com.interview.assistant` |
| Данные | `%APPDATA%\SkillCue Dev` | отдельная папка Stable |
| Backend | `127.0.0.1:8001` | `127.0.0.1:8000` |
| Protocol | `skillcue-dev://` | `skillcue://` |
| Auto-update | выключен | GitHub Release |
| Installer | `release-dev\SkillCue-Dev-Setup.exe` | `release\SkillCue-Setup.exe` |

Полный локальный pipeline:

```powershell
Set-Location C:\Users\gleb\Projects\SkillCue
pnpm --filter @interview/desktop release:dev:verified
```

Он собирает backend + desktop, устанавливает Dev и запускает обязательный smoke
установленного backend.

Если silent installer завис, сначала убедиться, что старая Dev закрыта. Завершать
можно только процессы с точным установленным путём:

```powershell
$devRoot = "$env:LOCALAPPDATA\Programs\skillcue-dev"
Get-CimInstance Win32_Process |
  Where-Object { $_.ExecutablePath -like "$devRoot*" } |
  Select-Object ProcessId, Name, ExecutablePath
```

После проверки точных путей закрыть приложение штатно; `Stop-Process -Force`
использовать только как последний вариант для этих конкретных PID. Затем:

```powershell
& .\apps\desktop\release-dev\SkillCue-Dev-Setup.exe /S
pnpm --filter @interview/desktop verify:dev:overlay
```

Установленное приложение:

```text
%LOCALAPPDATA%\Programs\skillcue-dev\SkillCue Dev.exe
```

Обязательное правило `CLAUDE.md`: если менялся backend, routing, overlay, prompts,
license, packaging или update, без успешного `verify:dev:overlay` нельзя называть
Dev готовой к интервью. Если ответ приложения корректный, но verifier падает из-за
encoding/слишком узкого semantic matcher, исправить verifier тестами и повторить
gate; не объявлять падение «зелёным» молча.

Полезные дополнительные проверки:

```powershell
pnpm --filter @interview/desktop verify:dev:ui
pnpm --filter @interview/desktop verify:dev:voice
pnpm --filter @interview/desktop verify:dev:screen
```

## 7. Минимальные тесты перед push

Подбирай проверки по изменённым файлам, но перед крупным push рекомендуемый набор:

```powershell
# Desktop
pnpm --filter @interview/desktop test
pnpm --filter @interview/desktop typecheck
pnpm --filter @interview/desktop lint
pnpm --dir apps/desktop exec tsc --noEmit -p tsconfig.electron.json

# Python API
Set-Location apps\api-py
.venv\Scripts\python.exe -m pytest -q
.venv\Scripts\python.exe -m ruff check .
.venv\Scripts\python.exe -m ruff format --check .
Set-Location ..\..

# Gateway, если он менялся
Set-Location apps\api
pnpm build
$gatewayTests = Get-ChildItem -LiteralPath 'dist/gateway' -Filter '*.test.js' |
  ForEach-Object { $_.FullName }
node --test $gatewayTests
pnpm exec tsc -p tsconfig.gateway.json --noEmit
py -m pytest deploy/test_deploy_env.py deploy/test_provider_health.py -q
Set-Location ..\..

git diff --check
```

Не запускать платные live suites без явной необходимости/разрешения. Для live
использовать только санитизированные fixtures и privacy-safe reports.

## 8. Приватный Dev artifact в GitHub Actions

Workflow: `.github/workflows/dev-build.yml`. Запускается вручную и хранит Dev
installer как приватный Actions artifact; это **не** публичный release.

```powershell
gh workflow run dev-build.yml --repo GalievGleb/interview
gh run list --workflow dev-build.yml --repo GalievGleb/interview --limit 5
gh run watch <RUN_ID> --repo GalievGleb/interview
```

Скачивание artifact:

```powershell
gh run download <RUN_ID> --repo GalievGleb/interview --dir output\dev-artifact
```

## 9. Stable release и GitHub публикация

Это отдельное действие с публичными последствиями. Выполнять только после явного
запроса «выпусти Stable/public release».

Источник версии: `apps/desktop/package.json -> version`. Git tag обязан совпадать:
`0.1.11` ↔ `v0.1.11`.

Перед релизом:

1. Рабочее дерево чистое.
2. `main` синхронизирован и CI зелёный.
3. Полный Dev build установлен и mandatory overlay smoke успешен.
4. `CHANGELOG.md` обновлён.
5. `SCILLCUE_RELEASE_TOKEN` присутствует в GitHub Actions.

Стандартный скрипт из корня:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release.ps1
```

Он повышает patch, создаёт release commit/tag и push. Перед запуском прочитать сам
скрипт и убедиться, что он соответствует требуемому bump. Ручной вариант:

```powershell
Set-Location apps\desktop
npm version patch --no-git-tag-version
Set-Location ..\..
# обновить CHANGELOG.md
git add -- apps/desktop/package.json CHANGELOG.md
git commit -m "chore(release): vX.Y.Z"
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

Tag `v*` запускает `.github/workflows/release.yml`; electron-builder публикует в
`GalievGleb/SkillCue`:

- `SkillCue-Setup.exe`
- `latest.yml`
- macOS artifacts, если job настроен и прошёл

Проверка:

```powershell
gh run list --workflow release.yml --repo GalievGleb/interview --limit 5
gh release view vX.Y.Z --repo GalievGleb/SkillCue
curl.exe -sIL https://skill-cue.ru/downloads/SkillCue-Setup.exe
```

Ожидается redirect на
`https://github.com/GalievGleb/SkillCue/releases/latest/download/SkillCue-Setup.exe`.
Копировать `.exe` вручную на production web server не нужно.

Если release упал:

- `403/404` — проверить наличие/права/срок `SCILLCUE_RELEASE_TOKEN`;
- tag существует — не перезаписывать; поднять версию;
- PyInstaller hidden import — читать `apps/api-py/PACKAGING.md`;
- electron version — проверить `build.electronVersion` в desktop package.

## 10. Production gateway — только отдельный согласованный deploy

SSH alias в существующей инфраструктуре обычно `skillcue-pi`, рабочий root на
сервере `/opt/skillcue`, service `skillcue-gateway`. Перед использованием
проверить, что alias относится к правильному серверу, без печати credential.

**Не выполнять полный bundle deploy автоматически.** Исторически он мог:

- построить неполный `gateway.env` и стереть неизвестные секреты;
- заменить hardened systemd unit более слабым;
- затронуть landing/leadbot/Redis/node_modules, хотя менялся только gateway.

Безопасный принцип — surgical rollout только конкретных проверенных gateway
файлов, с серверной резервной копией и автоматическим rollback. До deploy:

```powershell
Set-Location C:\Users\gleb\Projects\SkillCue\apps\api
pnpm build
$gatewayTests = Get-ChildItem -LiteralPath 'dist/gateway' -Filter '*.test.js' |
  ForEach-Object { $_.FullName }
node --test $gatewayTests
pnpm exec tsc -p tsconfig.gateway.json --noEmit
py -m pytest deploy/test_deploy_env.py deploy/test_provider_health.py -q
```

На сервере перед заменой создать root-only backup (mode 0700) как минимум для:

- `/opt/skillcue/gateway.env`
- gateway source TS
- compiled gateway JS
- `provider_health.py`
- `/etc/systemd/system/skillcue-gateway.service`

Env мигрировать атомарно, сохраняя unknown keys, владельца и mode. Перед restart
новый `provider_health.py` должен подтвердить upstream route. После установки:

```bash
node --check <compiled-gateway-js>
systemctl restart skillcue-gateway
systemctl is-active --quiet skillcue-gateway
curl -fsS http://127.0.0.1:8787/health >/dev/null
```

Route truth после deploy должна быть подтверждена не только полем `done.model`, а
реальным resolver/upstream probe:

- Qwen `qwen/qwen3.5-flash-02-23` → OpenRouter style `openrouter`, model ID не
  переписан;
- Max screen `openai/gpt-5.6-sol` с валидным текущим PNG → direct OpenAI,
  `gpt-5.6-sol`;
- direct screen не должен наследовать STT custom base;
- fallback на OpenRouter разрешён только если model allowlist это допускает;
- trial/basic не получают дорогой Max route.

Rollback при любом failure: восстановить пять файлов из timestamped backup,
`daemon-reload` только если менялся unit, restart, затем `/health`. Backup не
удалять до прохождения WAV/screen/soak acceptance.

Значение `OPENAI_CHAT_API_KEY` желательно должно быть отдельным от STT. Копия
legacy `OPENAI_API_KEY` функционально работает, но объединяет quota/rate/billing
failure domain и не считается настоящей изоляцией.

## 11. Лицензии

Лицензионный ключ выпускается gateway admin endpoint; admin secret нельзя
печатать. Общая форма (значения получает shell из безопасного server env):

```bash
curl -X POST https://<gateway-host>/gateway/issue \
  -H "x-admin-secret: $GATEWAY_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"email":"buyer@example.com","plan":"max","days":30}'
```

Ответ содержит пользовательский `SKILLCUE-...` license key — это credential
покупателя; передавать только ему по согласованному защищённому каналу, не
коммитить и не публиковать.

## 12. Rollback Git/релиза

- Никогда не переписывать опубликованный tag.
- Для ошибочного commit в `main` использовать новый `git revert <sha>`, проверить
  тесты и push revert commit.
- Для плохого Stable release выпустить следующий patch с исправлением. Удаление
  release/tag ломает воспроизводимость и автообновление и требует отдельного
  явного решения владельца.
- Для локальной Dev просто установить предыдущий сохранённый installer; AppData
  при uninstall по конфигурации не удаляется.
- Для gateway использовать только серверную timestamped backup, а не считать Git
  commit полной копией живого server state.

## 13. Definition of Done для другой ИИ

ИИ может сказать «готово» только если сообщает:

1. Какие именно файлы изменены.
2. Какие тесты запускались и их точные результаты.
3. Был ли сделан commit (SHA), push (ветка), tag/release.
4. Была ли установлена локальная Dev и прошёл ли mandatory installed smoke.
5. Был ли затронут production/server (по умолчанию — нет).
6. Какие известные ограничения остались.
7. Что секреты не выводились, не сохранялись в артефакты и не попали в Git.

Нельзя объединять статусы. Примеры честных формулировок:

- «Код и тесты готовы, push не выполнялся».
- «Dev установлена, но mandatory smoke упал на verifier encoding — сборка пока
  формально не верифицирована».
- «Commit запушен в private main; публичный release и production deploy не
  выполнялись».
- «Gateway deploy выполнен и health зелёный, но paid live acceptance ещё не
  пройден — production route не объявляется полностью принятым».

## 14. Короткий стартовый prompt для новой ИИ

Скопируй ей этот текст (без секретов):

```text
Работай в C:\Users\gleb\Projects\SkillCue. Сначала полностью прочитай
AI_HANDOFF_FULL_OPERATIONS.md, CLAUDE.md, SECURITY.md и docs/RELEASE.md, затем
покажи git status/branch/remotes. Сохраняй все существующие изменения; запрещены
reset/clean/force-push и git add . Не печатай и не копируй секреты. Git push,
локальная Dev-установка, Stable release и production gateway deploy — отдельные
действия, каждое требует явного scope. Новый STRUCTURED_SCREEN_ROLLOUT_READY
оставляй false, пока новый structured live gate не даст 3/3, а затем 9/9.
Текущий screen-live-structured-3x3-fix10.json дал только 5/9 и является NO-GO. Для любого
исправления используй RED→GREEN тесты; перед завершением запусти релевантные
полные gates и сообщи точные результаты.
```
