import { contextBridge, ipcRenderer } from 'electron';

const api = {
  getApiUrl: () => ipcRenderer.invoke('app:getApiUrl'),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  overlay: {
    toggle: () => ipcRenderer.invoke('overlay:toggle'),
    show: () => ipcRenderer.invoke('overlay:show'),
    hide: () => ipcRenderer.invoke('overlay:hide'),
    setContentProtection: (enable: boolean) =>
      ipcRenderer.invoke('overlay:setContentProtection', enable),
  },
  window: {
    setSkipTaskbar: (skip: boolean) => ipcRenderer.invoke('window:setSkipTaskbar', skip),
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
