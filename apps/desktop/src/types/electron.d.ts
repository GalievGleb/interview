export interface ElectronAPI {
  getApiUrl: () => Promise<string>;
  getApiToken?: () => Promise<string>;
  getVersion?: () => Promise<string>;
  getAutoLaunch?: () => Promise<boolean>;
  setAutoLaunch?: (enable: boolean) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  quit?: () => Promise<void>;
  /** Собирает zip с логами и системной информацией, показывает его в проводнике. */
  collectDiagnostics?: (extra: Array<{ name: string; content: string }>) => Promise<string>;
  keybinds?: {
    get: () => Promise<KeybindsInfo>;
    setToggleOverlay: (accelerator: string) => Promise<KeybindSetResult>;
  };
  onBackendStatus?: (cb: (status: BackendStatus) => void) => () => void;
  overlay: {
    toggle: () => Promise<void>;
    show: () => Promise<void>;
    hide: () => Promise<void>;
    openApp?: () => Promise<void>;
    captureScreen?: () => Promise<string>;
    openSettings?: (section?: string) => Promise<void>;
    setContentProtection: (enable: boolean) => Promise<void>;
    move?: (dx: number, dy: number) => Promise<void>;
    setFocusable?: (focusable: boolean) => Promise<void>;
    setClickThrough?: (enable: boolean) => Promise<void>;
    resize?: (dw: number, dh: number) => Promise<void>;
    setLiveState?: (active: boolean) => Promise<void>;
    onForceAnswer?: (cb: () => void) => () => void;
  };
  window: {
    setSkipTaskbar: (skip: boolean) => Promise<void>;
  };
  onNavigate?: (cb: (path: string) => void) => () => void;
  onLiveState?: (cb: (active: boolean) => void) => () => void;
  /** Ключ лицензии из ссылки skillcue://activate?key=… (авто-активация после оплаты). */
  onActivateLicense?: (cb: (key: string) => void) => () => void;
  updater?: {
    onStatus: (cb: (status: UpdaterStatus) => void) => () => void;
    install: () => Promise<void>;
    check?: () => Promise<UpdateCheckResult>;
  };
}

export interface KeybindsInfo {
  toggleOverlay: string;
  defaultToggleOverlay: string;
}

export interface KeybindSetResult {
  ok: boolean;
  shortcut: string;
  error?: string;
}

export interface BackendStatus {
  state: 'ok' | 'restarting' | 'failed';
  attempt?: number;
  max?: number;
}

export interface UpdateCheckResult {
  state: 'available' | 'none' | 'error';
  version?: string;
  message?: string;
}

export interface UpdaterStatus {
  state: 'available' | 'downloading' | 'ready' | 'error';
  version?: string;
  percent?: number;
  message?: string;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
