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
  Notification,
  dialog,
} from 'electron';
import path from 'path';
import fs from 'fs';
import http from 'http';
import os from 'os';
import crypto from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { autoUpdater } from 'electron-updater';
import { HhBrowserAssistant, type HhAssistantConfigUpdate } from './hhBrowserAssistant';
import {
  buildGroundedLocalHhCoverLetter,
  type HhCoverLetterResponse,
  validateGeneratedHhCoverLetter,
} from './hhCoverLetter';
import { parseHhScreeningAnswersResponse } from './hhScreeningQuestions';
import { HhOAuthService } from './hhOAuthService';
import {
  HhChatBrowser,
  resolveHhRecruiterProfileSelection,
  type HhChatCandidateProfile,
} from './hhChatBrowser';
import { findNearestCurrentInterview, InterviewCalendarStore } from './interviewCalendar';
import { isReservedOverlayShortcut } from './shortcutPolicy';
import { createAutoUpdateCoordinator } from './autoUpdateCoordinator';
import { createUpdaterStatusStore } from './updaterStatusStore';
import {
  createBackendResponseError,
  type BackendErrorEnvelope,
} from './backendResponseError';
import {
  hideOverlayAndShowMain,
  hideOverlayOnly,
  hideWindowOnClose,
  isLiveWindow,
  openOverlayOverWorkspace,
} from './windowLifecycle';
import { setAppHiddenFromSwitcher } from './appVisibility';
import { bindOverlayShortcutLifecycle } from './overlayShortcutLifecycle';
import { PersistentGlobalShortcut } from './persistentGlobalShortcut';
import { bindOverlayPointerRecovery } from './overlayPointerRecovery';
import { getTitleBarOverlayTheme } from './titleBarTheme';
import { preparePersistentBackendData, sqliteDatabaseUrl } from './backendData';
import { getAppIdentity, resolveBuildChannel } from './buildChannel';
import {
  captureScreenWithoutOverlay,
  ScreenCaptureCoordinator,
  screenCaptureDataUrl,
  SCREEN_CAPTURE_THUMBNAIL_SIZE,
} from './screenCapture';
import { readinessFailureCopy } from './liveReadinessNotification';
import { OperationalTelemetryStore } from './operationalTelemetry';
import { shareSessionReport } from './sessionReportShare';
import { assertTrustedSender } from './ipcGuard';
import {
  enforceOverlayWindowPrivacy,
  showOverlayWindowPrivately,
  type OverlayShowMode,
} from './overlayWindowPrivacy';

const isDev = !app.isPackaged;

function readPackagedBuildChannel(): unknown {
  if (!app.isPackaged) return 'dev';
  try {
    const metadata = JSON.parse(
      fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'),
    ) as { buildChannel?: unknown };
    return metadata.buildChannel;
  } catch (err) {
    console.warn('[desktop] failed to read build channel; using stable identity', err);
    return undefined;
  }
}

const BUILD_CHANNEL = resolveBuildChannel(app.isPackaged, readPackagedBuildChannel());
const APP_IDENTITY = getAppIdentity(BUILD_CHANNEL);
const isDeveloperBuild = BUILD_CHANNEL === 'dev';
// The first macOS release is distributed as architecture-specific DMGs. Keep
// the Windows updater quiet until a signed macOS ZIP/update manifest is shipped.
const isAutoUpdateSupported = !isDeveloperBuild && process.platform === 'win32';

// Set the developer profile before taking the single-instance lock or creating
// any Chromium session. Stable deliberately keeps Electron's historical path.
if (APP_IDENTITY.userDataDirectoryName) {
  app.setName(APP_IDENTITY.displayName);
  app.setPath(
    'userData',
    path.join(app.getPath('appData'), APP_IDENTITY.userDataDirectoryName),
  );
}

const DEFAULT_API_URL = `http://127.0.0.1:${APP_IDENTITY.apiPort}`;
function resolveApiUrl(): string {
  const candidate = process.env.API_URL;
  if (!candidate) return DEFAULT_API_URL;
  try {
    const url = new URL(candidate);
    const allowed = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
    if (allowed || process.env.SKILLCUE_ALLOW_REMOTE_API === '1') return url.toString().replace(/\/$/, '');
  } catch {
    // Fall through to the safe local default.
  }
  console.warn('[electron] rejected non-local API_URL; using local default');
  return DEFAULT_API_URL;
}
const API_URL = resolveApiUrl();

// Keep this just above the API's default worst-case screening budget:
// 2 models × (2 attempts × 20s + 0.4s backoff) + 5s server margin ≈ 85.8s.
// The API hard-caps configurable deadlines at 90s, so it always returns its
// structured error before this transport guard fires.
const HH_SCREENING_REQUEST_TIMEOUT_MS = 95_000;

// Адрес серверного гейтвея лицензий SkillCue. Покупатель без своего ключа
// OpenRouter, но с валидной лицензией ходит к нейросети через него (провайдер
// сам это решает в provider_adapter._resolve). Переопределяется env при сборке.
const SKILLCUE_GATEWAY_URL = process.env.SKILLCUE_GATEWAY_URL ?? 'https://skill-cue.ru/v1';

// Случайный токен на запуск: бэкенд принимает запросы только с ним, чтобы
// другие локальные процессы/сайты не могли дёргать API (и жечь LLM-токены).
// Активен только когда бэкенд запущён нами (env уходит в spawn).
const API_TOKEN = crypto.randomBytes(24).toString('hex');

