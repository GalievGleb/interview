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
let quitting = false;
// Ключ лицензии из ссылки skillcue://activate?key=… ждёт здесь, пока окно
// не догрузится (холодный старт по ссылке), затем уходит в рендерер.
let pendingDeepLinkKey: string | null = null;

// Живой процесс не перезапускаем бесконечно: 3 попытки, дальше баннер «не в сети».
const MAX_BACKEND_RESTARTS = 3;

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
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONPATH: '.',
      SKILLCUE_PORT: new URL(API_URL).port || '8000',
      SKILLCUE_API_TOKEN: API_TOKEN,
      // Бэкенд подхватит как settings.skillcue_gateway_url (BYOK-фолбэк на гейтвей).
      SKILLCUE_GATEWAY_URL,
    };
    if (app.isPackaged) {
      // Use the bundled, pre-downloaded Whisper cache so the first run is offline.
      env.SKILLCUE_MODELS_DIR = path.join(process.resourcesPath, 'models');
    }
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

/** После запуска ждём health (модель Whisper грузится не мгновенно) и
 *  сообщаем renderer'у «ок» — счётчик рестартов обнуляется. */
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
    titleBarOverlay: {
      color: '#0c1726',
      symbolColor: '#c7d3e2',
      height: 52,
    },
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
  overlayWindow?.hide();
  mainWindow?.show();
  mainWindow?.focus();
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
  void win.loadURL(overlayRoute);
  win.hide();
  return win;
}

function registerIpc(): void {
  ipcMain.handle('app:getApiUrl', () => API_URL);
  ipcMain.handle('app:getApiToken', () => API_TOKEN);
  ipcMain.handle('app:openExternal', (_e, url: string) => safeOpenExternal(url));
  // «Выйти из SkillCue» в настройках — то же, что «Выход» в трее.
  ipcMain.handle('app:quit', () => app.quit());

  ipcMain.handle('keybinds:get', () => ({
    toggleOverlay: toggleOverlayShortcut,
    defaultToggleOverlay: DEFAULT_TOGGLE_SHORTCUT,
  }));

  ipcMain.handle('keybinds:setToggleOverlay', (_e, acc: string) => {
    const next = typeof acc === 'string' && acc.trim() ? acc.trim() : DEFAULT_TOGGLE_SHORTCUT;
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
    if (!overlayWindow) return;
    if (overlayWindow.isVisible()) hideOverlay();
    else overlayWindow.show();
  });

  ipcMain.handle('overlay:show', () => overlayWindow?.show());
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
    // Клик по логотипу в пилле: поднять главное окно, оверлей не трогаем.
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
  });

  ipcMain.handle('overlay:openSettings', (_e, section?: string) => {
    if (!mainWindow) return;
    overlayWindow?.hide();
    mainWindow.show();
    mainWindow.focus();
    const safe = section && /^[a-z-]+$/.test(section) ? `?tab=${section}` : '';
    mainWindow.webContents.send('app:navigate', `/settings${safe}`);
  });

  ipcMain.handle('overlay:setContentProtection', (_e, enable: boolean) => {
    overlayWindow?.setContentProtection(enable);
    mainWindow?.setContentProtection(enable);
  });

  ipcMain.handle('overlay:move', (_e, dx: number, dy: number) => {
    // Перемещение окна оверлея с клавиатуры (Ctrl+стрелки), как «Move Cluely».
    if (!overlayWindow) return;
    const [x, y] = overlayWindow.getPosition();
    overlayWindow.setPosition(Math.round(x + dx), Math.round(y + dy));
  });

  ipcMain.handle('overlay:setFocusable', (_e, focusable: boolean) => {
    // «Не забирать фокус»: оверлей не становится активным окном, фокус
    // остаётся в приложении под ним. Внимание: при false ввод в поле
    // оверлея недоступен, поэтому включается осознанно из меню.
    overlayWindow?.setFocusable(focusable);
  });

  ipcMain.handle('overlay:setClickThrough', (_e, enable: boolean) => {
    // Клики проходят «сквозь» оверлей в приложение под ним. forward:true шлёт
    // события движения курсора в рендерер, чтобы он мог временно вернуть
    // интерактивность при наведении на свои элементы (см. OverlayPage).
    overlayWindow?.setIgnoreMouseEvents(enable, { forward: true });
  });

  ipcMain.handle('overlay:resize', (_e, dw: number, dh: number) => {
    if (!overlayWindow) return;
    const [w, h] = overlayWindow.getSize();
    const nw = Math.max(420, Math.min(1400, Math.round(w + (dw || 0))));
    const nh = Math.max(360, Math.min(1200, Math.round(h + (dh || 0))));
    overlayWindow.setSize(nw, nh, false);
  });

  ipcMain.handle('overlay:liveState', (_e, active: boolean) => {
    // Live-сессия крутится в окне оверлея; главное окно не видит его событий,
    // поэтому пробрасываем состояние туда — сайдбар-хронометр и веха активации.
    mainWindow?.webContents.send('app:live-state', !!active);
  });

  ipcMain.handle('window:setSkipTaskbar', (_e, skip: boolean) => {
    mainWindow?.setSkipTaskbar(skip);
  });

  ipcMain.handle('app:getVersion', () => app.getVersion());

  ipcMain.handle('updater:check', async () => {
    // Ручная проверка из настроек. В dev автообновление не настроено.
    if (isDev) return { state: 'none' as const, message: 'dev-режим: обновления недоступны' };
    try {
      const result = await autoUpdater.checkForUpdates();
      const version = result?.updateInfo?.version;
      if (version && version !== app.getVersion()) {
        return { state: 'available' as const, version };
      }
      return { state: 'none' as const };
    } catch (err) {
      return { state: 'error' as const, message: String(err instanceof Error ? err.message : err) };
    }
  });

  ipcMain.handle('app:getAutoLaunch', () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle('app:setAutoLaunch', (_e, enable: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enable });
  });
}

