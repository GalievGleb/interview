# SkillCue — полный аудит проекта

Метод: 5 независимых параллельных аудитов (безопасность, FastAPI-бэкенд, Electron main, React-рендерер, релизная инженерия) + перекрёстная проверка ключевых файлов. Все находки подтверждены ссылками на код. Только чтение, ничего не изменялось.

---

## 0. Статус исправлений

Ведётся работа по устранению находок. Фактурная модель продукта зафиксирована владельцем:
**STT — облачный OpenAI (локального ИИ нет)**, бэкенд пакуется PyInstaller, релизы через GitHub,
есть сайт `landing/` и отдельное Dev-приложение, обновляющееся вместе с версиями.

Исправлено и проверено тестами:

- ✅ **C1** await в managed-gateway STT + regression-тест (`openai_transcribe.py`).
- ✅ **C2** deep-link контракт: инсталлятор теперь регистрирует `skillcue://` (`package.json` protocols), `.env.example` синхронизирован; сайт уже генерировал правильные ссылки.
- ✅ **C3** per-run токен локального API теперь обязателен всегда; при ручном запуске без env генерируется эфемерный токен → `data/local_api_token.json`, в лог пишутся путь и 4-символьный префикс.
- ✅ **C4** SSRF/BYOK: allowlist base_url при сохранении и использовании; на localhost/Ollama BYOK Authorization не уходит вовсе.
- ⚠️ **C5** токен по-прежнему доступен renderer через preload (полное устранение = проксирование API через main, большой рефактор). Частичная компенсация: обязательный токен + ipcGuard-валидация sender'а.
- ✅ **C6** path traversal в voice_tests (`_safe_report_filename` до join).
- ✅ **H1** тестовые фикстуры/аудио исключены из stable-инсталлятора (только Dev-конфиг); контракт закреплён тестом.
- ✅ **H3** `verify:dev:overlay` встроен в `dev-build.yml`; локальный полный цикл — `release:dev:verified`.
- ✅ **H4** версии выровнены на 0.0.40; release.ps1 обновлён.
- ✅ **H8** лимиты входа повсюду (uploads/chat/RAG/benchmark+voice-tests gated `SKILLCUE_DEV_TOOLS=1`).
- ✅ **H9–H11** утечка сессии устранена; route-deadlines вместо ~361 c; обрыв стрима → `stream_failed` без персиста усечённого ответа.
- ✅ **H5/H6** crash-handling main + recovery главного окна + idempotent shutdown-dispose.
- ✅ **H7 (частично)** ipcGuard на чувствительных каналах; OAuth fail-closed без safeStorage.
- ⚠️ **H2** подпись/нотаризация отсутствуют (нужны сертификаты владельца); `hardenedRuntime: true` включён.
- 🟡 **C7** зависимости: vitest ^3.2.7 (critical закрыт), react-router-dom ^7.18.2, electron-updater ^6.8.9, undici 6.28.0 (overrides в pnpm-workspace.yaml + lockfile). Prod-audit: 24 (1 crit/16 high/7 mod) → **18 (1 crit/13 high/4 mod)**, остаток — спящий apps/api (tar/multer/bcrypt) вне поставки. **Electron 33→39 не мигрирован** — отдельная задача.

Документация приведена к фактической архитектуре:

- ✅ README, SECURITY.md, docs/gtm/*, ADR-0001 — облачный OpenAI STT вместо «локального Whisper»; ADR переведён в Accepted (Option A реализован: оффлайн Ed25519-лицензии + deep-link активация).
- ✅ README: добавлен раздел про обязательный Dev smoke-gate.
- ✅ docker-compose: сервисы привязаны к 127.0.0.1, помечен как dev-only helper спящего NestJS-слоя.
- ✅ Git-гигиена: закоммиченные артефакты PyInstaller сняты с трекинга, `.playwright-cli/` и `apps/api-py/build/` в .gitignore.
- ✅ CI: ESLint подключён (4 ошибки предварительно исправлены), job `Dependency audit (report)` (pnpm audit + pip-audit, пока non-blocking).
- ✅ UX_AUDIT.md: баннер о статусе снимка.

Снятые пункты:

- ❌ `playwright-core`/`cheerio` в dependencies — легитимные runtime-зависимости HH-автоматизации (electron-builder пакует только `dependencies`).

## 0.1 Визуальная фаза (фронтенд) — итог с учётом решения владельца

Проведён полный визуально-UX аудит (код + Playwright-скриншоты + вычисленные метрики рендера + сверка с `design_handoff_skillcue_redesign` и UX_AUDIT). Пробовали миграцию на индиго/графит из хендоффа — **владелец отклонил направление** («слишком ИИ-нейродизайн»), палитра полностью возвращена к оригинальной зелёно-синей (tokens.css/workspace.css/tailwind shadows восстановлены до исходных значений).

Оставлено из визуальной фазы (не зависит от палитры):

- Единый рецепт primary-кнопок: `.btn-primary`, `.prep-btn`, `.home-command-cta` — один вертикальный зелёный градиент, тёмный текст, единый ховер; убраны горизонтальный «зелёный→голубой» градиент и светло-зелёный текст поверх него.
- Оверлей: плавающие панели получили непрозрачную подложку + реальные тени (было `box-shadow:none`); всем контролам — видимый `:focus-visible` ring бренда; close-кнопка не исчезает до hover.
- Empty/loading состояния: история — иконка+заголовок+подсказка; Home path-choice — визуальный loading.
- A11y: `StatusBadge` role="status"; строки Test Lab с клавиатуры; глобальный фокус-ринг завязан на `--sc-brand`.
- Контрактные тесты (`desktopPolish.test.ts`, `OverlayPage.behavior.test.ts`, `HistoryPage.behavior.test.ts`) обновлены под новые соглашения.

Из плана хендоффа отложено (уровни B/C): общий Button/Card-примитив, группировка навигации сайдбара, lucide-иконки в оверлее, редизайн interview-cockpit.

## 0.2 Подписки: сверка с skill-cue.ru

Цены и периоды совпадают точно: Базовый 1490 ₽/мес (год 14900), Максимум 2990 ₽/мес (год 29900); в приложении (`lib/billing.ts`, PlanPicker) и на лендинге/pay.html одинаковые числа; фичи Базового (без live/overlay) соответствуют `PLAN_FEATURES` бэкенда.

Найдено и исправлено:

- 🔴 **Вебхук продаж минтовал всем план "pro"(=Максимум)** независимо от покупки → теперь тариф извлекается из заказа (custom_data.plan или название продукта/варианта «Базовый/Basic», «Максимум/Max»; неизвестное имя = basic + warning). Тесты: `tests/test_license_webhook.py`.
- 🟠 **Автоотклики HH не были гейтированы тарифом** (сайт продаёт их только в Максимуме) → введено `hhAutomationAllowed()` (только active+max): гейт запуска автоматизации, автозапуск daily отключается у trial/basic с пояснением. Тесты: `lib/billing.test.ts`.

Осталось осознанно: trial ограничен токен-бюджетом 300k и 15 минутами live (жёсткого «1 разбор вакансии» нет — оферта формулирует лимит как «объём функций»); в карточке Максимума на лендинге есть «Автоотклики HH», в приложении фича добавлена в список Максимума.

## 0.3 Надёжность и скорость live-overlay на полном interview-prep корпусе

Проверен файл `interview-prep-python-git-pytest-api-ru.md` (SHA-256 `dc386c82e0a8a6c497e4956edb0baac3994b2d3a3d77ee0a7da193b942c2c088`) через реальный SSE-маршрут overlay `POST /chat/interview/stream`. Dev-only runner `tools/verify_interview_prep_corpus.py` покрывает 25 Git/Python/pytest/API случаев. После замены точечных knowledge-патчей глобальным fast-core source-backend получил **25/25 PASS** (`%TEMP%\skillcue-fast-core-final-source-25.json`), установленный финальный Dev backend — **25/25 PASS** (`%TEMP%\skillcue-fast-core-installed-25.json`). Installed first-token: p50 **1203 ms**, p95 **1985 ms**, диапазон 1016–2313 ms; прежний enriched pipeline имел p50 2344 ms. Обязательный installed `verify:dev:overlay` получил `chunk` + `done` через `openai/gpt-4.1-mini` (first chunk 2172 ms). Dev installer: 127317348 bytes, SHA-256 `69B43E5C6D425785C06BD0AF010FD03677CB6A1DE1FCE0489E64BD334300A059`; installed backend SHA-256 `6FA87E24D8206BE82F3161670F50087238AC70B656222B4A41AC21151BC1E74D`. Stable installer: 125361376 bytes, SHA-256 `6DC3C8B0D4EA036824C4E6B364FB26863F2B5E31CF5FDCC5FF0C20D1378E8E51`; его packaged backend имеет тот же SHA-256, что проверенный Dev. Отчёты остаются вне customer package в `%TEMP%`.

Глобальный Ctrl+Enter hot-path:

- Desktop отправляет исходный вопрос и минимальный JSON; локальные glossary/follow-up/intent вычисления остаются только диагностикой и не расширяют запрос.
- Backend не вызывает transcript correction, resume/vacancy/legend RAG, candidate profile, weak topics, domain hints или knowledge packs; не читает эти контексты из БД и делает ровно один provider stream-вызов.
- System+user prompt ограничен примерно 1.7–2.1 тыс. символов. Теория ограничена 70 словами; complete code/API tasks сохраняются без spoken-trim.
- Fast-core использует глобально проверенный `openai/gpt-4.1-mini`, `temperature=0`; explicit model override оставлен только для диагностических сравнений.
- Вместо правил под отдельные вопросы используются только общие intent-классы: definition/list/comparison, exact code task и `api_test_task` с универсальной status/schema/business matrix.
- Старый enriched pipeline и curated knowledge сохранены только для не-fast сценариев. При проверке обнаружена и исправлена ошибка самого curated benchmark: `'1234567890'[6] = 7` синтаксически допустимо и даёт runtime `TypeError`, а не `SyntaxError`.
- Ctrl+Enter с дейктическим вопросом («что выведет этот код?», «на экране») маршрутизируется в `/chat/screen/stream`. Реальный PNG vision-прогон `tools/verify_screen_code_task.py` подтверждает `False` → `TypeError` → остановка и неизменяемость строки.
- Автоматический STT/очередь по-прежнему не может стартовать или заменить ответ: нижний guard требует `forceGeneration`, создаваемый только Ctrl+Enter.

---

## 1. Резюме

Проект зрелый для своей стадии: хорошая тестовая база (34 py-файла тестов, 126 ts/tsx тестов), обдуманная модель угроз в SECURITY.md, аккуратный Electron-hardening, работающий SSE/WS realtime. Но есть **два сломанных критических контракта** (managed STT и deep-link активация лицензии), **кластер проблем локальной поверхности API** (аутентификация, SSRF, токен в renderer) и **системные слабости релизного конвейера** (подпись, CI-гейты, метаданные версий, уязвимые зависимости).

| Серьёзность | Кол-во |
|---|---|
| Критические | 7 |
| Высокие | 19 |
| Средние | ~30 (сгруппированы) |
| Низкие | ~20 |

Зависимости: `pnpm audit` полный — **2 critical, 41 high, 33 moderate, 6 low** (82 advisory); только prod-дерево — 1 critical, 16 high, 7 moderate.

---

## 2. Критические

### C1. Managed-gateway STT для ответов сломан — пропущен `await`
`apps/api-py/app/services/stt/openai_transcribe.py:314-316` — `_gateway_license_key()` async-функция вызывается без `await`; в заголовок `Authorization` уходит строковое представление coroutine, gateway гарантированно отклоняет запрос. Live-путь работает, путь распознавания готовых ответов — нет.
**Фикс:** `await`, regression-тест (сейчас `tests/test_stt_mock_answer.py:74-93` покрывает только direct path).

### C2. Deep-link протокол: инсталлятор регистрирует одно, код ждёт другое
`apps/desktop/electron/buildChannel.ts:18-31` — runtime stable ждёт `skillcue://`, dev — `skillcue-dev://`. При этом `apps/desktop/package.json:143-149` регистрирует только `interview://`. `main.ts:1284-1345` отбрасывает URL с чужим протоколом. **Ссылки активации лицензии не работают.** `.env.example:34` (`DESKTOP_PROTOCOL=interview`) — устаревший третий вариант.
**Фикс:** один контракт везде + packaged smoke-тест на cold-start активацию.

### C3. Локальная аутентификация API отключена по умолчанию при ручном запуске + CORS `*`
`apps/api-py/app/core/local_auth.py:7-9,25-32` — без `SKILLCUE_API_TOKEN` все эндпоинты открыты (ключи, документы, сессии, STT). `app/main.py:37-45` + `config.py:47-50` — CORS `*`, т.е. любой сайт в браузере может дёргать localhost. SECURITY.md:11 заявляет «активен всегда в упакованном приложении», но не покрывает dev/manual запуск.
**Фикс:** обязательный per-run токен всегда; health-only bootstrap; CORS только свой origin.

### C4. SSRF + кража BYOK-ключа через произвольный `base_url`
`app/routers/settings.py:28-36,70-87` принимает любой `base_url` → сохраняется в `data/ai_preferences.json` (`services/preferences.py:39-46`) → `provider_adapter.py:63-69,240-271` шлёт туда запросы с `Authorization: Bearer <ключ пользователя>`. В сочетании с C3 любой локальный процесс или веб-страница может перенаправить ключ себе.
**Фикс:** allowlist провайдеров (https OpenRouter/OpenAI + 127.0.0.1 Ollama), запрет private/link-local IP, BYOK не отправлять на пользовательские URL.

### C5. Токен локального API доступен renderer'у
`apps/desktop/electron/main.ts:110-113` генерирует токен, `preload.ts:4-5` экспортирует `getApiToken`, `main.ts:563-566` отдаёт по IPC. Любой XSS в renderer получает полный доступ к бэкенду (см. C3/C4 — это цепочка до кражи ключей).
**Фикс:** renderer не должен знать токен; проксирование через preload с фиксированными методами либо capability-ограниченный токен.

### C6. Path traversal / произвольная запись файла
`app/routers/voice_tests.py:123-132` — имя файла из запроса идёт в путь напрямую (валидатор `_safe_report_filename` ниже по коду не применяется). Возможна перезапись JSON произвольным путём в правах процесса.
**Фикс:** `basename` + allowlist имён до join.

### C7. Критические уязвимости зависимостей
`vitest@2.1.9` — critical GHSA-5xrq-8626-4rwp (патч ≥3.2.6); **Electron 33.4.11 — множественные advisories (ветка патчей ≥39.8.x)**; `react-router@7.18.0` CSRF (≥7.18.2); `tar` (через bcrypt→node-pre-gyp, critical DoS + traversal, ≥7.5.21); `multer` DoS (NestJS, ≥2.2.0); `js-yaml` (через electron-updater); `undici`.
**Фикс:** обновления + `pnpm audit` и `pip-audit` в CI (SECURITY.md:57-58 честно признаёт, что их там нет).

---

## 3. Высокие

### Релиз и соответствие собственным правилам
- **H1. Тестовые фикстуры в стабильном инсталляторе.** `package.json:78-88`: `tests/stt-benchmark/cases.json` и `tests/voice/audio/*.wav` пакуются в обычный `build.extraResources` (dev-конфиг наследует: `electron-builder.dev.cjs:24-26`). Прямое нарушение правила CLAUDE.md «дев-верификация не попадает в stable». Поведение закреплено тестом `productSurface.test.ts:8-25` — его нужно обновить вместе с фиксом.
- **H2. Инсталляторы и обновления не подписаны.** Нет win-signing в build-конфиге, macOS `hardenedRuntime:false` (`package.json:104-107`), нет нотаризации. Цепь доверия автообновлений (`main.ts:1238-1265`) держится только на HTTPS к GitHub. Плюс нет channel/downgrade-политики — stable скачает любой совместимый релиз.
- **H3. Обязательный smoke-gate не встроен в CI.** `tools/verify_dev_overlay.py` — хороший headless E2E установленного билда, но `dev-build.yml:44-53` и `release.yml` его не запускают; выполняется только вручную через `install_and_verify_dev.ps1:8-16`.
- **H4. Релизный конвейер метаданных сломан предсказуемо.** `scripts/release.ps1:40-50` бампает только desktop-версию, не обновляя CHANGELOG/releaseNotes → `verify_release_metadata.mjs:16-29` упадёт на следующем релизе. Версии разъехались: root `0.1.0`, desktop `0.0.40`, последний тег `v0.1.6`.

### Устойчивость процессов
- **H5. Main-process не переживает падения.** Нет `process.on('uncaughtException')`/`unhandledRejection` нигде в `electron/`; для главного окна нет `render-process-gone` восстановления (единственный recovery — `overlayPointerRecovery.ts:9-16`). Итог: тихая смерть или навсегда белое окно.
- **H6. Завершение приложения не освобождает ресурсы.** `main.ts:1611-1640`: нет dispose `hhBrowserAssistant`, календаря, телеметрии, нет гарантии teardown MediaStream/MediaRecorder при quit/crash (renderer-side очистка в штатных сценариях в порядке — риск именно в аварийных путях). Нужен единый idempotent shutdown-coordinator.
- **H7. IPC без runtime-валидации.** Большинство `ipcMain.handle` принимают произвольные объекты без проверки `event.sender` и схем (TS-типы ≠ runtime): `main.ts:585-658` (HH args), `662-716` (OAuth/config), `720-753` (calendar), `1008-1035` (move/resize), `1087-1090` (autoLaunch). Есть и хорошие примеры (`985-1057`) — распространить паттерн.

### Надёжность бэкенда
- **H8. Неограниченные загрузки и payload'ы.** Документы: `documents.py:25-38` (`await file.read()` без лимита), `56-76` (текст без max_length); чат: `chat.py:52-130` (message/question/context/transcript без лимитов); RAG целиком в памяти и одним embed-запросом (`rag_service.py:17-80`); benchmark-endpoint читает bytes без лимита и не gated за dev (`stt_benchmark.py:24-29`, `benchmark.py:178-190`).
- **H9. Утечка DB-сессии в SSE.** `chat.py:679` открывает SessionLocal, закрывается только в finally генератора (`696-711`); если `_resolve_chat` бросит до StreamingResponse — сессия утекёт.
- **H10. Таймауты/retry-бюджеты.** Non-stream completions по умолчанию 3×120s+backoff ≈ **361 секунда** (`provider_adapter.py:296-397`); readiness/provider-test блокируется так же (`providers.py:73-86`). Нужны route-specific deadlines.
- **H11. Обрыв стрима считается успехом.** `chat.py:390-424`: после частичного ответа провайдера усечённый текст персистится как Answer и клиенту уходит `done`, без `stream_failed`. Terminal-ошибка после первых токенов не retryable (`provider_adapter.py:498-605`); финальный 429 теряет Retry-After и превращается в 504.
- **H12. Зомби-задачи STT при disconnect.** `openai_mini_stream.py:353-362` финализирует pending speech в finally и ждёт; с retries/таймаутами задачи живут до ~137 c после закрытия WebSocket и шлют в мёртвый сокет (`openai_transcribe.py:36-52,129-135`).
- **H13. Квоты не атомарны.** `quota.py:59-69,104-118` read-modify-write без транзакционной защиты; конкурентные WS потребляют ресурс без тарификации и без concurrency-cap (`stt.py:263-305`); `session_mutation_lock` process-local и не применяется к transcript/end-session (`sessions.py:522-574`).
- **H14. Миграций БД нет.** Только `metadata.create_all` (`db/session.py:36-39`); изменения схемы не доедут до существующего `copilot.sqlite`. FK PRAGMA тоже выключен (`:16-21`).

### Приватность
- **H15. Сырые расшифровки и документы — открытый текст без retention.** `models.py:37-45,89-97,134-148,194-206`; delete-all неполный (`usage.py:56-72` не трогает AppMeta/profile cache/feedback); recent raw transcripts доступны без admin-gate (`feedback.py:55-79`). Для продукта про интервью это репутационно чувствительно.

### Рендерер
- **H16. Index как key для реплик стенограммы.** `components/TranscriptPanel.tsx:26-29`: partial заменяет последний элемент/сдвигает массив → React может переиспользовать DOM другой реплики (неверный текст/стиль). Аналогично `DemoPage.tsx:180-181`, `LiveCopilot.tsx:75-76`, `OverlayPage.tsx:1406,1428,1829`, `DiagnosticsPanel.tsx:259-260`.
- **H17. God-объекты фронтенда.** `useLiveCopilot.ts` — 1495 строк, 20+ refs/state; `OverlayPage.tsx` — 1852 строки (UI+IPC+session+recap+analysis). Высокая связность → гонки при изменениях. Топ крупных файлов также: `HhApplicationsPage.tsx` (1463), `api.ts` (1367), в electron — `hhBrowserAssistant.ts` (**6583 строки**).
- **H18. Нет runtime-валидации ответов API/SSE/WS.** Trust-cast повсюду (`api.ts:223-227,1030-1037`, `liveSession.ts:225-273`), zod отсутствует; десятки ручных DTO дублируют бэкенд (`api.ts:11-480`) вместо `@interview/shared` — дрейф контрактов гарантирован.
- **H19. Отмена SSE = «успешный частичный ответ».** `api.ts:970-977`: user-abort превращается в `finish(spoken)`; malformed JSON/events молча игнорируются (`221-229`). Различать abort/timeout/failure.

---

## 4. Средние (по областям)

**Бэкенд:** синхронный SQLAlchemy и парсинг документов прямо в async-эндпоинтах блокируют event loop (`documents.py:36-50`, `rag_service.py:28-39`); лог-фильтр маскирует только `msg`, но не `%`-аргументы (`logging.py:14-20`); невалидный 2xx JSON от STT даёт 500 в обход обработки (`openai_transcribe.py:240-246,337-343`); answer-STT обходит gateway pacing lock (`openai_transcribe.py:305-329`); сырой `str(exc)` наружу в SSE-ошибках (`chat.py:479-493,820-961`); промпты захардкожены без версионирования (`prompts/interview_fast.py`, `chat.py:177-196`); `preferences.json` пишется неатомарно, сброс настроек маскирует порчу файла (`preferences.py:55-70`); README заявляет PostgreSQL+Redis, фактически SQLite (README:9 vs config.py:17).

**Electron:** loopback capture без platform-guard (`main.ts:1268-1281`); overlay без учёта многодисплейности/work-area (`main.ts:468-487`); главное окно не восстанавливается после `did-fail-load` (`main.ts:432-439`); бесконечный retry занятого хоткея каждые 2 c (`main.ts:1135-1143`); `safeOpenExternal` пропускает любой https/mailto (`main.ts:333-345`); OAuth-токены в plaintext при недоступном safeStorage (`hhOAuthService.ts:337-349`); `API_URL` может быть внешним — локальный токен уйдёт наружу (`main.ts:96-97`).

**Безопасность:** токен STT в query-string WebSocket (`liveSession.ts:119-123` — лучше short-lived ticket); docker-compose публикует Postgres/Redis на всех интерфейсах с кредами interview/interview (`docker-compose.yml:5-20`); deep-link принимает ключ лицензии без ограничений формата (`main.ts:1284-1314`); fallback секретов в env при отсутствии keyring (`secrets.py:47-72`).

**Рендерер:** поллинг каждые 10 c без single-flight/visibility (`AppContext.tsx:69-81`); несогласованная обработка offline-бэкенда между экранами; smooth-scroll на каждый STT-chunk (`TranscriptPanel.tsx:15-17`); неканселируемый `setTimeout(0)` (`useLiveCopilot.ts:451-464`); ErrorBoundary показывает `error.message` пользователю (`ErrorBoundary.tsx:42-43`); смешение ru/en хардкода поверх i18n (`OverlayPage.tsx:854-861`, `App.tsx:35-48` и др.).

**Инфраструктура:** `apps/api` (NestJS-биллинг) — 66 файлов вне CI вообще (нет build/test/typecheck, нет lint в CI даже для desktop, нет coverage); ADR-0001 до сих пор `Proposed` с рекомендацией «архивировать или подключить»; CI проверяет Python 3.11/3.12, но branch protection не подтверждается; зависимости плавающие (`^`/`>=`), Python без lock/constraints (только cryptography pinned); git замусорен закоммиченными артефактами PyInstaller (`apps/api-py/build/…`) и незакоммиченным `.playwright-cli/`; `tools/leadbot/leadbot.py` и `pay-qr.png` — маркетинговые утилиты посреди продуктового репозитория.

**Документация (противоречия):** README:3 «облачное распознавание OpenAI» vs SECURITY.md:16 «STT полностью локальный Whisper» vs фактический облачный роутинг `stt.py:174-187` — три разных утверждения о судьбе голоса пользователя; README не описывает обязательность overlay-gate; SECURITY.md:57-58 устарел (audit уже находит 2 critical); UX_AUDIT.md сам признаёт, что тесты не запускались; `.env.example` описывает неподключённый Nest-стек.

---

## 5. Что сделано хорошо (подтверждено)

- **Electron hardening:** `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false` (`main.ts:412-417,488-493`); `setWindowOpenHandler` deny + allowlist навигации (`351-364`); DevTools только в unpackaged (`441-443`); single-instance lock корректен (`1324-1346`).
- **Ключи:** keyring-first, не localStorage (`secrets.py:36-72`); grep реальных sk-ключей по репозиторию — чисто.
- **Бэкенд-качество:** pooled httpx с таймаутами и retry на transient-ошибки (`provider_adapter.py:23-41,356-397`); redaction ключей sk-/Bearer в логах (`logging.py:4-25`); generic ошибки наружу без traceback (`core/errors.py:26-33`); SQLite WAL + busy_timeout.
- **Рендерер:** глобальный ErrorBoundary (`main.tsx:18-25`); нет `dangerouslySetInnerHTML`, Markdown экранируется (`MarkdownText.tsx:78-119`); route-level code-splitting (`App.tsx:13-31`); bounded transcript window в live (`useLiveCopilot.ts:1006-1034`); аккуратный cleanup аудио/WS/SSE при unmount (`audioCapture.ts:56-65`, `liveSession.ts:199-210`, `useLiveCopilot.ts:1365-1376`).
- **Тесты:** 34 py + 126 ts/tsx тестов; routing/retry/SSE-framing покрыты; overlay smoke-gate спроектирован правильно (не хватает встраивания в CI).
- **Прозрачность:** SECURITY.md честно разделяет «защищено / защищает от честных», CHANGELOG ведётся активно.

---

## 6. План действий по приоритету

**P0 — сломанное и эксплуатируемое (до любого релиза):**
1. `await _gateway_license_key()` + regression-тест (C1).
2. Единый deep-link контракт + packaged cold-start тест (C2).
3. Обязательный токен локального API всегда + CORS origin (C3), allowlist `base_url` (C4), убрать токен из renderer (C5), basename в voice_tests (C6).
4. Убрать тестовые фикстуры/аудио из stable `extraResources` + обновить `productSurface.test.ts` (H1).
5. Обновить vitest, react-router, tar/multer/js-yaml/undici; начать миграцию Electron на поддерживаемую ветку ≥39 (C7).

**P1 — блокеры доверенного релиза:**
6. Подпись Windows + нотаризация/hardenedRuntime macOS + channel/downgrade-политика апдейтера (H2).
7. Встроить `verify:dev:overlay` в dev-build.yml и release.yml (H3).
8. Crash-handling main: uncaughtException/unhandledRejection + render-process-gone + shutdown-coordinator (H5, H6).
9. Починить релизный конвейер метаданных: единый источник версии, автообновление CHANGELOG/releaseNotes (H4).
10. Лимиты upload/chat/RAG + route-deadlines вместо дефолтных 361 c + починка утечки stream_db и семантики `stream_failed` (H8–H11).

**P2 — устойчивость и качество:**
11. Alembic-миграции; атомарные квоты + concurrency-cap (H13, H14).
12. Privacy-политика: retention/delete-all/admin-gate на transcripts (H15).
13. Runtime-схемы (zod/shared) для API/SSE/WS + консолидация DTO (H18, H19); стабильные ключи списков (H16); декомпозиция useLiveCopilot/OverlayPage/hhBrowserAssistant (H17).
14. IPC: схемы + проверка sender на каждый handler; fail-closed OAuth без safeStorage; валидация `API_URL` (H7 + средние).
15. Решить ADR-0001: архивировать `apps/api` или подключить и добавить в CI; вычистить compose/git/tools/leadbot; синхронизировать README/SECURITY/ADR по вопросу STT.

---
*Отчёт собран агентами аудита; каждая находка снабжена файлом и строкой для проверки.*
