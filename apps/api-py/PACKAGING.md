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

`dist:full` runs both steps. Plain `dist` skips the backend (ships the empty
placeholder dir → app falls back to the "Backend offline" banner).

## Notes / tuning
- `run_server.py` is the frozen entry point (`uvicorn.run(app, port=$SKILLCUE_PORT)`).
- `skillcue-backend.spec` `collect_all`s faster-whisper / ctranslate2 / tokenizers /
  onnxruntime / av / huggingface_hub. Native STT deps are finicky — if the frozen
  binary fails to import a module, add it to `hiddenimports` (or `collect_all` the
  offending package) and rebuild.
- Whisper **model files** are downloaded at runtime into the user cache; they are
  not bundled, so the first run still needs network (or a pre-downloaded model).
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

## Manual live tests (can't run in CI / this dev box)

**Local LLM (Ollama)** — the request shaping is unit-tested, but the actual call
needs a running server:

```bash
ollama serve & ollama pull llama3.1
# In the app: «Разбор разговора» → check «Локально (Ollama)», paste a transcript,
# run. The stream should come from localhost; nothing leaves the machine.
# Override host if needed: OLLAMA_BASE_URL=http://host:11434/v1
```

**Frozen backend / installer** — CI smoke-boots the exe (`/health`); for a full
check install the NSIS output from a release build and confirm the app starts the
backend itself (no "Backend offline" banner) and live transcription works.