/* ---- Настройки main-процесса (нужны до готовности renderer'а) ---- */

const DEFAULT_TOGGLE_SHORTCUT = 'CommandOrControl+Shift+H';
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
  if (!overlayWindow) return;
  if (overlayWindow.isVisible()) hideOverlay();
  else overlayWindow.show();
}

function registerToggleShortcut(acc: string): boolean {
  try {
    return globalShortcut.register(acc, toggleOverlay);
  } catch {
    return false;
  }
}

function registerShortcuts(): void {
  const stored = loadMainSettings().toggleOverlayShortcut;
  if (typeof stored === 'string' && stored.trim() && registerToggleShortcut(stored.trim())) {
    toggleOverlayShortcut = stored.trim();
  } else {
    registerToggleShortcut(DEFAULT_TOGGLE_SHORTCUT);
    toggleOverlayShortcut = DEFAULT_TOGGLE_SHORTCUT;
  }

  // Escape прячет оверлей, но глобальный хук живёт ТОЛЬКО пока оверлей виден —
  // постоянная регистрация отбирала Esc у всех остальных приложений системы.
  overlayWindow?.on('show', () => {
    try {
      globalShortcut.register('Escape', () => hideOverlay());
    } catch {
      /* занято другим приложением — не критично */
    }
  });
  overlayWindow?.on('hide', () => globalShortcut.unregister('Escape'));
}

function createTray(): void {
  tray = new Tray(BRAND_ICON);
  tray.setToolTip('SkillCue');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Открыть', click: () => mainWindow?.show() },
      { label: 'Overlay', click: () => overlayWindow?.show() },
      { type: 'separator' },
      { label: 'Выход', click: () => app.quit() },
    ]),
  );
}

function setupAutoUpdater(): void {
  if (isDev) return;
  const send = (status: unknown) => mainWindow?.webContents.send('updater:status', status);
  autoUpdater.on('update-available', (info) =>
    send({ state: 'available', version: info.version }),
  );
  autoUpdater.on('download-progress', (p) =>
    send({ state: 'downloading', percent: Math.round(p.percent) }),
  );
  autoUpdater.on('update-downloaded', (info) => send({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => send({ state: 'error', message: String(err?.message ?? err) }));
  ipcMain.handle('updater:install', () => autoUpdater.quitAndInstall());
  autoUpdater.checkForUpdatesAndNotify();
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
    deliverDeepLink(argv.find((a) => a.startsWith(`${DEEP_LINK_PROTOCOL}://`)));
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

  app.on('before-quit', () => {
    // Плановый выход: 'exit' убитого бэкенда не должен запускать рестарт.
    quitting = true;
    if (backendRestartTimer) clearTimeout(backendRestartTimer);
  });

  app.on('will-quit', () => {
    quitting = true;
    globalShortcut.unregisterAll();
    stopBackend();
    backendLogStream?.end();
  });
}
