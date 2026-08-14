export interface HhAssistantConfig {
  platform: 'hh' | 'linkedin' | 'avito';
  query: string;
  includeRelatedQueries: boolean;
  additionalQueries: string[];
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
  resumeTitles: string[];
  delayBetweenSec: number;
  dailyLimit: number;
  autoRunDaily: boolean;
  autoRunHour: number;
  linkedinLocation: string;
  linkedinEasyApplyOnly: boolean;
  avitoCity: string;
}

export type HhQueueStatus = 'new' | 'opened' | 'prepared' | 'needs_input' | 'sent' | 'already_applied' | 'skipped';

export interface HhScreeningQuestion {
  id: string;
  prompt: string;
  kind: 'text' | 'single' | 'multiple' | 'select';
  options: string[];
  required: boolean;
  assistantReason?: string;
  suggestedAnswer?: string;
  suggestedOptions?: string[];
}

export interface HhScreeningAnswerInput {
  questionId: string;
  question: string;
  answer: string;
  selectedOptions: string[];
  remember?: boolean;
}

export interface HhScreeningDraftSuggestion {
  questionId: string;
  answer: string;
  selectedOptions: string[];
  source: 'profile' | 'ai' | 'local';
  note: string;
}

export interface HhScreeningFact {
  id: string;
  question: string;
  answer: string;
  selectedOptions: string[];
  updatedAt: string;
}

export interface HhQueueItem {
  key: string;
  platform: 'hh' | 'linkedin' | 'avito';
  id: string;
  title: string;
  company: string;
  salary: string;
  url: string;
  description?: string;
  status: HhQueueStatus;
  reason?: string;
  addedAt: string;
  sentAt?: string;
  pendingQuestions?: HhScreeningQuestion[];
  preparationNotes?: string[];
  selectedResumeTitle?: string;
  coverLetterPending?: boolean;
  coverLetterAdded?: boolean;
  autoRetryBlockedUntil?: 'manual' | 'daily';
}

export interface HhAutomationRun {
  id: string;
  platform: 'hh' | 'linkedin' | 'avito';
  trigger: 'manual' | 'schedule' | 'resume' | 'direct_link';
  status: 'running' | 'completed' | 'attention' | 'failed' | 'stopped';
  startedAt: string;
  finishedAt?: string;
  query: string;
  vacancyUrl?: string;
  found: number;
  attempted: number;
  sent: number;
  alreadyApplied: number;
  skipped: number;
  needsAttention: number;
  message: string;
}

export interface HhScanSummary {
  platform: 'hh' | 'linkedin' | 'avito';
  queries: string[];
  pagesScanned: number;
  found: number;
  newVacancies: number;
  readyToApply: number;
  alreadyProcessed: number;
  excluded: number;
  schedule: string;
}

export interface HhAssistantState {
  phase: 'idle' | 'browser_open' | 'scanning' | 'applying' | 'ready' | 'manual_required' | 'error';
  browserOpen: boolean;
  loginRequired: boolean;
  message: string;
  currentVacancyId: string | null;
  applying: boolean;
  stopRequested: boolean;
  queuePaused: boolean;
  applyProgress: { done: number; total: number } | null;
  config: HhAssistantConfig;
  queue: HhQueueItem[];
  screeningFacts: HhScreeningFact[];
  runHistory: HhAutomationRun[];
  lastScanSummary: HhScanSummary | null;
  nextRunAt: string | null;
  updatedAt: string;
}

export interface HhApplicantResume {
  id: string;
  title: string;
  url: string;
}

export interface HhPreparationResume extends HhApplicantResume {
  text: string;
}

export interface HhPreparationVacancy {
  id: string;
  title: string;
  company: string;
  salary: string;
  url: string;
  description: string;
  text: string;
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
  checkedNegotiations: number;
  unreadMessages: number;
  conversations: HhChatConversation[];
  replyHistory: HhChatReplyRecord[];
  pendingDecisions: HhChatPendingDecision[];
  confirmedFacts: HhChatFact[];
  config: HhChatConfig;
  error: string | null;
}

export interface HhChatReplyRecord {
  id: string;
  negotiationKey: string;
  messageId: string;
  vacancyTitle: string;
  companyName: string;
  recruiterMessage: string;
  reply: string;
  sentAt: string | null;
  recordedAt: string;
  source: 'generated' | 'saved_fact' | 'resume_fact' | 'scheduling' | 'user_confirmed' | 'recovered';
  status: 'sent';
}

export interface HhChatConversation {
  key: string;
  vacancyTitle: string;
  companyName: string;
  vacancyUrl?: string;
  stage: 'waiting' | 'bot' | 'hr';
  hasUnread: boolean;
  lastMessage: string;
  lastMessageMine: boolean;
  lastRecruiterMessage?: string;
  needsUserInput: boolean;
}

export interface HhChatPendingDecision {
  id: string;
  negotiationKey: string;
  messageId: string;
  vacancyTitle: string;
  companyName: string;
  recruiterMessage: string;
  question: string;
  kind: 'contract' | 'salary' | 'experience' | 'relocation' | 'start_date' | 'schedule' | 'work_format' | 'travel' | 'work_authorization' | 'candidate_fact';
  createdAt: string;
}

export interface HhChatFact {
  id: string;
  kind: HhChatPendingDecision['kind'];
  question: string;
  answer: string;
  updatedAt: string;
}

export type InterviewType = 'hr' | 'technical' | 'other';
export type InterviewStatus = 'proposed' | 'confirmed' | 'cancelled';

export interface AvailabilityWindow {
  id: string;
  weekday: number;
  startMinutes: number;
  endMinutes: number;
}

