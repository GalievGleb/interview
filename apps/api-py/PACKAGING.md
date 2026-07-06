# Packaging the backend into the desktop app

In **dev**, the Electron app auto-starts the backend with `py -3.12 -m uvicorn …`
(see `electron/main.ts` → `ensureBackend`). Overrides: `SKILLCUE_PYTHON`,
`SKILLCUE_API_DIR`.

In a **packaged** build, Electron instead spawns a bundled binary
(`resources/backend/skillcue-backend[.exe]`) and passes `SKILLCUE_PORT`. No
system Python is required on the end user's machine.

## Build a release

```bash
# 1) Freeze the backend (run inside apps/api-py)
pip install pyinstaller
pyinstaller skillcue-backend.spec          # → apps/api-py/dist/skillcue-backend/

# 2) Build the desktop app + installer (from apps/desktop), which copies
#    dist/skillcue-backend → resources/backend via build.extraResources
pnpm --filter @interview/desktop dist:full # = build:backend + build + electron-builder
```

`dist:full`, root `pnpm dist:desktop`, and desktop `pnpm dist` run both steps.
Use `pnpm --filter @interview/desktop dist:app` only when you intentionally want
an app-only installer without rebuilding the backend.

## Notes / tuning
- `run_server.py` is the frozen entry point (`uvicorn.run(app, port=$SKILLCUE_PORT)`).
- `skillcue-backend.spec` `collect_all`s faster-whisper / ctranslate2 / tokenizers /
  onnxruntime / av / huggingface_hub. Native STT deps are finicky — if the frozen
  binary fails to import a module, add it to `hiddenimports` (or `collect_all` the
  offending package) and rebuild.
- Whisper **model files** are downloaded at runtime into the user cache; they are
  not bundled, so the first run still needs network (or a pre-downloaded model).
- **Облачный STT (опционально):** Deepgram Nova-3 работает на базовом `websockets`
  и попадает в сборку всегда. Яндекс SpeechKit v3 требует `grpcio` + `yandexcloud`
  (`pip install -r requirements-stt-cloud.txt` в build-окружении ДО pyinstaller) —
  без них движок в реестре помечается unavailable с подсказкой, всё остальное
  работает. Если frozen-бинарь не находит `yandex.cloud.ai.stt.v3`, добавьте
  `collect_submodules("yandex.cloud.ai.stt.v3")` в hiddenimports.
- macOS/Linux: same flow; the binary is `skillcue-backend` (no `.exe`).

## Offline first-run (bundle a Whisper model)

By default the first run downloads a model from HuggingFace. To ship an installer
that works with no network, pre-download a model and bundle it:

```bash
# Pick a size: tiny (Fast) · small (Balanced, default) · medium (Quality)
python apps/api-py/predownload_models.py small      # → apps/api-py/dist/models/
pnpm --filter @interview/desktop dist:offline       # = predownload + dist:full
```

`dist/models/` ships as `resources/models`; the packaged backend reads it via
`SKILLCUE_MODELS_DIR` (set by Electron in `main.ts`). This adds the model size
(~75 MB / ~480 MB / ~1.5 GB) to the installer. Plain `dist:full` skips it (smaller
installer, downloads on first run).

## App icon

`apps/desktop/build/icon.ico` is the multi-resolution app/installer icon
(electron-builder picks up `build/icon.ico` automatically; also referenced via
`build.win.icon`). Regenerate with `python apps/desktop/build/make_icon.py`.

## Code signing (Windows)

Без подписи SmartScreen пугает пользователей «неизвестным издателем» — для
платного продукта это блокер. electron-builder подписывает автоматически, если
заданы переменные окружения при сборке/в CI:

```bash
CSC_LINK=file:///path/to/certificate.pfx   # или base64: CSC_LINK=data:...;base64,...
CSC_KEY_PASSWORD=***
```

Сертификат (OV/EV Code Signing) покупается у CA (Sectigo, DigiCert…). В GitHub
Actions — положить в секреты `CSC_LINK`/`CSC_KEY_PASSWORD`; release.yml подхватит
их без изменений (electron-builder читает env сам).

## Licensing (trial + ключи)

- 14-дневный trial с первого запуска (`app_meta.first_run_at` в SQLite);
  статус — `GET /license/status`, активация — `POST /license/activate`.
- Ключ — Ed25519-подписанный payload (`SKILLCUE-<b64url(json)>.<b64url(sig)>`),
  проверка оффлайн по публичному ключу в `app/services/license.py`.
- Выпуск ключей: `python tools/generate_license_key.py buyer@mail.com [--days 365]`.
  Приватный ключ — `apps/api-py/.license_signing_key` (в .gitignore, хранить в
  надёжном месте!). Новая пара: `--new-keypair` (обновить PUBLIC_KEY_HEX).
- Подключение продаж: готовый webhook-сервер `tools/license_webhook.py` —
  деплой на любой хост: `LEMONSQUEEZY_WEBHOOK_SECRET=… LICENSE_SIGNING_KEY=<hex>
  uvicorn tools.license_webhook:app --port 8100`; в LemonSqueezy указать URL
  `/webhook/lemonsqueezy` и событие `order_created`. Ключ уходит покупателю по
  SMTP (`SMTP_HOST/PORT/USER/PASSWORD/FROM`) и всегда дублируется в лог.
  `LICENSE_DAYS=365` — подписочные ключи. UI приложения менять не нужно.
- Гейтинг мягкий: после trial блокируется только live-режим; подготовка,
  история и разбор разговоров продолжают работать.

## Manual live tests (can't run in CI / this dev box)

**Local LLM (Ollama)** — the request shaping is unit-tested, but the actual call
needs a running server:

```bash
ollama serve & ollama pull llama3.1
# In the app: «Разбор разговора» → check «Локально (Ollama)», paste a transcript,
# run. The stream should come from localhost; nothing leaves the machine.
# Override host if needed: OLLAMA_BASE_URL=http://host:11434/v1
```

**Frozen backend / installer** — CI smoke-boots the exe (`/health` + токен-барьер +
`/stt/providers` + `/license/status`); локально то же самое делает
`scripts/smoke-packaged.ps1` (после `pyinstaller skillcue-backend.spec`; флаг
`-Dev` гоняет те же проверки против dev-python без сборки). Для полного чека
поставьте NSIS-инсталлер из release-сборки и убедитесь, что приложение само
поднимает бэкенд (нет баннера "Backend offline") и live-транскрипция работает.
