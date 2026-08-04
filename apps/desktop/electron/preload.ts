import { contextBridge, ipcRenderer } from 'electron';

const api = {
  getApiUrl: () => ipcRenderer.invoke('app:getApiUrl'),
  getApiToken: () => ipcRenderer.invoke('app:getApiToken'),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  getAutoLaunch: () => ipcRenderer.invoke('app:getAutoLaunch'),
  setAutoLaunch: (enable: boolean) => ipcRenderer.invoke('app:setAutoLaunch', enable),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  quit: () => ipcRenderer.invoke('app:quit'),
  collectDiagnostics: (extra: Array<{ name: string; content: string }>) =>
    ipcRenderer.invoke('app:collectDiagnostics', extra),
  keybinds: {
    get: () => ipcRenderer.invoke('keybinds:get'),
    setToggleOverlay: (accelerator: string) =>
      ipcRenderer.invoke('keybinds:setToggleOverlay', accelerator),
  },
  hhAssistant: {
    getState: () => ipcRenderer.invoke('hh-assistant:get-state'),
    saveConfig: (config: unknown) =>
      ipcRenderer.invoke('hh-assistant:save-config', config),
    openBrowser: () => ipcRenderer.invoke('hh-assistant:open-browser'),
    scan: () => ipcRenderer.invoke('hh-assistant:scan'),
    applyAll: () => ipcRenderer.invoke('hh-assistant:apply-all'),
    applyOne: (vacancyId: string) => ipcRenderer.invoke('hh-assistant:apply-one', vacancyId),
    stopApply: () => ipcRenderer.invoke('hh-assistant:stop-apply'),
    setDailySchedule: (enabled: boolean) =>
      ipcRenderer.invoke('hh-assistant:set-daily-schedule', enabled),
    openVacancy: (vacancyId: string) =>
      ipcRenderer.invoke('hh-assistant:open-vacancy', vacancyId),
    fillLetter: (vacancyId: string) =>
      ipcRenderer.invoke('hh-assistant:fill-letter', vacancyId),
    mark: (vacancyId: string, status: 'sent' | 'skipped') =>
      ipcRenderer.invoke('hh-assistant:mark', vacancyId, status),
    closeBrowser: () => ipcRenderer.invoke('hh-assistant:close-browser'),
    login: (login: string, password: string) =>
      ipcRenderer.invoke('hh-assistant:login', login, password),
    onState: (cb: (state: unknown) => void) => {
      const handler = (_e: unknown, state: unknown) => cb(state);
      ipcRenderer.on('hh-assistant:state', handler);
      return () => ipcRenderer.removeListener('hh-assistant:state', handler);
    },
  },
  // ─── HH OAuth ────────────────────────────────────────────────────────
  hhOAuth: {
    getState: () => ipcRenderer.invoke('hh-oauth:get-state'),
    getConfig: () => ipcRenderer.invoke('hh-oauth:get-config'),
    saveConfig: (config: unknown) =>
      ipcRenderer.invoke('hh-oauth:save-config', config),
    startAuth: () => ipcRenderer.invoke('hh-oauth:start-auth'),
    exchangeCode: (code: string) => ipcRenderer.invoke('hh-oauth:exchange-code', code),
    logout: () => ipcRenderer.invoke('hh-oauth:logout'),
    getResumes: () => ipcRenderer.invoke('hh-oauth:get-resumes'),
    getMe: () => ipcRenderer.invoke('hh-oauth:get-me'),
  },
  // ─── HH Chat Browser ──────────────────────────────────────────────────
  hhChat: {
    getState: () => ipcRenderer.invoke('hh-chat:get-state'),
    getConfig: () => ipcRenderer.invoke('hh-chat:get-config'),
    saveConfig: (config: unknown) =>
      ipcRenderer.invoke('hh-chat:save-config', config),
    setEnabled: (enabled: boolean) =>
      ipcRenderer.invoke('hh-chat:set-enabled', enabled),
    pollNow: () => ipcRenderer.invoke('hh-chat:poll-now'),
  },
  onBackendStatus: (cb: (status: unknown) => void) => {
    const handler = (_e: unknown, status: unknown) => cb(status);
    ipcRenderer.on('backend:status', handler);
    return () => ipcRenderer.removeListener('backend:status', handler);
  },
  overlay: {
    toggle: () => ipcRenderer.invoke('overlay:toggle'),
    show: () => ipcRenderer.invoke('overlay:show'),
    hide: () => ipcRenderer.invoke('overlay:hide'),
    openApp: () => ipcRenderer.invoke('overlay:openApp'),
    captureScreen: () => ipcRenderer.invoke('overlay:captureScreen'),
    openSettings: (section?: string) => ipcRenderer.invoke('overlay:openSettings', section),
    setContentProtection: (enable: boolean) =>
      ipcRenderer.invoke('overlay:setContentProtection', enable),
    move: (dx: number, dy: number) => ipcRenderer.invoke('overlay:move', dx, dy),
    setFocusable: (focusable: boolean) =>
      ipcRenderer.invoke('overlay:setFocusable', focusable),
    // Клики «сквозь» оверлей: работать в приложении под панелью, не задевая её.
    setClickThrough: (enable: boolean) =>
      ipcRenderer.invoke('overlay:setClickThrough', enable),
    // Увеличить/уменьшить окно оверлея (dw/dh в px).
    resize: (dw: number, dh: number) => ipcRenderer.invoke('overlay:resize', dw, dh),
    // Оверлей → главное окно: live-сессия запущена/остановлена (сайдбар-таймер).
    setLiveState: (active: boolean) => ipcRenderer.invoke('overlay:liveState', active),
    onForceAnswer: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('overlay:force-answer', handler);
      return () => ipcRenderer.removeListener('overlay:force-answer', handler);
    },
  },
  window: {
    setSkipTaskbar: (skip: boolean) => ipcRenderer.invoke('window:setSkipTaskbar', skip),
    setTitleBarTheme: (theme: 'dark' | 'light') =>
      ipcRenderer.invoke('window:setTitleBarTheme', theme),
  },
  // Main-window navigation requested from the overlay (e.g. open Settings).
  onNavigate: (cb: (path: string) => void) => {
    const handler = (_e: unknown, path: string) => cb(path);
    ipcRenderer.on('app:navigate', handler);
    return () => ipcRenderer.removeListener('app:navigate', handler);
  },
  // Live-состояние из окна оверлея — чтобы главное окно показывало хронометр.
  onLiveState: (cb: (active: boolean) => void) => {
    const handler = (_e: unknown, active: boolean) => cb(active);
    ipcRenderer.on('app:live-state', handler);
    return () => ipcRenderer.removeListener('app:live-state', handler);
  },
  // Ключ лицензии из ссылки skillcue://activate?key=… (после оплаты на сайте).
  onActivateLicense: (cb: (key: string) => void) => {
    const handler = (_e: unknown, key: string) => cb(key);
    ipcRenderer.on('deeplink:activate', handler);
    return () => ipcRenderer.removeListener('deeplink:activate', handler);
  },
  updater: {
    onStatus: (cb: (status: unknown) => void) => {
      const handler = (_e: unknown, status: unknown) => cb(status);
      ipcRenderer.on('updater:status', handler);
      return () => ipcRenderer.removeListener('updater:status', handler);
    },
    install: () => ipcRenderer.invoke('updater:install'),
    check: () => ipcRenderer.invoke('updater:check'),
    getStatus: () => ipcRenderer.invoke('updater:get-status'),
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
