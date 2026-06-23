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
import { autoUpdater } from 'electron-updater';

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:8000';
const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

function getPreloadPath(): string {
  return path.join(__dirname, 'preload.js');
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 880,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f1117',
    title: 'Interview & Meeting Copilot',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[electron] did-fail-load', code, desc, url);
  });

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
    width: 900,
    height: 420,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: true,
    show: false,
    focusable: true,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const overlayRoute = isDev
    ? 'http://localhost:5173/#/overlay'
    : `file://${path.join(__dirname, '../dist/index.html')}#/overlay`;
  void win.loadURL(overlayRoute);
  win.hide();
  return win;
}

function registerIpc(): void {
  ipcMain.handle('app:getApiUrl', () => API_URL);
  ipcMain.handle('app:openExternal', (_e, url: string) => shell.openExternal(url));

  ipcMain.handle('overlay:toggle', () => {
    if (!overlayWindow) return;
    if (overlayWindow.isVisible()) hideOverlay();
    else overlayWindow.show();
  });

  ipcMain.handle('overlay:show', () => overlayWindow?.show());
  ipcMain.handle('overlay:hide', () => hideOverlay());
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
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('Interview & Meeting Copilot');
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
});