export interface InterviewCalendarSettings {
  availabilityConfigured: boolean;
  availability: AvailabilityWindow[];
  defaultDurationMin: number;
  minimumNoticeMin: number;
  timezone: string;
}

export interface InterviewOutcome {
  sessionId: string;
  headline: string;
  facts: string[];
  conditions: string[];
  nextSteps: string[];
  openQuestions: string[];
  createdAt: string;
}

export interface InterviewCalendarEvent {
  id: string;
  negotiationKey?: string;
  journeyId?: string;
  vacancyTitle: string;
  companyName: string;
  type: InterviewType;
  status: InterviewStatus;
  startAt: string;
  endAt: string;
  source: 'hh' | 'manual';
  vacancyUrl?: string;
  vacancyDescription?: string;
  meetingUrl?: string;
  notes?: string;
  sessionId?: string;
  completedAt?: string;
  outcome?: InterviewOutcome;
  createdAt: string;
  updatedAt: string;
}

export interface InterviewEventDraft {
  id?: string;
  negotiationKey?: string;
  journeyId?: string;
  vacancyTitle: string;
  companyName: string;
  type: InterviewType;
  status: InterviewStatus;
  startAt: string;
  endAt: string;
  source: 'hh' | 'manual';
  vacancyUrl?: string;
  vacancyDescription?: string;
  meetingUrl?: string;
  notes?: string;
  sessionId?: string;
}

export interface InterviewSchedulingThread {
  id: string;
  negotiationKey: string;
  vacancyTitle: string;
  companyName: string;
  type: InterviewType;
  stage:
    | 'needs_availability'
    | 'needs_attention'
    | 'awaiting_recruiter'
    | 'awaiting_confirmation'
    | 'confirmed'
    | 'cancelled';
  offeredSlots: string[];
  selectedStartAt?: string;
  recruiterMessage: string;
  reason?: string;
  hidden?: boolean;
  updatedAt: string;
}

export interface InterviewCalendarState {
  settings: InterviewCalendarSettings;
  events: InterviewCalendarEvent[];
  scheduling: InterviewSchedulingThread[];
}

export interface ElectronAPI {
  getApiUrl: () => Promise<string>;
  getApiToken?: () => Promise<string>;
  getBuildChannel?: () => Promise<'stable' | 'dev'>;
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
    openBrowser: (platform?: 'hh' | 'linkedin' | 'avito') => Promise<HhAssistantState>;
    scan: (platform?: 'hh' | 'linkedin' | 'avito') => Promise<HhAssistantState>;
    runNow: () => Promise<HhAssistantState>;
    applyVacancyUrl: (url: string) => Promise<HhAssistantState>;
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
    getResumes: () => Promise<HhApplicantResume[]>;
    getResumeContent: (resumeId: string) => Promise<HhPreparationResume>;
    inspectVacancyUrl: (url: string) => Promise<HhPreparationVacancy>;
    applyAll: () => Promise<HhAssistantState>;
    applyOne: (vacancyId: string) => Promise<HhAssistantState>;
    answerScreeningQuestions: (
      vacancyId: string,
      answers: HhScreeningAnswerInput[],
    ) => Promise<HhAssistantState>;
    suggestScreeningAnswer: (
      vacancyId: string,
      questionId: string,
      currentAnswer?: string,
    ) => Promise<HhScreeningDraftSuggestion>;
    forgetScreeningFact: (factId: string) => Promise<HhAssistantState>;
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
    answerDecision: (decisionId: string, answer: string, remember?: boolean) => Promise<HhChatState>;
    forgetFact: (factId: string) => Promise<HhChatState>;
  };
  interviewCalendar?: {
    getState: () => Promise<InterviewCalendarState>;
    saveSettings: (settings: Partial<InterviewCalendarSettings>) => Promise<InterviewCalendarState>;
    upsertEvent: (event: InterviewEventDraft) => Promise<InterviewCalendarState>;
    removeEvent: (id: string) => Promise<InterviewCalendarState>;
    attachSession: (eventId: string, sessionId: string) => Promise<InterviewCalendarState>;
    saveOutcome: (eventId: string, outcome: InterviewOutcome) => Promise<InterviewCalendarState>;
    dismissThread: (id: string) => Promise<InterviewCalendarState>;
    onState: (cb: (state: InterviewCalendarState) => void) => () => void;
  };
  onBackendStatus?: (cb: (status: BackendStatus) => void) => () => void;
  overlay: {
    toggle: () => Promise<void>;
    getWindowState?: () => Promise<{ visible: boolean; bounds: { x: number; y: number; width: number; height: number } | null }>;
    show: () => Promise<void>;
    showForInterviewEvent?: (eventId: string) => Promise<boolean>;
    getInterviewContext?: () => Promise<InterviewCalendarEvent | null>;
    clearInterviewContext?: () => Promise<void>;
    onInterviewContext?: (cb: (event: InterviewCalendarEvent | null) => void) => () => void;
    onOpenRequested?: (cb: () => void) => () => void;
    hide: () => Promise<void>;
    openApp?: () => Promise<void>;
    captureScreen?: () => Promise<string>;
    openSettings?: (section?: string) => Promise<void>;
    openSessionAnalysis?: (sessionId: string) => Promise<void>;
    setContentProtection: (enable: boolean) => Promise<void>;
    move?: (dx: number, dy: number) => Promise<void>;
    setFocusable?: (focusable: boolean) => Promise<void>;
    setClickThrough?: (enable: boolean) => Promise<void>;
    resize?: (dw: number, dh: number) => Promise<void>;
    setLiveState?: (active: boolean) => Promise<void>;
    onForceAnswer?: (cb: () => void) => () => void;
    onScroll?: (cb: (direction: -1 | 1) => void) => () => void;
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
