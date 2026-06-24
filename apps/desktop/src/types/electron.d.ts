export interface ElectronAPI {
  getApiUrl: () => Promise<string>;
  openExternal: (url: string) => Promise<void>;
  overlay: {
    toggle: () => Promise<void>;
    show: () => Promise<void>;
    hide: () => Promise<void>;
    openSettings?: () => Promise<void>;
    setContentProtection: (enable: boolean) => Promise<void>;
  };
  window: {
    setSkipTaskbar: (skip: boolean) => Promise<void>;
  };
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
