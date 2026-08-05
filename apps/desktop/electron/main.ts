import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  session,
  shell,
  Tray,
  Menu,
  nativeImage,
} from 'electron';
import path from 'path';
import fs from 'fs';
import http from 'http';
import os from 'os';
import crypto from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { autoUpdater } from 'electron-updater';
import { HhBrowserAssistant } from './hhBrowserAssistant';
import type { HhAssistantConfig } from './hhAssistantPolicy';
import { HhOAuthService } from './hhOAuthService';
import { HhChatBrowser } from './hhChatBrowser';
import { isReservedOverlayShortcut } from './shortcutPolicy';
import { createAutoUpdateCoordinator } from './autoUpdateCoordinator';
import { createUpdaterStatusStore } from './updaterStatusStore';
import {
  hideOverlayAndShowMain,
  hideOverlayOnly,
  hideWindowOnClose,
  isLiveWindow,
} from './windowLifecycle';
import { bindOverlayShortcutLifecycle } from './overlayShortcutLifecycle';
import { PersistentGlobalShortcut } from './persistentGlobalShortcut';
import { bindOverlayPointerRecovery } from './overlayPointerRecovery';
import { getTitleBarOverlayTheme } from './titleBarTheme';
import { preparePersistentBackendData, sqliteDatabaseUrl } from './backendData';

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:8000';
const isDev = !app.isPackaged;

// Адрес серверного гейтвея лицензий SkillCue. Покупатель без своего ключа
// OpenRouter, но с валидной лицензией ходит к нейросети через него (провайдер
// сам это решает в provider_adapter._resolve). Переопределяется env при сборке.
const SKILLCUE_GATEWAY_URL = process.env.SKILLCUE_GATEWAY_URL ?? 'https://skill-cue.ru/v1';

// Случайный токен на запуск: бэкенд принимает запросы только с ним, чтобы
// другие локальные процессы/сайты не могли дёргать API (и жечь LLM-токены).
// Активен только когда бэкенд запущён нами (env уходит в spawn).
const API_TOKEN = crypto.randomBytes(24).toString('hex');

// SkillCue mark (indigo rounded square) — used for the tray + window icon so
// neither is blank. A full multi-res .ico for the installer is a separate asset.
const BRAND_ICON = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAWElEQVR42u3XsQkAIAwF0ewquL8TaGejBJSYBLyA9b3SL6Jcqa1bPDk5q+gV5nVcRXjFtwjv+IL4GxAVnwgAAAAAAAAAAIBwAH/CFIDwYZJimqUYpxHzfABg0BWrfAI5+AAAAABJRU5ErkJggg==',
);

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let backendProcess: ChildProcess | null = null;
let backendLogStream: fs.WriteStream | null = null;
let backendRestartAttempts = 0;
let backendRestartTimer: NodeJS.Timeout | null = null;
let forceAnswerShortcutBinding: PersistentGlobalShortcut | null = null;
let forceAnswerShortcutRetryTimer: NodeJS.Timeout | null = null;
let hhBrowserAssistant: HhBrowserAssistant | null = null;
let hhOAuthService: HhOAuthService | null = null;
let hhChatBrowser: HhChatBrowser | null = null;
let closingHhBrowserForQuit = false;
let quitting = false;
// Ключ лицензии из ссылки skillcue://activate?key=… ждёт здесь, пока окно
// не догрузится (холодный старт по ссылке), затем уходит в рендерер.
let pendingDeepLinkKey: string | null = null;

// Живой процесс не перезапускаем бесконечно: 3 попытки, дальше баннер «не в сети».
const MAX_BACKEND_RESTARTS = 3;
const updaterStatusStore = createUpdaterStatusStore((status) => {
  sendToWindows('updater:status', status);
});
const updateCoordinator = createAutoUpdateCoordinator({
  checkForUpdates: () => autoUpdater.checkForUpdates(),
  installSilently: () => autoUpdater.quitAndInstall(true, true),
  publish: (status) => updaterStatusStore.publish(status),
  schedule: (fn) => {
    setTimeout(fn, 900);
  },
});

