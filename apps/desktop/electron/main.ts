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
import { spawn, type ChildProcess } from 'child_process';
import { autoUpdater } from 'electron-updater';

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:8000';
const isDev = !app.isPackaged;

// SkillCue mark (indigo rounded square) — used for the tray + window icon so
// neither is blank. A full multi-res .ico for the installer is a separate asset.
const BRAND_ICON = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAWElEQVR42u3XsQkAIAwF0ewquL8TaGejBJSYBLyA9b3SL6Jcqa1bPDk5q+gV5nVcRXjFtwjv+IL4GxAVnwgAAAAAAAAAAIBwAH/CFIDwYZJimqUYpxHzfABg0BWrfAI5+AAAAABJRU5ErkJggg==',
);

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let backendProcess: ChildProcess | null = null;

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
    backendProcess.stdout?.on('data', (d) => console.log('[backend]', String(d).trim()));
    backendProcess.stderr?.on('data', (d) => console.log('[backend]', String(d).trim()));
    backendProcess.on('exit', (code) => {
      console.warn('[backend] process exited:', code);
      backendProcess = null;
    });
    backendProcess.on('error', (err) => {
      console.warn('[backend] failed to launch:', err.message);
      backendProcess = null;
    });
  } catch (err) {
    console.warn('[backend] could not start:', err);
  }
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

/** Only allow opening https links in the OS browser. */
function safeOpenExternal(url: string): void {
  try {
    if (new URL(url).protocol === 'https:') {
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

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[electron] did-fail-load', code, desc, url);
  });

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
    width: 1400,
    height: 780,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    show: false,
    focusable: true,
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
  ipcMain.handle('app:openExternal', (_e, url: string) => safeOpenExternal(url));

  ipcMain.handle('overlay:toggle', () => {
    if (!overlayWindow) return;
    if (overlayWindow.isVisible()) hideOverlay();
    else overlayWindow.show();
  });

  ipcMain.handle('overlay:show', () => overlayWindow?.show());
  ipcMain.handle('overlay:hide', () => hideOverlay());

  ipcMain.handle('overlay:openSettings', () => {
    if (!mainWindow) return;
    overlayWindow?.hide();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('app:navigate', '/settings');
  });

  ipcMain.handle('overlay:setContentProtection', (_e, enable: boolean) => {
    overlayWindow?.setContentProtection(enable);
    mainWindow?.setContentProtection(enable);
  });

  ipcMain.handle('window:setSkipTaskbar', (_e, skip: boolean) => {
    mainWindow?.setSkipTaskbar(skip);
  });
}

function registerShortcuts(): void {
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    if (!overlayWindow) return;
    if (overlayWindow.isVisible()) hideOverlay();
    else overlayWindow.show();
  });

  globalShortcut.register('Escape', () => hideOverlay());
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

app.whenReady().then(() => {
  void ensureBackend();
  setupContentSecurityPolicy();
  setupDisplayMedia();
  registerIpc();
  mainWindow = createMainWindow();
  overlayWindow = createOverlayWindow();
  registerShortcuts();
  createTray();
  setupAutoUpdater();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopBackend();
});