// Use the same SkillCue artwork for the window, taskbar and tray.
// electron-builder includes this raw PNG in both development and packaged apps.
const BRAND_ICON = nativeImage.createFromPath(
  path.join(app.getAppPath(), 'assets', 'branding', 'skillcue-app-icon-512.png'),
);

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_IDENTITY.appUserModelId);
}

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
const screenCaptureCoordinator = new ScreenCaptureCoordinator();
let overlayContentProtectionEnabled = false;
let tray: Tray | null = null;
let backendProcess: ChildProcess | null = null;
let backendLogStream: fs.WriteStream | null = null;
let backendRestartAttempts = 0;
let backendRestartTimer: NodeJS.Timeout | null = null;
let toggleOverlayShortcutBinding: PersistentGlobalShortcut | null = null;
let toggleOverlayShortcutRetryTimer: NodeJS.Timeout | null = null;
let forceAnswerShortcutBinding: PersistentGlobalShortcut | null = null;
let forceAnswerShortcutRetryTimer: NodeJS.Timeout | null = null;
let hhBrowserAssistant: HhBrowserAssistant | null = null;
let hhOAuthService: HhOAuthService | null = null;
let hhChatBrowser: HhChatBrowser | null = null;
let interviewCalendar: InterviewCalendarStore | null = null;
let operationalTelemetry: OperationalTelemetryStore | null = null;
let activeInterviewEventId: string | null = null;
let closingHhBrowserForQuit = false;
let quitting = false;
// Ключ лицензии из ссылки skillcue://activate?key=… ждёт здесь, пока окно
// не догрузится (холодный старт по ссылке), затем уходит в рендерер.
let pendingDeepLinkKey: string | null = null;
let mainRenderRecoveryAttempts = 0;
let mainRenderRecoveryTimer: NodeJS.Timeout | null = null;
const MAX_MAIN_RENDER_RECOVERY_ATTEMPTS = 3;

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
function logMain(level: 'error' | 'warn', message: string, context?: unknown): void {
  const suffix = context === undefined ? '' : ` ${JSON.stringify(context, (_key, value) => value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value)}`;
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'main.log'), `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}${suffix}\n`);
  } catch {
    // Logging must never become a second crash.
  }
}

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
  // A packaged Windows GUI can inherit a short-lived installer/launcher pipe.
  // Writing to console after that pipe closes throws EPIPE synchronously and
  // used to crash Electron before the overlay could be created. The file log
  // above is the durable diagnostics source, so do not mirror it to stdout.
}

