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
    // Оверлей → главное окно: live-сессия запущена/остановлена (сайдбар-таймер).
    setLiveState: (active: boolean) => ipcRenderer.invoke('overlay:liveState', active),
  },
  window: {
    setSkipTaskbar: (skip: boolean) => ipcRenderer.invoke('window:setSkipTaskbar', skip),
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
  updater: {
    onStatus: (cb: (status: unknown) => void) => {
      const handler = (_e: unknown, status: unknown) => cb(status);
      ipcRenderer.on('updater:status', handler);
      return () => ipcRenderer.removeListener('updater:status', handler);
    },
    install: () => ipcRenderer.invoke('updater:install'),
    check: () => ipcRenderer.invoke('updater:check'),
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