function sendToWindows(channel: string, payload: unknown): void {
  for (const win of [mainWindow, overlayWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function backendLogPath(): string {
  return path.join(app.getPath('userData'), 'backend.log');
}

/** Пишем stdout/stderr бэкенда в файл — основа диагностического отчёта. */
function logBackend(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    if (!backendLogStream) {
      // Простая ротация: старый лог > 5 МБ уезжает в backend.old.log.
      const p = backendLogPath();
      if (fs.existsSync(p) && fs.statSync(p).size > 5 * 1024 * 1024) {
        fs.renameSync(p, p.replace(/\.log$/, '.old.log'));
      }
      backendLogStream = fs.createWriteStream(p, { flags: 'a' });
    }
    backendLogStream.write(`[${new Date().toISOString()}] ${trimmed}\n`);
  } catch {
    /* лог — best-effort, не роняем приложение */
  }
  console.log('[backend]', trimmed);
}

/** Resolve `${API_URL}/health` → true if the backend is already reachable. */
function pingBackendHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${API_URL}/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Locate the Python backend + the command to launch uvicorn (dev + override). */
function resolveBackendLaunch(): { cmd: string; args: string[]; cwd: string } | null {
  // Packaged build: spawn the bundled PyInstaller binary (no system Python needed).
  if (app.isPackaged) {
    const exe = process.platform === 'win32' ? 'skillcue-backend.exe' : 'skillcue-backend';
    const bin = path.join(process.resourcesPath, 'backend', exe);
    return fs.existsSync(bin) ? { cmd: bin, args: [], cwd: path.dirname(bin) } : null;
  }
  const cwd = process.env.SKILLCUE_API_DIR ?? path.join(__dirname, '..', '..', 'api-py');
  if (!fs.existsSync(path.join(cwd, 'app', 'main.py'))) return null;
  const port = new URL(API_URL).port || '8000';
  const uvicornArgs = ['-m', 'uvicorn', 'app.main:app', '--port', port];
  if (process.env.SKILLCUE_PYTHON) {
    const parts = process.env.SKILLCUE_PYTHON.trim().split(/\s+/);
    return { cmd: parts[0], args: [...parts.slice(1), ...uvicornArgs], cwd };
  }
  if (process.platform === 'win32') return { cmd: 'py', args: ['-3.12', ...uvicornArgs], cwd };
  return { cmd: 'python3', args: uvicornArgs, cwd };
}

/** Start the backend ourselves if nothing is already serving it. Best-effort:
 *  if Python/api-py isn't found we fall back to the renderer's offline banner. */
async function ensureBackend(): Promise<void> {
  if (await pingBackendHealth()) return; // a dev terminal (or prior run) is serving it
  const cfg = resolveBackendLaunch();
  if (!cfg) {
    console.warn('[backend] api-py not found — start the API manually or set SKILLCUE_API_DIR');
    return;
  }
  try {
    const persistentDatabase = app.isPackaged
      ? preparePersistentBackendData(app.getPath('userData'), process.resourcesPath)
      : null;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONPATH: '.',
      SKILLCUE_PORT: new URL(API_URL).port || '8000',
      SKILLCUE_API_TOKEN: API_TOKEN,
      // Бэкенд подхватит как settings.skillcue_gateway_url (BYOK-фолбэк на гейтвей).
      SKILLCUE_GATEWAY_URL,
      ...(persistentDatabase
        ? { DATABASE_URL: sqliteDatabaseUrl(persistentDatabase) }
        : {}),
    };
    backendProcess = spawn(cfg.cmd, cfg.args, {
      cwd: cfg.cwd,
      env,
      stdio: 'pipe',
      // Dev `py`/`python3` resolve via PATHEXT (needs a shell on Windows); the
      // packaged binary is a direct path and must NOT go through a shell.
      shell: !app.isPackaged && process.platform === 'win32',
    });
    backendProcess.stdout?.on('data', (d) => logBackend(String(d)));
    backendProcess.stderr?.on('data', (d) => logBackend(String(d)));
    backendProcess.on('exit', (code) => {
      logBackend(`process exited with code ${code}`);
      backendProcess = null;
      scheduleBackendRestart();
    });
    backendProcess.on('error', (err) => {
      logBackend(`failed to launch: ${err.message}`);
      backendProcess = null;
      scheduleBackendRestart();
    });
    void confirmBackendUp();
  } catch (err) {
    console.warn('[backend] could not start:', err);
  }
}

/** После запуска ждём health и сообщаем renderer'у «ок». */
async function confirmBackendUp(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    if (quitting) return;
    if (await pingBackendHealth()) {
      backendRestartAttempts = 0;
      sendToWindows('backend:status', { state: 'ok' });
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** Бэкенд умер посреди работы: рестарт с нарастающей паузой, максимум 3 раза. */
function scheduleBackendRestart(): void {
  if (quitting || backendRestartTimer) return;
  if (backendRestartAttempts >= MAX_BACKEND_RESTARTS) {
    sendToWindows('backend:status', { state: 'failed' });
    return;
  }
  backendRestartAttempts += 1;
  sendToWindows('backend:status', {
    state: 'restarting',
    attempt: backendRestartAttempts,
    max: MAX_BACKEND_RESTARTS,
  });
  backendRestartTimer = setTimeout(() => {
    backendRestartTimer = null;
    void ensureBackend();
  }, 1000 * backendRestartAttempts);
}

function stopBackend(): void {
  if (!backendProcess) return;
  try {
    if (process.platform === 'win32' && backendProcess.pid) {
      // Kill the whole tree — the shell wrapper spawns uvicorn as a child.
      spawn('taskkill', ['/pid', String(backendProcess.pid), '/T', '/F']);
    } else {
      backendProcess.kill();
    }
  } catch {
    /* ignore */
  }
  backendProcess = null;
}

function getPreloadPath(): string {
  return path.join(__dirname, 'preload.js');
}

/** Only allow https links (OS browser) and mailto (mail client). */
function safeOpenExternal(url: string): void {
  try {
    const protocol = new URL(url).protocol;
    if (protocol === 'https:' || protocol === 'mailto:') {
      void shell.openExternal(url);
      return;
    }
  } catch {
    /* invalid URL */
  }
  console.warn('[electron] blocked openExternal:', url);
}

/**
 * Electron hardening: a compromised renderer must not be able to spawn windows
 * or navigate away from the app. External links open in the OS browser instead.
 */
function hardenWindow(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    safeOpenExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev
      ? url.startsWith('http://localhost:5173')
      : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
      safeOpenExternal(url);
    }
  });
}