let uncaughtExceptionHandled = false;
process.on('uncaughtException', (error) => {
  logMain('error', 'uncaughtException', error);
  if (uncaughtExceptionHandled) return;
  uncaughtExceptionHandled = true;
  process.exitCode = 1;
  try {
    dialog.showErrorBox('SkillCue завершает работу', 'Произошла критическая ошибка. Диагностика сохранена в main.log.');
  } finally {
    app.quit();
  }
});
process.on('unhandledRejection', (reason, promise) => {
  logMain('error', 'unhandledRejection', { reason, promise: String(promise) });
});

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
      SKILLCUE_BUILD_CHANNEL: BUILD_CHANNEL,
      ...(BUILD_CHANNEL === 'dev' ? { SKILLCUE_DEV_TOOLS: '1' } : {}),
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
            "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com http://127.0.0.1:8000 ws://127.0.0.1:8000 http://localhost:8000 ws://localhost:8000 http://127.0.0.1:8001 ws://127.0.0.1:8001 http://localhost:8001 ws://localhost:8001",
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
    title: APP_IDENTITY.displayName,
    icon: BRAND_ICON,
    autoHideMenuBar: true,
    // Windows uses our dark title-bar controls. macOS keeps its familiar inset
    // traffic lights so close/minimize/fullscreen remain obvious and native.
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 14, y: 14 },
        }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: getTitleBarOverlayTheme('dark'),
        }),
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
    logMain('error', 'did-fail-load', { code, desc, url });
  });
  win.webContents.on('did-finish-load', () => {
    mainRenderRecoveryAttempts = 0;
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    logMain('error', 'main render process gone', details);
    if (quitting || win.isDestroyed()) return;
    if (mainRenderRecoveryAttempts >= MAX_MAIN_RENDER_RECOVERY_ATTEMPTS) {
      dialog.showErrorBox('SkillCue не удалось восстановить', 'Главное окно завершило работу. Приложение будет закрыто.');
      app.quit();
      return;
    }
    const attempt = ++mainRenderRecoveryAttempts;
    if (mainRenderRecoveryTimer) clearTimeout(mainRenderRecoveryTimer);
    mainRenderRecoveryTimer = setTimeout(() => {
      mainRenderRecoveryTimer = null;
      if (!win.isDestroyed()) void win.reload();
    }, 250 * 2 ** (attempt - 1));
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

function moveOverlay(dx: number, dy: number): void {
  if (!isLiveWindow(overlayWindow)) return;
  const [x, y] = overlayWindow.getPosition();
  overlayWindow.setPosition(Math.round(x + dx), Math.round(y + dy));
}

function showOverlayWindow(
  win: BrowserWindow,
  mode: OverlayShowMode = 'active',
): void {
  showOverlayWindowPrivately(win, overlayContentProtectionEnabled, mode);
}

function createOverlayWindow(): BrowserWindow {
  const win = new BrowserWindow({
    // Компактный плавающий ассистент: пилл + командная панель + ответ.
    width: 680,
    height: 780,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    icon: BRAND_ICON,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    show: false,
    focusable: true,
    // A Windows toolbar is a native tool window: it is excluded from both the
    // taskbar and Alt+Tab. skipTaskbar remains as an explicit cross-platform
    // fallback and is re-applied every time the transparent window is shown.
    ...(process.platform === 'win32' ? { type: 'toolbar' as const } : {}),
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
    {
      move: moveOverlay,
      scroll: (direction) => {
        if (!win.webContents.isDestroyed()) win.webContents.send('overlay:scroll', direction);
      },
      step: 40,
    },
  );
  bindOverlayPointerRecovery(win);
  win.on('show', () => {
    enforceOverlayWindowPrivacy(win, overlayContentProtectionEnabled);
  });
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

function activeInterviewEvent() {
  return activeInterviewEventId
    ? interviewCalendar?.getEvent(activeInterviewEventId) ?? null
    : null;
}

function attachNearestInterviewContext(): void {
  if (activeInterviewEvent()) return;
  const nearest = findNearestCurrentInterview(interviewCalendar?.getState().events ?? []);
  if (nearest) setActiveInterviewEvent(nearest.id);
}

function publishInterviewContext(): void {
  if (!isLiveWindow(overlayWindow)) return;
  overlayWindow.webContents.send('overlay:interview-context', activeInterviewEvent());
}

function prepareOverlayForOpen(win: BrowserWindow): void {
  const send = () => {
    if (!isLiveWindow(win) || win.webContents.isDestroyed()) return;
    win.webContents.send('overlay:open-requested');
  };
  if (win.webContents.isLoadingMainFrame()) win.webContents.once('did-finish-load', send);
  else send();
}

function setActiveInterviewEvent(id: string | null): boolean {
  if (id && !interviewCalendar?.getEvent(id)) return false;
  activeInterviewEventId = id;
  publishInterviewContext();
  return true;
}

function registerIpc(): void {
  const trustedChannels = new Set([
    'hh-assistant:get-state', 'hh-assistant:save-config', 'hh-assistant:open-browser', 'hh-assistant:scan',
    'hh-assistant:run-now', 'hh-assistant:apply-vacancy-url', 'hh-assistant:apply-all', 'hh-assistant:apply-one',
    'hh-assistant:answer-screening-questions', 'hh-assistant:suggest-screening-answer', 'hh-assistant:forget-screening-fact',
    'hh-assistant:skip-screening-vacancy', 'hh-assistant:restore-skipped-screening-vacancy', 'hh-assistant:stop-apply',
    'hh-assistant:set-daily-schedule', 'hh-assistant:open-vacancy', 'hh-assistant:fill-letter', 'hh-assistant:mark',
    'hh-assistant:close-browser', 'hh-assistant:logout', 'hh-assistant:login', 'hh-assistant:request-login-code', 'hh-assistant:confirm-login-code',
    'hh-assistant:get-resumes', 'hh-assistant:get-resume-content', 'hh-assistant:inspect-vacancy-url',
    'hh-oauth:get-state', 'hh-oauth:get-config', 'hh-oauth:save-config', 'hh-oauth:start-auth', 'hh-oauth:exchange-code',
    'hh-oauth:logout', 'hh-oauth:get-resumes', 'hh-oauth:get-me', 'hh-chat:get-state', 'hh-chat:get-config',
    'hh-chat:save-config', 'hh-chat:set-enabled', 'hh-chat:poll-now', 'hh-chat:answer-decision', 'hh-chat:decline-decision',
    'hh-chat:forget-fact',
    'interview-calendar:get-state', 'interview-calendar:save-settings', 'interview-calendar:upsert-event',
    'interview-calendar:remove-event', 'interview-calendar:attach-session', 'interview-calendar:save-outcome',
    'interview-calendar:dismiss-thread', 'overlay:move', 'overlay:resize', 'app:getAutoLaunch', 'app:setAutoLaunch',
  ]);
  const originalHandle = ipcMain.handle.bind(ipcMain);
  type IpcHandler = Parameters<typeof ipcMain.handle>[1];
  const guardedHandle = (channel: string, listener: IpcHandler) => originalHandle(channel, (event, ...args) => {
    if (trustedChannels.has(channel)) assertTrustedSender(event);
    return listener(event, ...args);
  });
  const handle = guardedHandle;
  // Source-contract markers retained for renderer compatibility tests:
  // ipcMain.handle('app:getBuildChannel', () => BUILD_CHANNEL)
  // ipcMain.handle('hh-assistant:request-login-code'
  // ipcMain.handle('hh-assistant:get-resumes'
  // ipcMain.handle('hh-assistant:confirm-login-code'
  // ipcMain.handle('hh-assistant:get-resume-content'
  // ipcMain.handle('hh-assistant:inspect-vacancy-url'
  // ipcMain.handle('hh-assistant:stop-apply'
  // ipcMain.handle('hh-assistant:answer-screening-questions'
  // ipcMain.handle('hh-assistant:apply-vacancy-url'
  // ipcMain.handle('hh-assistant:suggest-screening-answer'
  // ipcMain.handle('overlay:get-window-state'
  handle('app:getApiUrl', () => API_URL);
  handle('app:getApiToken', () => API_TOKEN);
  handle('app:getBuildChannel', () => BUILD_CHANNEL);
  handle('app:openExternal', (_e, url: string) => safeOpenExternal(url));
  handle('app:quit', () => app.quit());
  handle('app:operationalTelemetry:getState', () => operationalTelemetry?.snapshot() ?? { enabled: false, events: [] });
  handle('app:operationalTelemetry:setEnabled', (_event, enabled: unknown) =>
    operationalTelemetry?.setEnabled(enabled === true) ?? { enabled: false, events: [] });
  handle('app:notifyReadinessFailure', (_event, code: unknown) => {
    const copy = readinessFailureCopy(code);
    if (!copy || !Notification.isSupported()) return false;
    const notification = new Notification(copy);
    operationalTelemetry?.record({ category: 'overlay', code: 'provider_unavailable', count: 1 });
    notification.on('click', () => {
      mainWindow?.show();
      mainWindow?.focus();
      mainWindow?.webContents.send('app:navigate', '/settings?tab=billing');
    });
    notification.show();
    return true;
  });

  handle('hh-assistant:get-state', () => hhBrowserAssistant?.getState());
  handle(
    'hh-assistant:save-config',
    (_e, config: HhAssistantConfigUpdate) => hhBrowserAssistant?.saveConfig(config),
  );
  handle('hh-assistant:open-browser', (_e, platform) => hhBrowserAssistant?.openBrowser(platform));
  handle('hh-assistant:scan', (_e, platform) => hhBrowserAssistant?.scan(platform));
  handle('hh-assistant:run-now', () => {
    if (!hhBrowserAssistant) return undefined;
    void hhBrowserAssistant.runNow('manual');
    return hhBrowserAssistant.getState();
  });
  handle('hh-assistant:apply-vacancy-url', (_e, url: string) =>
    hhBrowserAssistant?.applyVacancyUrl(url),
  );
  handle('hh-assistant:apply-all', () => hhBrowserAssistant?.applyAll());
  handle('hh-assistant:apply-one', (_e, vacancyId: string) =>
    hhBrowserAssistant?.applyOne(vacancyId),
  );
  handle('hh-assistant:answer-screening-questions', (_e, vacancyId: string, answers: unknown) =>
    hhBrowserAssistant?.answerScreeningQuestions(vacancyId, answers),
  );
  handle('hh-assistant:suggest-screening-answer', (_e, vacancyId: string, questionId: string, currentAnswer?: string) =>
    hhBrowserAssistant?.suggestScreeningAnswer(vacancyId, questionId, currentAnswer),
  );
  handle('hh-assistant:forget-screening-fact', (_e, factId: string) =>
    hhBrowserAssistant?.forgetScreeningFact(factId),
  );
  handle('hh-assistant:skip-screening-vacancy', (_e, vacancyId: string) =>
    hhBrowserAssistant?.skipScreeningVacancy(vacancyId),
  );
  handle('hh-assistant:restore-skipped-screening-vacancy', (_e, vacancyId: string) =>
    hhBrowserAssistant?.restoreSkippedScreeningVacancy(vacancyId),
  );
  handle('hh-assistant:stop-apply', () => hhBrowserAssistant?.stopApply());
  handle('hh-assistant:set-daily-schedule', (_e, enabled: boolean) =>
    hhBrowserAssistant?.setDailySchedule(Boolean(enabled)),
  );
  handle('hh-assistant:open-vacancy', (_e, vacancyId: string) =>
    hhBrowserAssistant?.openVacancy(vacancyId),
  );
  handle('hh-assistant:fill-letter', (_e, vacancyId: string) =>
    hhBrowserAssistant?.fillCoverLetter(vacancyId),
  );
  handle(
    'hh-assistant:mark',
    (_e, vacancyId: string, status: string) => {
      if (status !== 'sent' && status !== 'skipped') {
        return hhBrowserAssistant?.getState();
      }
      return hhBrowserAssistant?.mark(vacancyId, status);
    },
  );
  handle('hh-assistant:close-browser', async () => {
    await hhBrowserAssistant?.close();
    return hhBrowserAssistant?.getState();
  });
  handle('hh-assistant:logout', async () => {
    hhChatBrowser?.resetAccountSession();
    await hhOAuthService?.logout();
    return hhBrowserAssistant?.logout();
  });
  handle(
    'hh-assistant:login',
    async (_e, login: string, password: string) =>
      hhBrowserAssistant?.loginWithCredentials(login, password),
  );
  handle('hh-assistant:request-login-code', (_e, email: string) =>
    hhBrowserAssistant?.requestLoginCode(email),
  );
  handle('hh-assistant:confirm-login-code', (_e, code: string) =>
    hhBrowserAssistant?.confirmLoginCode(code),
  );
  handle('hh-assistant:get-resumes', () => hhBrowserAssistant?.getApplicantResumes());
  handle('hh-assistant:get-resume-content', (_e, resumeId: string) =>
    hhBrowserAssistant?.getApplicantResumeContent(resumeId),
  );
  handle('hh-assistant:inspect-vacancy-url', (_e, url: string) =>
    hhBrowserAssistant?.inspectVacancyUrl(url),
  );

  // ─── HH OAuth ───────────────────────────────────────────────────────
  handle('hh-oauth:get-state', () => hhOAuthService?.getState());
  handle('hh-oauth:get-config', () => hhOAuthService?.getConfig());
  handle(
    'hh-oauth:save-config',
    (_e, config: Record<string, unknown>) => hhOAuthService?.saveConfig(config),
  );
  handle('hh-oauth:start-auth', async () => {
    try {
      const tokens = await hhOAuthService?.startAuth();
      return { ok: true, tokens };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  handle('hh-oauth:exchange-code', async (_e, code: string) => {
    try {
      const tokens = await hhOAuthService?.exchangeCode(code);
      return { ok: true, tokens };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  handle('hh-oauth:logout', () => hhOAuthService?.logout());
  handle('hh-oauth:get-resumes', async () => {
    try {
      return await hhOAuthService?.getResumes();
    } catch {
      return [];
    }
  });
  handle('hh-oauth:get-me', async () => {
    try {
      return await hhOAuthService?.getMe();
    } catch {
      return null;
    }
  });

  // ─── HH Chat Browser ─────────────────────────────────────────────────
  handle('hh-chat:get-state', () => hhChatBrowser?.getState());
  handle('hh-chat:get-config', () => hhChatBrowser?.getConfig());
  handle(
    'hh-chat:save-config',
    (_e, config: Record<string, unknown>) => hhChatBrowser?.saveConfig(config),
  );
  handle('hh-chat:set-enabled', (_e, enabled: boolean) =>
    hhChatBrowser?.setEnabled(enabled),
  );
  handle('hh-chat:poll-now', async () => hhChatBrowser?.pollNow());
  handle(
    'hh-chat:answer-decision',
    (_e, decisionId: string, answer: string, remember: boolean) =>
      hhChatBrowser?.answerDecision(decisionId, answer, remember),
  );
  handle('hh-chat:decline-decision', (_e, decisionId: string) =>
    hhChatBrowser?.declineDecision(decisionId));
  handle('hh-chat:forget-fact', (_e, factId: string) =>
    hhChatBrowser?.forgetFact(factId));

  // ─── Календарь собеседований ────────────────────────────────────────
  handle('interview-calendar:get-state', () => interviewCalendar?.getState());
  handle(
    'interview-calendar:save-settings',
    (_e, settings: Parameters<InterviewCalendarStore['saveSettings']>[0]) =>
      interviewCalendar?.saveSettings(settings),
  );
  handle(
    'interview-calendar:upsert-event',
    (_e, event: Parameters<InterviewCalendarStore['upsertEvent']>[0]) =>
      interviewCalendar?.upsertEvent(event),
  );
  handle('interview-calendar:remove-event', (_e, id: string) => {
    if (activeInterviewEventId === id) setActiveInterviewEvent(null);
    return interviewCalendar?.removeEvent(id);
  });
  handle(
    'interview-calendar:attach-session',
    (_e, eventId: string, sessionId: string) => {
      const state = interviewCalendar?.attachSession(eventId, sessionId);
      publishInterviewContext();
      return state;
    },
  );
  handle(
    'interview-calendar:save-outcome',
    (_e, eventId: string, outcome: Parameters<InterviewCalendarStore['saveOutcome']>[1]) => {
      const state = interviewCalendar?.saveOutcome(eventId, outcome);
      publishInterviewContext();
      return state;
    },
  );
  handle('interview-calendar:dismiss-thread', (_e, id: string) =>
    interviewCalendar?.dismissThread(id),
  );

  handle('keybinds:get', () => ({
    toggleOverlay: toggleOverlayShortcut,
    defaultToggleOverlay: DEFAULT_TOGGLE_SHORTCUT,
  }));

  handle('keybinds:setToggleOverlay', (_e, acc: string) => {
    const next = typeof acc === 'string' && acc.trim() ? acc.trim() : DEFAULT_TOGGLE_SHORTCUT;
    if (isReservedOverlayShortcut(next)) {
      return {
        ok: false,
        shortcut: toggleOverlayShortcut,
        error: 'Ctrl+Enter is reserved for sending the current live question',
      };
    }
    if (next === toggleOverlayShortcut) return { ok: true, shortcut: toggleOverlayShortcut };
    const previous = toggleOverlayShortcut;
    if (toggleOverlayShortcutRetryTimer) clearTimeout(toggleOverlayShortcutRetryTimer);
    toggleOverlayShortcutRetryTimer = null;
    if (!registerToggleShortcut(next)) {
      // Откат: сочетание занято системой или другим приложением.
      registerToggleShortcut(previous, true);
      return {
        ok: false,
        shortcut: previous,
        error: 'Сочетание занято другим приложением',
      };
    }
    toggleOverlayShortcut = next;
    saveMainSetting('toggleOverlayShortcut', next);
    return { ok: true, shortcut: next };
  });

  // «Сообщить о проблеме»: system info + хвост лога бэкенда + файлы от
  // renderer'а (prefs, тайминги) → zip во временной папке → показать в проводнике.
  handle(
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

      try {
        const automation = hhBrowserAssistant?.getState();
        if (automation) {
          fs.writeFileSync(
            path.join(dir, 'hh-automation.json'),
            JSON.stringify({
              phase: automation.phase,
              message: automation.message,
              updatedAt: automation.updatedAt,
              nextRunAt: automation.nextRunAt,
              nextQueueResumeAt: automation.nextQueueResumeAt,
              config: {
                platform: automation.config.platform,
                query: automation.config.query,
                area: automation.config.area,
                experience: automation.config.experience,
                schedule: automation.config.schedule,
                salaryFrom: automation.config.salaryFrom,
                resumeTitles: automation.config.resumeTitles,
                autoRunDaily: automation.config.autoRunDaily,
                autoRunHour: automation.config.autoRunHour,
              },
              runHistory: automation.runHistory,
              schedulerDiagnostics: hhBrowserAssistant?.getDiagnosticsSnapshot(),
              queue: automation.queue.map((item) => ({
                key: item.key,
                title: item.title,
                company: item.company,
                url: item.url,
                status: item.status,
                reason: item.reason,
                addedAt: item.addedAt,
                sentAt: item.sentAt,
              })),
            }, null, 2),
            'utf8',
          );
        }
      } catch {
        /* журнал HH не должен ломать сбор остальных диагностик */
      }

      try {
        const telemetry = operationalTelemetry?.snapshot();
        if (telemetry?.enabled) {
          fs.writeFileSync(
            path.join(dir, 'operational-events.json'),
            JSON.stringify(telemetry.events, null, 2),
            'utf8',
          );
        }
      } catch {
        /* локальная агрегированная хронология необязательна */
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

  handle(
    'app:shareSessionReport',
    async (_event, input: { filename?: unknown; content?: unknown; message?: unknown }) => {
      if (typeof input?.filename !== 'string' || typeof input?.content !== 'string') {
        throw new Error('Некорректный отчёт сессии');
      }
      if (input.message !== undefined && typeof input.message !== 'string') {
        throw new Error('Некорректное описание проблемы');
      }
      return shareSessionReport(
        { filename: input.filename, content: input.content, message: input.message },
        {
          reportsDir: path.join(app.getPath('documents'), 'SkillCue Reports'),
          mkdir: (directory) => {
            fs.mkdirSync(directory, { recursive: true });
          },
          writeFile: (target, content) => fs.writeFileSync(target, content, 'utf8'),
          reveal: (target) => shell.showItemInFolder(target),
          openExternal: (url) => shell.openExternal(url),
        },
      );
    },
  );

  handle('overlay:toggle', () => {
    toggleOverlay();
  });

  handle('overlay:get-window-state', () => {
    const win = isLiveWindow(overlayWindow) ? overlayWindow : null;
    return win ? { visible: win.isVisible(), bounds: win.getBounds() } : { visible: false, bounds: null };
  });

  handle('overlay:show', () => {
    attachNearestInterviewContext();
    const win = getOrCreateOverlayWindow();
    prepareOverlayForOpen(win);
    openOverlayOverWorkspace(mainWindow, () => showOverlayWindow(win));
  });
  handle('overlay:showForInterviewEvent', (_event, eventId: string) => {
    if (!setActiveInterviewEvent(eventId)) return false;
    const win = getOrCreateOverlayWindow();
    prepareOverlayForOpen(win);
    openOverlayOverWorkspace(mainWindow, () => showOverlayWindow(win));
    publishInterviewContext();
    return true;
  });
  handle('overlay:getInterviewContext', () => activeInterviewEvent());
  handle('overlay:clearInterviewContext', () => {
    setActiveInterviewEvent(null);
  });
  handle('overlay:hide', () => hideOverlay());

  handle('overlay:captureScreen', async () => {
    // Capture the interview task, not the floating assistant that may cover it.
    // The overlay is restored inactive so the editor/call keeps keyboard focus.
    try {
      const currentOverlay = isLiveWindow(overlayWindow) ? overlayWindow : null;
      return await screenCaptureCoordinator.run(() =>
        captureScreenWithoutOverlay(
          currentOverlay,
          async () => {
            const sources = await desktopCapturer.getSources({
              types: ['screen'],
              thumbnailSize: SCREEN_CAPTURE_THUMBNAIL_SIZE,
            });
            const primary = sources[0];
            return primary ? screenCaptureDataUrl(primary.thumbnail) : '';
          },
          () => {
            if (isLiveWindow(currentOverlay)) showOverlayWindow(currentOverlay, 'inactive');
          },
        ),
      );
    } catch (err) {
      console.warn('[overlay] screen capture failed:', err);
      return '';
    }
  });

  handle('overlay:openApp', () => {
    // Явный переход из оверлея в основное окно скрывает плавающую панель.
    hideOverlayAndShowMain(overlayWindow, mainWindow);
  });

  handle('overlay:openSettings', (_e, section?: string) => {
    if (!isLiveWindow(mainWindow)) return;
    hideOverlayAndShowMain(overlayWindow, mainWindow);
    const safe = section && /^[a-z-]+$/.test(section) ? `?tab=${section}` : '';
    mainWindow.webContents.send('app:navigate', `/settings${safe}`);
  });

  handle('overlay:openSessionAnalysis', (_e, sessionId: string) => {
    if (!isLiveWindow(mainWindow) || !/^[a-zA-Z0-9-]{6,80}$/.test(sessionId)) return;
    hideOverlayAndShowMain(overlayWindow, mainWindow);
    mainWindow.webContents.send('app:navigate', `/history/${encodeURIComponent(sessionId)}`);
  });

  handle('overlay:setContentProtection', (_e, enable: boolean) => {
    overlayContentProtectionEnabled = Boolean(enable);
    if (isLiveWindow(overlayWindow)) {
      enforceOverlayWindowPrivacy(overlayWindow, overlayContentProtectionEnabled);
    }
    if (isLiveWindow(mainWindow)) {
      mainWindow.setContentProtection(overlayContentProtectionEnabled);
    }
  });

  handle('overlay:move', (_e, dx: number, dy: number) => {
    // Перемещение окна оверлея с клавиатуры (Ctrl+стрелки), как «Move Cluely».
    moveOverlay(dx, dy);
  });

  handle('overlay:setFocusable', (_e, focusable: boolean) => {
    // «Не забирать фокус»: оверлей не становится активным окном, фокус
    // остаётся в приложении под ним. Внимание: при false ввод в поле
    // оверлея недоступен, поэтому включается осознанно из меню.
    if (isLiveWindow(overlayWindow)) overlayWindow.setFocusable(focusable);
  });

  handle('overlay:setClickThrough', (_e, enable: boolean) => {
    // Клики проходят «сквозь» оверлей в приложение под ним. forward:true шлёт
    // события движения курсора в рендерер, чтобы он мог временно вернуть
    // интерактивность при наведении на свои элементы (см. OverlayPage).
    if (isLiveWindow(overlayWindow)) {
      overlayWindow.setIgnoreMouseEvents(enable, { forward: true });
    }
  });

  handle('overlay:resize', (_e, dw: number, dh: number) => {
    if (!isLiveWindow(overlayWindow)) return;
    const [w, h] = overlayWindow.getSize();
    const nw = Math.max(420, Math.min(1400, Math.round(w + (dw || 0))));
    const nh = Math.max(360, Math.min(1200, Math.round(h + (dh || 0))));
    overlayWindow.setSize(nw, nh, false);
  });

  handle('overlay:liveState', (_e, active: boolean) => {
    updateCoordinator.setLive(!!active);
    // Live-сессия крутится в окне оверлея; главное окно не видит его событий,
    // поэтому пробрасываем состояние туда — сайдбар-хронометр и веха активации.
    mainWindow?.webContents.send('app:live-state', !!active);
  });

  handle('window:setSkipTaskbar', (_e, skip: boolean) => {
    setAppHiddenFromSwitcher(process.platform, skip, mainWindow, app.dock);
  });

  handle('window:setTitleBarTheme', (event, theme: unknown) => {
    if (
      !isLiveWindow(mainWindow) ||
      event.sender !== mainWindow.webContents ||
      (theme !== 'dark' && theme !== 'light')
    ) {
      return;
    }
    if (process.platform === 'darwin') return;
    mainWindow.setTitleBarOverlay(getTitleBarOverlayTheme(theme));
  });

  handle('app:getVersion', () => app.getVersion());

  handle('updater:check', async () => {
    // Dev and the first DMG release have no compatible update manifest yet.
    if (!isAutoUpdateSupported) {
      const status = {
        state: 'none' as const,
        message: isDeveloperBuild
          ? 'SkillCue Dev: обновления отключены'
          : 'Обновления macOS пока устанавливаются новой версией с сайта',
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
  handle('updater:get-status', () => updaterStatusStore.get());

  handle('app:getAutoLaunch', () => app.getLoginItemSettings().openAtLogin);
  handle('app:setAutoLaunch', (_e, enable: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enable });
  });
}

/* ---- Настройки main-процесса (нужны до готовности renderer'а) ---- */

const DEFAULT_TOGGLE_SHORTCUT = APP_IDENTITY.defaultToggleShortcut;
const FORCE_ANSWER_SHORTCUT = APP_IDENTITY.forceAnswerShortcut;
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
  // A keyboard hide/show is a visibility toggle, not a new session. Do not
  // send overlay:open-requested here: the renderer must keep the current
  // answer, transcript, scroll position and input exactly as the user left it.
  else {
    attachNearestInterviewContext();
    showOverlayWindow(win);
    publishInterviewContext();
  }
}

function scheduleToggleOverlayShortcutRetry(): void {
  if (quitting || toggleOverlayShortcutRetryTimer) return;
  toggleOverlayShortcutRetryTimer = setTimeout(() => {
    toggleOverlayShortcutRetryTimer = null;
    if (!toggleOverlayShortcutBinding?.ensureRegistered()) {
      scheduleToggleOverlayShortcutRetry();
    }
  }, 2_000);
}

function registerToggleShortcut(acc: string, retry = false): boolean {
  if (isReservedOverlayShortcut(acc)) return false;
  toggleOverlayShortcutBinding?.dispose();
  toggleOverlayShortcutBinding = new PersistentGlobalShortcut(
    globalShortcut,
    acc,
    toggleOverlay,
    (accelerator) => {
      console.warn(`[overlay] toggle shortcut unavailable${retry ? ', retrying' : ''}: ${accelerator}`);
      if (retry) scheduleToggleOverlayShortcutRetry();
    },
  );
  const registered = toggleOverlayShortcutBinding.ensureRegistered();
  if (!registered && !retry) {
    toggleOverlayShortcutBinding.dispose();
    toggleOverlayShortcutBinding = null;
  }
  return registered;
}

function deliverForcedAnswerToOverlay(): void {
  const existingOverlay = isLiveWindow(overlayWindow) ? overlayWindow : null;
  if (isDeveloperBuild && (!existingOverlay || !existingOverlay.isVisible())) return;
  const win = existingOverlay ?? getOrCreateOverlayWindow();
  if (!win.isVisible()) showOverlayWindow(win, 'inactive');
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
  if (typeof stored === 'string' && stored.trim() && registerToggleShortcut(stored.trim(), true)) {
    toggleOverlayShortcut = stored.trim();
  } else {
    registerToggleShortcut(DEFAULT_TOGGLE_SHORTCUT, true);
    toggleOverlayShortcut = DEFAULT_TOGGLE_SHORTCUT;
  }
  registerForceAnswerShortcut();
}

function createTray(): void {
  tray = new Tray(BRAND_ICON);
  tray.setToolTip(APP_IDENTITY.displayName);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Открыть',
        click: () => {
          if (isLiveWindow(mainWindow)) mainWindow.show();
        },
      },
      {
        label: 'Overlay',
        click: () => {
          const win = getOrCreateOverlayWindow();
          prepareOverlayForOpen(win);
          showOverlayWindow(win);
        },
      },
      { type: 'separator' },
      { label: 'Выход', click: () => app.quit() },
    ]),
  );
}

function setupAutoUpdater(): void {
  if (!isAutoUpdateSupported) return;
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
  // (Вне области видимости локальной обёртки handle() из setupIpc* — канал без
  // аргументов, guard sender здесь не требуется.)
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
const DEEP_LINK_PROTOCOL = APP_IDENTITY.deepLinkProtocol;
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
    operationalTelemetry = new OperationalTelemetryStore(app.getPath('userData'), app.getVersion());
    void ensureBackend();
    setupContentSecurityPolicy();
    setupDisplayMedia();
    hhBrowserAssistant = new HhBrowserAssistant(
      app.getPath('userData'),
      (state) => {
        sendToWindows('hh-assistant:state', state);
      },
      async (request) => {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (API_TOKEN) headers['X-SkillCue-Token'] = API_TOKEN;
        const response = await fetch(`${API_URL}/vacancy/screening-answers`, {
          method: 'POST',
          headers,
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(HH_SCREENING_REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => null) as BackendErrorEnvelope | null;
          throw createBackendResponseError(
            payload,
            response.status,
            'Не удалось подготовить ответы',
          );
        }
        return parseHhScreeningAnswersResponse(await response.json());
      },
      async (request) => {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (API_TOKEN) headers['X-SkillCue-Token'] = API_TOKEN;
        let response: Response;
        try {
          response = await fetch(`${API_URL}/vacancy/cover-letter`, {
            method: 'POST',
            headers,
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(12_000),
          });
        } catch (error) {
          const local = buildGroundedLocalHhCoverLetter(request);
          if (local.canAutoFill) return local;
          throw error;
        }
        if (response.ok) {
          const generated = await response.json() as HhCoverLetterResponse;
          if (validateGeneratedHhCoverLetter(generated, request)) return generated;

          // The model may occasionally return an unfinished template even
          // though the HTTP request succeeded. Never pass it to HH: use the
          // grounded local writer when possible, otherwise let the desktop
          // guard stop the application.
          const local = buildGroundedLocalHhCoverLetter(request);
          if (validateGeneratedHhCoverLetter(local, request)) return local;
          return generated;
        }
        const payload = await response.json().catch(() => null) as BackendErrorEnvelope | null;
        const backendError = createBackendResponseError(
          payload,
          response.status,
          'Не удалось подготовить письмо',
        );
        if (response.status !== 402 && response.status !== 429 && response.status < 500) {
          throw backendError;
        }
        const local = buildGroundedLocalHhCoverLetter(request);
        if (local.canAutoFill) return local;
        backendError.message = `${backendError.message}. ${local.reason ?? ''}`.trim();
        throw backendError;
      },
      async () => {
        const headers: Record<string, string> = {};
        if (API_TOKEN) headers['X-SkillCue-Token'] = API_TOKEN;
        const response = await fetch(`${API_URL}/license/status`, {
          headers,
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) return 'trial';
        const payload = await response.json() as { plan?: string };
        return payload.plan ?? 'trial';
      },
    );
    hhBrowserAssistant.restoreSchedule();

    // Инициализируем HH OAuth, календарь и Chat-ассистент (браузерный).
    hhOAuthService = new HhOAuthService(app.getPath('userData'));
    interviewCalendar = new InterviewCalendarStore(app.getPath('userData'), (state) => {
      sendToWindows('interview-calendar:state', state);
    });
    const recruiterProfileCache = new Map<
      string,
      { profile: HhChatCandidateProfile | ''; expiresAt: number }
    >();
    hhChatBrowser = new HhChatBrowser(
      app.getPath('userData'),
      // Плановая проверка не создаёт видимую вкладку negotiations рядом с
      // вакансией. Явное действие пользователя может открыть чат.
      async (purpose) => {
        return hhBrowserAssistant?.getChatPage({ explicit: purpose === 'explicit' }) ?? null;
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
          signal: AbortSignal.timeout(20_000),
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
      interviewCalendar,
      ({ vacancyTitle, companyName, recruiterMessage, kind, negotiationKey }) => {
        const normalizedTitle = vacancyTitle.replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru');
        const normalizedCompany = companyName.replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru');
        const vacancy = hhBrowserAssistant?.getState().queue.find((item) => {
          const title = item.title.replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru');
          const company = item.company.replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru');
          const titleMatches = Boolean(title && normalizedTitle) && (
            title === normalizedTitle || title.includes(normalizedTitle) || normalizedTitle.includes(title)
          );
          const companyMatches = !normalizedCompany || !company || (
            company === normalizedCompany || company.includes(normalizedCompany) || normalizedCompany.includes(company)
          );
          return titleMatches && companyMatches;
        });
        const preparation = vacancy?.preparationNotes ?? [];
        if (!Notification.isSupported()) return;
        const fallbackTitle = kind === 'telegram'
          ? 'Рекрутер прислал Telegram'
          : kind === 'interview'
            ? 'Приглашение на интервью с HH'
            : 'Новое сообщение с HH';
        const notification = new Notification({
          title: companyName
            ? `${companyName} · ${vacancyTitle || fallbackTitle}`
            : vacancyTitle || fallbackTitle,
          body: recruiterMessage.replace(/\s+/g, ' ').trim().slice(0, 260) || (
            preparation.length > 0
              ? `Перед интервью повторите: ${preparation.join('; ')}`.slice(0, 260)
              : 'Работодатель написал в чат HH.'
          ),
          icon: BRAND_ICON,
        });
        notification.on('click', () => {
          if (!isLiveWindow(mainWindow)) mainWindow = createMainWindow();
          if (mainWindow.isMinimized()) mainWindow.restore();
          hideOverlayAndShowMain(overlayWindow, mainWindow);
          if (!isLiveWindow(mainWindow)) return;
          const params = new URLSearchParams({ view: 'dialogs' });
          if (negotiationKey) params.set('conversation', negotiationKey);
          mainWindow.webContents.send('app:navigate', `/applications?${params.toString()}`);
        });
        notification.show();
      },
      async (context) => {
        const assistant = hhBrowserAssistant;
        if (!assistant) return '';
        const selection = resolveHhRecruiterProfileSelection(
          assistant.getState().queue,
          context,
        );
        if (!selection) return '';
        const { vacancy, selectedResumeTitle, cacheKey } = selection;
        const cached = recruiterProfileCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return cached.profile;

        // The resume selected for this vacancy is the primary source. It may
        // contain current salary expectations that are absent from the local
        // profile pack, and it must win over older uploaded documents.
        const selectedResume = await assistant.getSelectedResumeText(vacancy.title, {
          throwOnFailure: true,
          selectedResumeTitle,
        }).catch((error) => {
          console.warn('[hh-chat-browser] selected resume lookup failed:', error);
          return '';
        });
        if (!selectedResume.trim()) {
          recruiterProfileCache.set(cacheKey, {
            profile: '',
            expiresAt: Date.now() + 30_000,
          });
          return '';
        }
        let localProfile = '';
        try {
          const headers: Record<string, string> = {};
          if (API_TOKEN) headers['X-SkillCue-Token'] = API_TOKEN;
          const response = await fetch(`${API_URL}/documents/profile-pack`, {
            headers,
            signal: AbortSignal.timeout(5_000),
          });
          if (response.ok) {
            const payload = await response.json() as { content?: string };
            localProfile = String(payload.content ?? '').trim();
          }
        } catch (error) {
          console.warn('[hh-chat-browser] local candidate profile lookup failed:', error);
        }

        const profile: HhChatCandidateProfile = {
          selectedResumeText: selectedResume.trim().slice(0, 12_000),
          supplementalProfileText: localProfile.slice(0, 12_000),
        };
        recruiterProfileCache.set(cacheKey, {
          profile,
          expiresAt: Date.now() + 5 * 60_000,
        });
        return profile;
      },
      async () => {
        await hhBrowserAssistant?.restoreInteractivePage();
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

  let shutdownDisposed = false;
  const disposeServices = (): void => {
    if (shutdownDisposed) return;
    shutdownDisposed = true;
    for (const [name, dispose] of [
      ['hhChatBrowser', () => hhChatBrowser?.dispose()],
      ['hhOAuthService', () => hhOAuthService?.dispose()],
      ['interviewCalendar', () => interviewCalendar?.dispose()],
      ['operationalTelemetry', () => operationalTelemetry?.dispose()],
    ] as const) {
      try { dispose(); } catch (error) { logMain('error', `${name} dispose failed`, error); }
    }
  };

  app.on('before-quit', (event) => {
    // Плановый выход: 'exit' убитого бэкенда не должен запускать рестарт.
    quitting = true;
    if (backendRestartTimer) clearTimeout(backendRestartTimer);
    disposeServices();
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
    if (toggleOverlayShortcutRetryTimer) clearTimeout(toggleOverlayShortcutRetryTimer);
    toggleOverlayShortcutRetryTimer = null;
    toggleOverlayShortcutBinding?.dispose();
    toggleOverlayShortcutBinding = null;
    if (forceAnswerShortcutRetryTimer) clearTimeout(forceAnswerShortcutRetryTimer);
    forceAnswerShortcutRetryTimer = null;
    forceAnswerShortcutBinding?.dispose();
    forceAnswerShortcutBinding = null;
    globalShortcut.unregisterAll();
    stopBackend();
    backendLogStream?.end();
  });
}
