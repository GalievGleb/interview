export interface HhAssistantConfig {
  query: string;
  area: string;
  experience: string;
  employment: string;
  schedule: string;
  salaryFrom: number | null;
  onlyWithSalary: boolean;
  excludedKeywords: string[];
  excludedEmployers: string[];
  maxQueueSize: number;
  maxPages: number;
  coverLetterTemplate: string;
  autoSend: boolean;
  resumeTitleContains: string;
  delayBetweenSec: number;
  dailyLimit: number;
  autoRunDaily: boolean;
  autoRunHour: number;
}

export type HhQueueStatus = 'new' | 'opened' | 'prepared' | 'sent' | 'skipped';

export interface HhQueueItem {
  id: string;
  title: string;
  company: string;
  salary: string;
  url: string;
  status: HhQueueStatus;
  reason?: string;
  addedAt: string;
  sentAt?: string;
}

export interface HhAssistantState {
  phase: 'idle' | 'browser_open' | 'scanning' | 'applying' | 'ready' | 'manual_required' | 'error';
  browserOpen: boolean;
  loginRequired: boolean;
  message: string;
  currentVacancyId: string | null;
  applying: boolean;
  applyProgress: { done: number; total: number } | null;
  config: HhAssistantConfig;
  queue: HhQueueItem[];
  updatedAt: string;
}

export interface HhOAuthState {
  connected: boolean;
  email: string | null;
  name: string | null;
  employerId: string | null;
  expiresAt: number | null;
  error: string | null;
}

export interface HhOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectPort: number;
}

export interface HhChatConfig {
  enabled: boolean;
  pollIntervalSec: number;
  dailyReplyLimit: number;
  replyDelaySec: number;
  replyPrompt: string;
  onlyDiscussions: boolean;
  minMessageLength: number;
  ignoredKeywords: string;
}

export interface HhChatState {
  enabled: boolean;
  polling: boolean;
  lastPollAt: string | null;
  repliesToday: number;
  activeNegotiations: number;
  unreadMessages: number;
  config: HhChatConfig;
  error: string | null;
}

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
  hhAssistant?: {
    getState: () => Promise<HhAssistantState>;
    saveConfig: (config: Partial<HhAssistantConfig>) => Promise<HhAssistantState>;
    openBrowser: () => Promise<HhAssistantState>;
    scan: () => Promise<HhAssistantState>;
    openVacancy: (vacancyId: string) => Promise<HhAssistantState>;
    fillLetter: (vacancyId: string) => Promise<HhAssistantState>;
    mark: (
      vacancyId: string,
      status: Extract<HhQueueStatus, 'sent' | 'skipped'>,
    ) => Promise<HhAssistantState>;
    closeBrowser: () => Promise<HhAssistantState>;
    login: (login: string, password: string) => Promise<{ ok: boolean; message: string }>;
    requestLoginCode: (email: string) => Promise<{ ok: boolean; message: string }>;
    confirmLoginCode: (code: string) => Promise<{ ok: boolean; message: string }>;
    getResumes: () => Promise<Array<{ id: string; title: string; url: string }>>;
    applyAll: () => Promise<HhAssistantState>;
    applyOne: (vacancyId: string) => Promise<HhAssistantState>;
    stopApply: () => Promise<HhAssistantState>;
    setDailySchedule: (enabled: boolean) => Promise<HhAssistantState>;
    onState: (cb: (state: HhAssistantState) => void) => () => void;
  };
  hhOAuth?: {
    getState: () => Promise<HhOAuthState>;
    getConfig: () => Promise<HhOAuthConfig>;
    saveConfig: (config: Partial<HhOAuthConfig>) => Promise<HhOAuthConfig>;
    startAuth: () => Promise<{ ok: boolean; tokens?: unknown; error?: string }>;
    exchangeCode: (code: string) => Promise<{ ok: boolean; tokens?: unknown; error?: string }>;
    logout: () => Promise<void>;
    getResumes: () => Promise<Array<{ id: string; title: string; url: string; updatedAt: string }>>;
    getMe: () => Promise<{ email: string; name: string } | null>;
  };
  hhChat?: {
    getState: () => Promise<HhChatState>;
    getConfig: () => Promise<HhChatConfig>;
    saveConfig: (config: Partial<HhChatConfig>) => Promise<HhChatConfig>;
    setEnabled: (enabled: boolean) => Promise<HhChatState>;
    pollNow: () => Promise<HhChatState>;
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
    setTitleBarTheme?: (theme: 'dark' | 'light') => Promise<void>;
  };
  onNavigate?: (cb: (path: string) => void) => () => void;
  onLiveState?: (cb: (active: boolean) => void) => () => void;
  /** Ключ лицензии из ссылки skillcue://activate?key=… (авто-активация после оплаты). */
  onActivateLicense?: (cb: (key: string) => void) => () => void;
  updater?: {
    onStatus: (cb: (status: UpdaterStatus) => void) => () => void;
    install: () => Promise<void>;
    check?: () => Promise<UpdateCheckResult>;
    getStatus?: () => Promise<UpdaterStatus>;
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
  state:
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'ready'
    | 'waiting-for-session-end'
    | 'installing'
    | 'none'
    | 'error';
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