/** Strict CSP for the packaged app (dev uses Vite's own server + HMR). */
function setupContentSecurityPolicy(): void {
  if (isDev) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "img-src 'self' data: blob:",
            "font-src 'self' data: https://fonts.gstatic.com",
            "media-src 'self' blob:",
            "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com http://127.0.0.1:8000 ws://127.0.0.1:8000 http://localhost:8000 ws://localhost:8000",
          ].join('; '),
        ],
      },
    });
  });
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 880,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f1117',
    title: 'SkillCue',
    icon: BRAND_ICON,
    autoHideMenuBar: true,
    // Прячем светлую системную рамку Windows и рисуем кнопки окна поверх нашего
    // тёмного тайтлбара — сам тайтлбар отвечает за перетаскивание (app-region).
    titleBarStyle: 'hidden',
    titleBarOverlay: getTitleBarOverlayTheme('dark'),
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });
  win.on('close', (event) => {
    hideWindowOnClose(event, win, quitting);
  });
  win.once('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.setMenuBarVisibility(false);

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[electron] did-fail-load', code, desc, url);
  });

  // Рендерер догрузился — отдаём отложенный ключ активации (холодный старт).
  win.webContents.on('did-finish-load', () => flushDeepLink());

  hardenWindow(win);

  if (isDev) {
    void win.loadURL('http://localhost:5173/#/');
    win.webContents.openDevTools({ mode: 'right' });
  } else {
    void win.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  return win;
}

function hideOverlay(): void {
  hideOverlayOnly(overlayWindow);
}

function createOverlayWindow(): BrowserWindow {
  const win = new BrowserWindow({
    // Компактный плавающий ассистент: пилл + командная панель + ответ.
    width: 680,
    height: 780,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    show: false,
    focusable: true,
    // Первый клик по неактивному оверлею (когда пользователь работает в другом
    // приложении) сразу уходит в контент, а не тратится на активацию окна.
    acceptFirstMouse: true,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const overlayRoute = isDev
    ? 'http://localhost:5173/#/overlay'
    : `file://${path.join(__dirname, '../dist/index.html')}#/overlay`;
  hardenWindow(win);
  bindOverlayShortcutLifecycle(
    win,
    globalShortcut,
    hideOverlay,
  );
  bindOverlayPointerRecovery(win);
  void win.loadURL(overlayRoute);
  win.hide();
  win.once('closed', () => {
    if (overlayWindow === win) overlayWindow = null;
  });
  return win;
}

function getOrCreateOverlayWindow(): BrowserWindow {
  if (!isLiveWindow(overlayWindow)) overlayWindow = createOverlayWindow();
  return overlayWindow;
}

function registerIpc(): void {
  ipcMain.handle('app:getApiUrl', () => API_URL);
  ipcMain.handle('app:getApiToken', () => API_TOKEN);
  ipcMain.handle('app:openExternal', (_e, url: string) => safeOpenExternal(url));
  // «Выйти из SkillCue» в настройках — то же, что «Выход» в трее.
  ipcMain.handle('app:quit', () => app.quit());

  ipcMain.handle('hh-assistant:get-state', () => hhBrowserAssistant?.getState());
  ipcMain.handle(
    'hh-assistant:save-config',
    (_e, config: Partial<HhAssistantConfig>) => hhBrowserAssistant?.saveConfig(config),
  );
  ipcMain.handle('hh-assistant:open-browser', (_e, platform) => hhBrowserAssistant?.openBrowser(platform));
  ipcMain.handle('hh-assistant:scan', (_e, platform) => hhBrowserAssistant?.scan(platform));
  ipcMain.handle('hh-assistant:apply-all', () => hhBrowserAssistant?.applyAll());
  ipcMain.handle('hh-assistant:apply-one', (_e, vacancyId: string) =>
    hhBrowserAssistant?.applyOne(vacancyId),
  );
  ipcMain.handle('hh-assistant:stop-apply', () => hhBrowserAssistant?.stopApply());
  ipcMain.handle('hh-assistant:set-daily-schedule', (_e, enabled: boolean) =>
    hhBrowserAssistant?.setDailySchedule(Boolean(enabled)),
  );
  ipcMain.handle('hh-assistant:open-vacancy', (_e, vacancyId: string) =>
    hhBrowserAssistant?.openVacancy(vacancyId),
  );
  ipcMain.handle('hh-assistant:fill-letter', (_e, vacancyId: string) =>
    hhBrowserAssistant?.fillCoverLetter(vacancyId),
  );
  ipcMain.handle(
    'hh-assistant:mark',
    (_e, vacancyId: string, status: string) => {
      if (status !== 'sent' && status !== 'skipped') {
        return hhBrowserAssistant?.getState();
      }
      return hhBrowserAssistant?.mark(vacancyId, status);
    },
  );
  ipcMain.handle('hh-assistant:close-browser', async () => {
    await hhBrowserAssistant?.close();
    return hhBrowserAssistant?.getState();
  });
  ipcMain.handle(
    'hh-assistant:login',
    async (_e, login: string, password: string) =>
      hhBrowserAssistant?.loginWithCredentials(login, password),
  );
  ipcMain.handle('hh-assistant:request-login-code', (_e, email: string) =>
    hhBrowserAssistant?.requestLoginCode(email),
  );
  ipcMain.handle('hh-assistant:confirm-login-code', (_e, code: string) =>
    hhBrowserAssistant?.confirmLoginCode(code),
  );
  ipcMain.handle('hh-assistant:get-resumes', () => hhBrowserAssistant?.getApplicantResumes());

  // ─── HH OAuth ───────────────────────────────────────────────────────
  ipcMain.handle('hh-oauth:get-state', () => hhOAuthService?.getState());
  ipcMain.handle('hh-oauth:get-config', () => hhOAuthService?.getConfig());
  ipcMain.handle(
    'hh-oauth:save-config',
    (_e, config: Record<string, unknown>) => hhOAuthService?.saveConfig(config),
  );
  ipcMain.handle('hh-oauth:start-auth', async () => {
    try {
      const tokens = await hhOAuthService?.startAuth();
      return { ok: true, tokens };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('hh-oauth:exchange-code', async (_e, code: string) => {
    try {
      const tokens = await hhOAuthService?.exchangeCode(code);
      return { ok: true, tokens };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('hh-oauth:logout', () => hhOAuthService?.logout());
  ipcMain.handle('hh-oauth:get-resumes', async () => {
    try {
      return await hhOAuthService?.getResumes();
    } catch {
      return [];
    }
  });
  ipcMain.handle('hh-oauth:get-me', async () => {
    try {
      return await hhOAuthService?.getMe();
    } catch {
      return null;
    }
  });

  // ─── HH Chat Browser ─────────────────────────────────────────────────
  ipcMain.handle('hh-chat:get-state', () => hhChatBrowser?.getState());
  ipcMain.handle('hh-chat:get-config', () => hhChatBrowser?.getConfig());
  ipcMain.handle(
    'hh-chat:save-config',
    (_e, config: Record<string, unknown>) => hhChatBrowser?.saveConfig(config),
  );
  ipcMain.handle('hh-chat:set-enabled', (_e, enabled: boolean) =>
    hhChatBrowser?.setEnabled(enabled),
  );
  ipcMain.handle('hh-chat:poll-now', async () => hhChatBrowser?.pollNow());

  ipcMain.handle('keybinds:get', () => ({
    toggleOverlay: toggleOverlayShortcut,
    defaultToggleOverlay: DEFAULT_TOGGLE_SHORTCUT,
  }));

  ipcMain.handle('keybinds:setToggleOverlay', (_e, acc: string) => {
    const next = typeof acc === 'string' && acc.trim() ? acc.trim() : DEFAULT_TOGGLE_SHORTCUT;
    if (isReservedOverlayShortcut(next)) {
      return {
        ok: false,
        shortcut: toggleOverlayShortcut,
        error: 'Ctrl+Enter is reserved for sending the current live question',
      };
    }
    if (next === toggleOverlayShortcut) return { ok: true, shortcut: toggleOverlayShortcut };
    globalShortcut.unregister(toggleOverlayShortcut);
    if (!registerToggleShortcut(next)) {
      // Откат: сочетание занято системой или другим приложением.
      registerToggleShortcut(toggleOverlayShortcut);
      return {
        ok: false,
        shortcut: toggleOverlayShortcut,
        error: 'Сочетание занято другим приложением',
      };
    }
    toggleOverlayShortcut = next;
    saveMainSetting('toggleOverlayShortcut', next);
    return { ok: true, shortcut: next };
  });

  // «Сообщить о проблеме»: system info + хвост лога бэкенда + файлы от
  // renderer'а (prefs, тайминги) → zip во временной папке → показать в проводнике.
  ipcMain.handle(
    'app:collectDiagnostics',
    async (_e, extra: Array<{ name: string; content: string }> = []) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dir = path.join(app.getPath('temp'), `skillcue-report-${stamp}`);
      fs.mkdirSync(dir, { recursive: true });

      const online = await pingBackendHealth();
      const info = [
        `SkillCue ${app.getVersion()} (${app.isPackaged ? 'packaged' : 'dev'})`,
        `Electron ${process.versions.electron} / Chrome ${process.versions.chrome} / Node ${process.versions.node}`,
        `OS: ${process.platform} ${os.release()} ${os.arch()}`,
        `RAM: ${Math.round(os.totalmem() / 1024 ** 3)} GB`,
        `Backend online: ${online}`,
        `Backend managed by app: ${backendProcess !== null}`,
        `Restart attempts: ${backendRestartAttempts}`,
        `Date: ${new Date().toISOString()}`,
      ].join('\n');
      fs.writeFileSync(path.join(dir, 'system-info.txt'), info, 'utf8');

      try {
        const logP = backendLogPath();
        if (fs.existsSync(logP)) {
          // Хвост в 512 КБ достаточен и не тащит недельную историю.
          const size = fs.statSync(logP).size;
          const start = Math.max(0, size - 512 * 1024);
          const buf = Buffer.alloc(size - start);
          const fd = fs.openSync(logP, 'r');
          fs.readSync(fd, buf, 0, buf.length, start);
          fs.closeSync(fd);
          fs.writeFileSync(path.join(dir, 'backend.log'), buf);
        }
      } catch {
        /* лог не собрался — отчёт всё равно полезен */
      }

      for (const file of extra.slice(0, 10)) {
        if (typeof file?.name !== 'string' || typeof file?.content !== 'string') continue;
        const safe = file.name.replace(/[^a-z0-9._-]/gi, '_').slice(0, 64) || 'extra.txt';
        try {
          fs.writeFileSync(path.join(dir, safe), file.content.slice(0, 2_000_000), 'utf8');
        } catch {
          /* ignore */
        }
      }

      let target = dir;
      if (process.platform === 'win32') {
        const zip = `${dir}.zip`;
        const zipped = await new Promise<boolean>((resolve) => {
          const ps = spawn('powershell', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Compress-Archive -Path "${dir}\\*" -DestinationPath "${zip}" -Force`,
          ]);
          ps.on('exit', (code) => resolve(code === 0));
          ps.on('error', () => resolve(false));
        });
        if (zipped) target = zip;
      }
      shell.showItemInFolder(target);
      return target;
    },
  );

  ipcMain.handle('overlay:toggle', () => {
    toggleOverlay();
  });

  ipcMain.handle('overlay:show', () => getOrCreateOverlayWindow().show());
  ipcMain.handle('overlay:hide', () => hideOverlay());

  ipcMain.handle('overlay:captureScreen', async () => {
    // Скриншот основного экрана для vision-подсказки («Экран» в оверлее).
    // JPEG 70% на ~1600px — читаемо для модели и в разы легче PNG.
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1600, height: 1000 },
      });
      const primary = sources[0];
      if (!primary) return '';
      return `data:image/jpeg;base64,${primary.thumbnail.toJPEG(70).toString('base64')}`;
    } catch (err) {
      console.warn('[overlay] screen capture failed:', err);
      return '';
    }
  });

  ipcMain.handle('overlay:openApp', () => {
    // Явный переход из оверлея в основное окно скрывает плавающую панель.
    hideOverlayAndShowMain(overlayWindow, mainWindow);
  });

  ipcMain.handle('overlay:openSettings', (_e, section?: string) => {
    if (!isLiveWindow(mainWindow)) return;
    hideOverlayAndShowMain(overlayWindow, mainWindow);
    const safe = section && /^[a-z-]+$/.test(section) ? `?tab=${section}` : '';
    mainWindow.webContents.send('app:navigate', `/settings${safe}`);
  });

  ipcMain.handle('overlay:setContentProtection', (_e, enable: boolean) => {
    if (isLiveWindow(overlayWindow)) overlayWindow.setContentProtection(enable);
    if (isLiveWindow(mainWindow)) mainWindow.setContentProtection(enable);
  });

  ipcMain.handle('overlay:move', (_e, dx: number, dy: number) => {
    // Перемещение окна оверлея с клавиатуры (Ctrl+стрелки), как «Move Cluely».
    if (!isLiveWindow(overlayWindow)) return;
    const [x, y] = overlayWindow.getPosition();
    overlayWindow.setPosition(Math.round(x + dx), Math.round(y + dy));
  });

  ipcMain.handle('overlay:setFocusable', (_e, focusable: boolean) => {
    // «Не забирать фокус»: оверлей не становится активным окном, фокус
    // остаётся в приложении под ним. Внимание: при false ввод в поле
    // оверлея недоступен, поэтому включается осознанно из меню.
    if (isLiveWindow(overlayWindow)) overlayWindow.setFocusable(focusable);
  });

  ipcMain.handle('overlay:setClickThrough', (_e, enable: boolean) => {
    // Клики проходят «сквозь» оверлей в приложение под ним. forward:true шлёт
    // события движения курсора в рендерер, чтобы он мог временно вернуть
    // интерактивность при наведении на свои элементы (см. OverlayPage).
    if (isLiveWindow(overlayWindow)) {
      overlayWindow.setIgnoreMouseEvents(enable, { forward: true });
    }
  });

  ipcMain.handle('overlay:resize', (_e, dw: number, dh: number) => {
    if (!isLiveWindow(overlayWindow)) return;
    const [w, h] = overlayWindow.getSize();
    const nw = Math.max(420, Math.min(1400, Math.round(w + (dw || 0))));
    const nh = Math.max(360, Math.min(1200, Math.round(h + (dh || 0))));
    overlayWindow.setSize(nw, nh, false);
  });

  ipcMain.handle('overlay:liveState', (_e, active: boolean) => {
    updateCoordinator.setLive(!!active);
    // Live-сессия крутится в окне оверлея; главное окно не видит его событий,
    // поэтому пробрасываем состояние туда — сайдбар-хронометр и веха активации.
    mainWindow?.webContents.send('app:live-state', !!active);
  });

  ipcMain.handle('window:setSkipTaskbar', (_e, skip: boolean) => {
    mainWindow?.setSkipTaskbar(skip);
  });

  ipcMain.handle('window:setTitleBarTheme', (event, theme: unknown) => {
    if (
      !isLiveWindow(mainWindow) ||
      event.sender !== mainWindow.webContents ||
      (theme !== 'dark' && theme !== 'light')
    ) {
      return;
    }
    mainWindow.setTitleBarOverlay(getTitleBarOverlayTheme(theme));
  });

  ipcMain.handle('app:getVersion', () => app.getVersion());

  ipcMain.handle('updater:check', async () => {
    // Ручная проверка из настроек. В dev автообновление не настроено.
    if (isDev) {
      const status = {
        state: 'none' as const,
        message: 'dev-режим: обновления недоступны',
      };
      updaterStatusStore.publish(status);
      return status;
    }
    try {
      await updateCoordinator.check();
      return updaterStatusStore.get();
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      if (updaterStatusStore.get().state !== 'error') {
        updateCoordinator.resetAfterError(message);
      }
      return { state: 'error' as const, message };
    }
  });
  ipcMain.handle('updater:get-status', () => updaterStatusStore.get());

  ipcMain.handle('app:getAutoLaunch', () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle('app:setAutoLaunch', (_e, enable: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enable });
  });
}

/* ---- Настройки main-процесса (нужны до готовности renderer'а) ---- */

const DEFAULT_TOGGLE_SHORTCUT = 'CommandOrControl+Shift+H';
const FORCE_ANSWER_SHORTCUT = 'CommandOrControl+Enter';
let toggleOverlayShortcut = DEFAULT_TOGGLE_SHORTCUT;

function mainSettingsPath(): string {
  return path.join(app.getPath('userData'), 'main-settings.json');
}

function loadMainSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(mainSettingsPath(), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function saveMainSetting(key: string, value: unknown): void {
  try {
    fs.writeFileSync(
      mainSettingsPath(),
      JSON.stringify({ ...loadMainSettings(), [key]: value }, null, 2),
    );
  } catch {
    /* best-effort */
  }
}

function toggleOverlay(): void {
  const win = getOrCreateOverlayWindow();
  if (win.isVisible()) hideOverlay();
  else win.show();
}

function registerToggleShortcut(acc: string): boolean {
  if (isReservedOverlayShortcut(acc)) return false;
  try {
    return globalShortcut.register(acc, toggleOverlay);
  } catch {
    return false;
  }
}

function deliverForcedAnswerToOverlay(): void {
  const win = getOrCreateOverlayWindow();
  if (!win.isVisible()) win.showInactive();
  const send = () => {
    if (!isLiveWindow(win) || win.webContents.isDestroyed()) return;
    win.webContents.send('overlay:force-answer');
  };
  if (win.webContents.isLoadingMainFrame()) win.webContents.once('did-finish-load', send);
  else send();
}

function scheduleForceAnswerShortcutRetry(): void {
  if (quitting || forceAnswerShortcutRetryTimer) return;
  forceAnswerShortcutRetryTimer = setTimeout(() => {
    forceAnswerShortcutRetryTimer = null;
    if (!forceAnswerShortcutBinding?.ensureRegistered()) {
      scheduleForceAnswerShortcutRetry();
    }
  }, 2_000);
}

function registerForceAnswerShortcut(): void {
  forceAnswerShortcutBinding?.dispose();
  forceAnswerShortcutBinding = new PersistentGlobalShortcut(
    globalShortcut,
    FORCE_ANSWER_SHORTCUT,
    deliverForcedAnswerToOverlay,
    (accelerator) => {
      console.warn(`[overlay] global shortcut unavailable, retrying: ${accelerator}`);
      scheduleForceAnswerShortcutRetry();
    },
  );
  if (!forceAnswerShortcutBinding.ensureRegistered()) scheduleForceAnswerShortcutRetry();
}

function registerShortcuts(): void {
  const stored = loadMainSettings().toggleOverlayShortcut;
  if (typeof stored === 'string' && stored.trim() && registerToggleShortcut(stored.trim())) {
    toggleOverlayShortcut = stored.trim();
  } else {
    registerToggleShortcut(DEFAULT_TOGGLE_SHORTCUT);
    toggleOverlayShortcut = DEFAULT_TOGGLE_SHORTCUT;
  }
  registerForceAnswerShortcut();
}

function createTray(): void {
  tray = new Tray(BRAND_ICON);
  tray.setToolTip('SkillCue');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Открыть',
        click: () => {
          if (isLiveWindow(mainWindow)) mainWindow.show();
        },
      },
      { label: 'Overlay', click: () => getOrCreateOverlayWindow().show() },
      { type: 'separator' },
      { label: 'Выход', click: () => app.quit() },
    ]),
  );
}

function setupAutoUpdater(): void {
  if (isDev) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) =>
    updaterStatusStore.publish({ state: 'available', version: info.version }),
  );
  autoUpdater.on('update-not-available', () => updateCoordinator.markNoUpdate());
  autoUpdater.on('download-progress', (p) =>
    updaterStatusStore.publish({
      state: 'downloading',
      version: updaterStatusStore.get().version,
      percent: Math.round(p.percent),
    }),
  );
  autoUpdater.on('update-downloaded', (info) =>
    updateCoordinator.markDownloaded(info.version),
  );
  autoUpdater.on('error', (err) =>
    updateCoordinator.resetAfterError(String(err?.message ?? err)),
  );
  // Backwards compatibility for renderer bundles from before automatic install.
  ipcMain.handle('updater:install', () => updateCoordinator.requestInstall());
  void updateCoordinator.check().catch((err: unknown) => {
    if (updaterStatusStore.get().state !== 'error') {
      updateCoordinator.resetAfterError(String(err instanceof Error ? err.message : err));
    }
  });
}

function setupDisplayMedia(): void {
  // Позволяет renderer захватывать системный звук (голос собеседника)
  // через getDisplayMedia. На Windows audio: 'loopback' даёт системный звук.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          callback({ video: sources[0], audio: 'loopback' });
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );
}

// --- Deep link skillcue://activate?key=… — авто-активация лицензии после
// оплаты на сайте (страница успеха ЮKassa ведёт на эту ссылку). ------------
const DEEP_LINK_PROTOCOL = 'skillcue';
if (isDev && process.argv.length >= 2) {
  // Dev (electron .): регистрируем с явным путём к процессу и точке входа.
  app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL, process.execPath, [
    path.resolve(process.argv[1]),
  ]);
} else {
  app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL);
}

function extractActivationKey(url: string | undefined): string | null {
  if (!url || !url.startsWith(`${DEEP_LINK_PROTOCOL}://`)) return null;
  try {
    const parsed = new URL(url);
    const action = parsed.hostname || parsed.pathname.replace(/\//g, '');
    return action === 'activate' ? parsed.searchParams.get('key') : null;
  } catch {
    return null;
  }
}

function flushDeepLink(): void {
  if (!pendingDeepLinkKey || !mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isLoading()) return; // окно грузится — дошлём на did-finish-load
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('deeplink:activate', pendingDeepLinkKey);
  pendingDeepLinkKey = null;
}

function deliverDeepLink(url: string | undefined): void {
  const key = extractActivationKey(url);
  if (!key) return;
  pendingDeepLinkKey = key;
  flushDeepLink();
}

// Одна копия приложения: повторный запуск (в т.ч. по ссылке активации)
// фокусирует уже открытое окно, а не плодит вторую копию.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // Windows/Linux: URL приходит в argv второго процесса.
    const deepLink = argv.find((a) => a.startsWith(`${DEEP_LINK_PROTOCOL}://`));
    if (deepLink) {
      deliverDeepLink(deepLink);
      return;
    }
    if (!isLiveWindow(mainWindow)) mainWindow = createMainWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  // macOS доставляет протокол отдельным событием.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    deliverDeepLink(url);
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    void ensureBackend();
    setupContentSecurityPolicy();
    setupDisplayMedia();
    hhBrowserAssistant = new HhBrowserAssistant(app.getPath('userData'), (state) => {
      sendToWindows('hh-assistant:state', state);
    });
    hhBrowserAssistant.restoreSchedule();

    // Инициализируем HH OAuth и Chat-ассистент (браузерный)
    hhOAuthService = new HhOAuthService(app.getPath('userData'));
    hhChatBrowser = new HhChatBrowser(
      app.getPath('userData'),
      // Фоновый чат работает в отдельной вкладке и не перехватывает поиск/отклик.
      async () => {
        return hhBrowserAssistant?.getChatPage() ?? null;
      },
      // llmCall: вызываем LLM через локальный бэкенд
      async (prompt: string) => {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (API_TOKEN) {
          headers['X-SkillCue-Token'] = API_TOKEN;
        }

        const res = await fetch(`${API_URL}/chat`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            message: prompt,
            mode: 'general',
            answer_language: 'ru',
          }),
        });

        if (!res.ok) {
          throw new Error(`LLM error ${res.status}`);
        }

        const text = await res.text();
        const chunks: string[] = [];
        for (const line of text.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          let evt: { type?: string; text?: string; message?: string };
          try {
            evt = JSON.parse(line.slice(6)) as typeof evt;
          } catch {
            continue;
          }
          if (evt.type === 'chunk' && evt.text) chunks.push(evt.text);
          if (evt.type === 'error') throw new Error(evt.message || 'LLM stream error');
        }
        return chunks.join('').trim();
      },
    );

    // Запускаем браузерный чат, если был включён
    if (hhChatBrowser.getState().enabled) {
      hhChatBrowser.startPolling();
    }
    registerIpc();
    mainWindow = createMainWindow();
    overlayWindow = createOverlayWindow();
    registerShortcuts();
    createTray();
    setupAutoUpdater();
    // Холодный старт по ссылке (Windows/Linux): URL лежит в argv запуска.
    deliverDeepLink(process.argv.find((a) => a.startsWith(`${DEEP_LINK_PROTOCOL}://`)));
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    // Плановый выход: 'exit' убитого бэкенда не должен запускать рестарт.
    quitting = true;
    if (backendRestartTimer) clearTimeout(backendRestartTimer);
    hhChatBrowser?.dispose();
    hhOAuthService?.dispose();
    if (!closingHhBrowserForQuit && hhBrowserAssistant?.getState().browserOpen) {
      event.preventDefault();
      closingHhBrowserForQuit = true;
      void Promise.race([
        hhBrowserAssistant.close(),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]).finally(() => app.quit());
    }
  });

  app.on('will-quit', () => {
    quitting = true;
    if (forceAnswerShortcutRetryTimer) clearTimeout(forceAnswerShortcutRetryTimer);
    forceAnswerShortcutRetryTimer = null;
    forceAnswerShortcutBinding?.dispose();
    forceAnswerShortcutBinding = null;
    globalShortcut.unregisterAll();
    stopBackend();
    backendLogStream?.end();
  });
}
