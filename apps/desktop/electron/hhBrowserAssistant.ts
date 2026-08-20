import fs from 'fs';
import path from 'path';
import net from 'net';
import { spawn, type ChildProcess } from 'child_process';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
} from 'playwright-core';
import {
  buildHhSearchQueries,
  buildHhSearchUrl,
  DEFAULT_HH_ASSISTANT_CONFIG,
  type HhAssistantConfig,
  type HhVacancy,
  isVacancyCompatibleWithSearchSchedule,
  isVacancyRelevantToSearchProfile,
  isVacancyRelevantToSearchQuery,
  normalizeHhAssistantConfig,
  normalizeHhVacancyUrl,
  rankHhResumeTitlesForVacancy,
  shouldExcludeVacancy,
} from './hhAssistantPolicy';
import {
  canSendMore,
  countTodaySent,
  decideNextAction,
  effectiveDailyLimit,
  jitterMs,
  nextDiscoveryRunDelayMs,
  type HhApplyContext,
  type HhApplySituation,
} from './hhAutoApplyPolicy';
import {
  analyzeHhAutomationDiagnostics,
  diagnosticTimezone,
  localDiagnosticTime,
  normalizeHhAutomationDiagnostics,
  type HhAutomationDiagnosticEvent,
  type HhAutomationDiagnosticKind,
  type HhAutomationDiagnosticSnapshot,
  type HhAutomationDiagnosticSource,
  type HhAutomationQueueCounts,
} from './hhAutomationDiagnostics';
import {
  collectHhScreeningFields,
  fillHhScreeningFields,
  matchScreeningOptionLabels,
  screeningQuestionKey,
  type HhScreeningAnswer,
  type HhScreeningAnswersRequest,
  type HhScreeningAnswersResponse,
  type HhScreeningQuestion,
} from './hhScreeningQuestions';
import { partitionUnresolvedScreeningQuestions } from './hhScreeningFailures';
import {
  buildHhScreeningReviewDraft,
  isSensitiveHhScreeningChoice,
  isUsableHhScreeningDraft,
} from './hhScreeningReviewDraft';
import {
  findSalaryExpectation,
  isCurrentLocationQuestion,
  isSalaryRelatedQuestion,
  knownScreeningAnswer,
  localScreeningDraft,
  reusableScreeningAnswer,
  screeningQuestionSemanticKey,
  selectRelevantScreeningFacts,
} from './hhScreeningKnowledge';
import {
  validateGeneratedHhCoverLetter,
  type HhCoverLetterRequest,
  type HhCoverLetterResponse,
} from './hhCoverLetter';
import {
  parseHhResumeText,
  parseHhVacancyPage,
  type HhPreparationResume,
  type HhPreparationVacancy,
} from './hhPreparationSource';
import { parseHhSearchResults } from './hhSearchResults';
import {
  findHhSemanticDuplicate,
  mergeHhVacancyDescription,
} from './hhVacancyDuplicateGuard';
import { evaluateHhStackCompatibility } from './hhStackCompatibility';

export type HhQueueStatus =
  | 'new'
  | 'opened'
  | 'prepared'
  | 'needs_input'
  | 'sent'
  | 'already_applied'
  | 'skipped';
export type HhAssistantPhase =
  | 'idle'
  | 'browser_open'
  | 'scanning'
  | 'applying'
  | 'ready'
  | 'manual_required'
  | 'error';

export interface HhQueueItem extends HhVacancy {
  key: string;
  platform: JobPlatform;
  description?: string;
  easyApply?: boolean;
  status: HhQueueStatus;
  reason?: string;
  addedAt: string;
  sentAt?: string;
  pendingQuestions?: HhScreeningQuestion[];
  screeningAnswers?: HhStoredScreeningAnswer[];
  preparationNotes?: string[];
  selectedResumeTitle?: string;
  /** True only after HH visibly confirmed this exact résumé in the response form. */
  selectedResumeVerified?: boolean;
  /** HH accepted the initial response, but SkillCue still has to attach the letter. */
  coverLetterPending?: boolean;
  coverLetterAdded?: boolean;
  /**
   * Persisted gate for automatic retries after a non-terminal failure.
   * `manual` requires an explicit user action; `daily` also permits the next
   * scheduled daily run. Neither value is eligible for the short queue timer.
   */
  autoRetryBlockedUntil?: 'manual' | 'daily';
}

export interface HhStoredScreeningAnswer {
  questionId: string;
  question: string;
  answer: string;
  selectedOptions: string[];
  /** Present only after the user explicitly submitted this exact vacancy answer. */
  confirmedByUser?: boolean;
}

export interface HhScreeningAnswerInput extends HhStoredScreeningAnswer {
  remember?: boolean;
}

export interface HhScreeningFact {
  id: string;
  question: string;
  answer: string;
  selectedOptions: string[];
  updatedAt: string;
}

export interface HhScreeningDraftSuggestion {
  questionId: string;
  answer: string;
  selectedOptions: string[];
  source: 'profile' | 'ai' | 'local';
  note: string;
}

export interface HhApplicantResume {
  id: string;
  title: string;
  url: string;
}

export type HhAutomationRunTrigger = 'manual' | 'schedule' | 'resume' | 'direct_link';
export type HhAutomationRunStatus = 'running' | 'completed' | 'attention' | 'failed' | 'stopped';

export interface HhAutomationRun {
  id: string;
  platform: JobPlatform;
  trigger: HhAutomationRunTrigger;
  status: HhAutomationRunStatus;
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
  phase: HhAssistantPhase;
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
  nextQueueResumeAt: string | null;
  updatedAt: string;
}

export type HhAssistantConfigUpdate = Partial<HhAssistantConfig> & {
  /** Set only by an explicit user action in the resume selector. */
  resumeSelectionExplicitlyConfirmed?: boolean;
};

interface PersistedState {
  version?: number;
  config: HhAssistantConfig;
  queue: unknown;
  screeningFacts?: unknown;
  runHistory?: unknown;
  automationDiagnostics?: unknown;
  queuePaused?: unknown;
  resumeSelectionConfirmed?: unknown;
}

interface QueueRunStats {
  total: number;
  attempted: number;
  sent: number;
  alreadyApplied: number;
  skipped: number;
  needsAttention: number;
  stopped: boolean;
  blocked: boolean;
}

export type HhCoverLetterRetry = 'never' | 'manual' | 'later';

const HH_RESUME_TEXT_CACHE_TTL_MS = 5 * 60_000;

type PreparedHhCoverLetter =
  | { ok: true; letter: string }
  | { ok: false; reason: string; retry: HhCoverLetterRetry };

interface HhApplyOutcome {
  sent: boolean;
  alreadyApplied?: boolean;
  blocked: boolean;
  reason: string;
  autoRetryBlockedUntil?: HhQueueItem['autoRetryBlockedUntil'];
}

type EmitState = (state: HhAssistantState) => void;
type GenerateHhScreeningAnswers = (
  request: HhScreeningAnswersRequest,
) => Promise<HhScreeningAnswersResponse>;
type GenerateHhCoverLetter = (
  request: HhCoverLetterRequest,
) => Promise<HhCoverLetterResponse>;
type JobPlatform = 'hh' | 'linkedin' | 'avito';
export type BrowserRunMode = 'background' | 'interactive';

const PLATFORM_INFO: Record<JobPlatform, {
  label: string;
  homeUrl: string;
  hosts: string[];
  cards: string[];
  titles: string[];
  links: string[];
  companies: string[];
  salaries: string[];
  descriptions: string[];
  login: string[];
}> = {
  hh: {
    label: 'HH.ru', homeUrl: 'https://hh.ru/', hosts: ['hh.ru'],
    cards: ['[data-qa="vacancy-serp__vacancy"]'],
    titles: ['[data-qa="serp-item__title"]', '[data-qa="vacancy-serp__vacancy-title"]'],
    links: ['a[data-qa="serp-item__title"]', 'a[data-qa="vacancy-serp__vacancy-title"]'],
    companies: ['[data-qa="vacancy-serp__vacancy-employer"]', '[data-qa="vacancy-serp__vacancy-employer-text"]'],
    salaries: ['[data-qa="vacancy-serp__vacancy-compensation"]', '[data-qa="vacancy-serp__vacancy-salary"]'],
    descriptions: ['[data-qa="vacancy-description"]'],
    login: ['[data-qa="login"]', 'a[href*="/account/login"]', 'a[href*="/account/signup"]'],
  },
  linkedin: {
    label: 'LinkedIn', homeUrl: 'https://www.linkedin.com/jobs/', hosts: ['linkedin.com'],
    cards: ['div[role="button"][componentkey^="job-card-component-ref-"]', '.job-card-container', '.jobs-search-results__list-item'],
    titles: ['.job-card-list__title', '.job-card-list__title--link', 'a.job-card-container__link'],
    links: ['a.job-card-container__link', '.job-card-list__title--link', 'a[href*="/jobs/view/"]'],
    companies: ['.job-card-container__primary-description', '.job-card-container__company-name', '.artdeco-entity-lockup__subtitle'],
    salaries: ['.job-card-container__metadata-item'],
    descriptions: ['.jobs-description__content', '.jobs-box__html-content', '.jobs-description-content__text'],
    login: ['a[href*="/login"]', 'button:has-text("Sign in")', 'button:has-text("Войти")'],
  },
  avito: {
    label: 'Avito Работа', homeUrl: 'https://www.avito.ru/all/vakansii', hosts: ['avito.ru'],
    cards: ['[data-marker="item"]'],
    titles: ['[itemprop="name"]', 'a[data-marker="item-title"]'],
    links: ['a[data-marker="item-title"]', 'a[href*="/vakansii/"]'],
    companies: ['a[href*="/brands/"]', 'a[href*="/company/"]', '[class*="iva-item-sellerInfoStep"] a'],
    salaries: ['[data-marker="item-price"]', 'meta[itemprop="price"]'],
    descriptions: ['[data-marker="item-view/item-description"]', '[itemprop="description"]'],
    login: ['[data-marker="header/login-button"]', 'button:has-text("Войти")', 'a[href*="#login"]'],
  },
};

const LETTER_SELECTOR = '[data-qa="vacancy-response-popup-form-letter-input"]';
const ADD_COVER_LETTER_SELECTOR = [
  '[data-qa="add-cover-letter"]',
  // Current HH response form (verified on hh.ru/applicant/vacancy_response).
  '[data-qa="vacancy-response-letter-toggle"]',
].join(', ');
const OPEN_VACANCY_CHAT_SELECTOR = '[data-qa="open-vacancy-chat"]';
const CHAT_FRAME_URL_PART = 'chatik.hh.ru/chat/';
const CHAT_ADD_COVER_LETTER_SELECTOR = '[data-qa="chatik-chat-message-applicant-action"]';
const CHAT_COVER_LETTER_PREVIEW_SELECTOR = '[data-qa="chat-input-preview"]';
const CHAT_MESSAGE_TEXT_SELECTOR = '[data-qa^="chatik-chat-message-"][data-qa$="-text"]';
const CHAT_INPUT_SELECTOR = '[data-qa="chatik-new-message-text"]';
const CHAT_SEND_SELECTOR = '[data-qa="chatik-do-send-message"]';
const HH_NEGOTIATIONS_URL = 'https://hh.ru/applicant/negotiations';
const NEGOTIATION_ITEM_SELECTOR = '[data-qa="negotiations-item"]';
const NEGOTIATION_OPEN_CHAT_SELECTOR = '[data-qa="open_chat"]';
const NEGOTIATION_REJECTED_SELECTOR =
  '[data-qa~="negotiations-item-discard"], [data-qa*="negotiations-item-discard"]';
const CAPTCHA_SELECTOR =
  '[data-qa*="captcha"], iframe[src*="captcha"], iframe[title*="captcha" i]';
const RESPONSE_QUESTION_SELECTOR = [
  '[data-qa*="vacancy-response-question"]',
  '[data-qa*="response-question"]',
  '[data-qa*="employer-question"]',
  '[data-qa*="screening-question"]',
  '[data-qa="task-question"]',
  '[data-qa="task-body"]',
  'form[name="vacancy_response"] [name^="task_"]',
  '[name^="question_"]',
  '[name*="employer_question"]',
].join(', ');
const RESPONSE_TEST_SELECTOR = [
  '[data-qa*="vacancy-response-test"]',
  '[data-qa*="vacancy-test"]',
  '[data-qa="employer-asking-for-test"]',
  '[data-qa="test-description"]',
].join(', ');
const RESPONSE_FLOW_CONTAINER_SELECTOR = [
  'form',
  '[role="dialog"]',
  '[data-qa="vacancy-response-popup"]',
  '[data-qa*="response-popup"]',
].join(', ');
const RESPONSE_BUTTON_SELECTOR = [
  '[data-qa="vacancy-response-link-top"]',
  '[data-qa="vacancy-response-link"]',
].join(', ');
const RESPONSE_SUBMIT_SELECTOR = [
  '[data-qa="vacancy-response-submit-popup"]',
  '[data-qa="vacancy-response-letter-submit"]',
  '[data-qa="vacancy-response-submit"]',
  '[data-qa*="vacancy-response"][data-qa*="submit"]',
  '[data-qa*="response-question"][data-qa*="submit"]',
  'form:has(textarea) button[type="submit"]',
].join(', ');
const RESUME_ITEM_SELECTOR = [
  '[data-qa="resume-title"]',
  '[data-qa*="resume-select-item"]',
  'label:has([data-qa*="resume"])',
].join(', ');
const RESUME_ANY_SELECTOR =
  '[data-qa="resume-title"], [data-qa*="resume-select-item"], [data-qa*="resume-select"] label, ' +
  '[data-qa="applicant-resumes-select"] label';
const LOGIN_OTP_CONTAINER_SELECTOR = [
  '[data-qa="applicant-login-input-otp"]',
  '[data-qa="magritte-pincode-input"]',
].join(', ');
const LOGIN_CODE_INPUT_SELECTOR = [
  'input[data-qa="magritte-pincode-input-field"]',
  'input[data-qa="applicant-login-input-otp"]',
  'input[data-qa*="code"]',
  'input[name="code"]',
  'input[autocomplete="one-time-code"]',
  'input[inputmode="numeric"]',
].join(', ');
const HH_AUTH_COOKIE_NAME = 'crypted_id';
const HH_APPLICANT_RESUMES_URL = 'https://hh.ru/applicant/resumes';
const VACANCY_PAGE_TITLE_SELECTOR = '[data-qa="vacancy-title"], h1';
const VACANCY_PAGE_COMPANY_SELECTOR = '[data-qa="vacancy-company-name"], [data-qa="vacancy-company-details"]';
const VACANCY_PAGE_SALARY_SELECTOR = '[data-qa="vacancy-salary"], [data-qa="vacancy-compensation"]';
const APPLICANT_MENU_SELECTOR =
  '[data-qa="mainmenu_applicantProfile"], [data-qa="mainmenu_applicantProfileAndResumes"]';
const SUCCESS_SELECTOR =
  '[data-qa*="vacancy-response-request-success"], [data-qa*="response-success"]';
const ALREADY_APPLIED_SELECTOR = [
  '[data-qa="vacancy-response-link-top-again"]',
  '[data-qa="vacancy-response-link-bottom-again"]',
  '[data-qa^="vacancy-response-link-"][data-qa$="-again"]',
].join(', ');
const STEP_NAVIGATION_TIMEOUT = 20_000;
const QUEUE_STATUSES = new Set<HhQueueStatus>([
  'new',
  'opened',
  'prepared',
  'needs_input',
  'sent',
  'already_applied',
  'skipped',
]);
const ACTIONABLE_QUEUE_STATUSES = new Set<HhQueueStatus>([
  'new',
  'opened',
  'prepared',
]);

function isActionableQueueStatus(status: HhQueueStatus): boolean {
  return ACTIONABLE_QUEUE_STATUSES.has(status);
}

function isActionableQueueItem(
  item: Pick<HhQueueItem, 'status' | 'coverLetterPending' | 'coverLetterAdded'>,
): boolean {
  return isActionableQueueStatus(item.status)
    || Boolean(item.coverLetterPending && !item.coverLetterAdded);
}

type HhQueueRunMode = 'queue' | 'manual' | 'daily';

function isQueueItemEligibleForRun(
  item: HhQueueItem,
  mode: HhQueueRunMode,
): boolean {
  if (!isActionableQueueItem(item)) return false;
  if (!item.autoRetryBlockedUntil) return true;
  if (mode === 'manual') return true;
  return mode === 'daily' && item.autoRetryBlockedUntil === 'daily';
}

function pluralRuCount(count: number, one: string, few: string, many: string): string {
  const absolute = Math.abs(count) % 100;
  const last = absolute % 10;
  if (absolute > 10 && absolute < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

function pendingEmployerQuestionsReason(count: number): string {
  return `Нужно ответить на ${count} ${pluralRuCount(
    count,
    'вопрос работодателя',
    'вопроса работодателя',
    'вопросов работодателя',
  )}. Остальные вакансии продолжат обрабатываться.`;
}

/** Only session-wide failures are allowed to stop the whole HH queue. */
export function isFatalHhQueueError(error: unknown, loginRequired = false): boolean {
  if (loginRequired) return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /(?:captcha|капч|авторизац|требуется\s+вход|войдите\s+в\s+(?:аккаунт|hh)|login\s+required|session\s+(?:expired|closed)|сесси[яи].{0,40}(?:истек|закрыт|заверш)|target\s+(?:page,?\s*)?(?:context|browser).{0,60}(?:closed|crashed)|browser.{0,40}(?:closed|disconnected)|context.{0,40}(?:closed|destroyed)|не удалось подключиться к (?:фоновой )?сессии hh|окно браузера.{0,30}закрыт)/iu.test(message);
}

async function allSettledWithConcurrency<T, TResult>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<TResult>,
): Promise<Array<PromiseSettledResult<TResult>>> {
  const results = new Array<PromiseSettledResult<TResult>>(items.length);
  let cursor = 0;
  const runWorker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    () => runWorker(),
  ));
  return results;
}

function scheduleLabel(schedule: string): string {
  if (!schedule) return 'любой формат работы';
  if (schedule === 'remote') return 'только удалённо';
  if (schedule === 'fullDay') return 'полный день';
  if (schedule === 'flexible') return 'гибкий график';
  return schedule;
}

function scanSummaryMessage(summary: HhScanSummary): string {
  const directions = summary.queries.length === 1
    ? '1 поисковому направлению'
    : `${summary.queries.length} поисковым направлениям`;
  if (summary.found === 0) {
    return `${PLATFORM_INFO[summary.platform].label} не показал вакансий по ${directions}. Фильтр: ${scheduleLabel(summary.schedule)}.`;
  }
  return `${PLATFORM_INFO[summary.platform].label} нашёл ${summary.found} вакансий по ${directions}: новых ${summary.newVacancies}, к отклику ${summary.readyToApply}, уже обработано ${summary.alreadyProcessed}. Фильтр: ${scheduleLabel(summary.schedule)}.`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function compactHhText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function polishScreeningDraftLocally(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim().slice(0, 2_000);
  if (!compact) return '';
  const capitalized = compact.replace(/^([a-zа-яё])/u, (letter) => letter.toLocaleUpperCase('ru-RU'));
  return /[.!?…]$/u.test(capitalized) ? capitalized : `${capitalized}.`;
}

const REMOTE_ONLY_RUSSIA_ANSWER = 'Нет, переезд по России не рассматриваю. Интересует только полностью удалённый формат работы.';

function findReusableScreeningFact<T extends Pick<HhScreeningFact, 'question' | 'answer' | 'selectedOptions'>>(
  question: HhScreeningQuestion,
  candidates: Iterable<T>,
): T | undefined {
  for (const candidate of candidates) {
    if (reusableScreeningAnswer(question, candidate)?.canAutoFill) return candidate;
  }
  return undefined;
}

function findExactVacancyScreeningAnswer(
  question: HhScreeningQuestion,
  answers: readonly HhStoredScreeningAnswer[] | undefined,
): HhStoredScreeningAnswer | undefined {
  const promptKey = screeningQuestionKey(question.prompt);
  if (!promptKey) return undefined;
  return answers?.find((answer) => (
    answer.confirmedByUser === true
    && screeningQuestionKey(answer.question) === promptKey
  ));
}

function safeJsonRead<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function isHhPage(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLocaleLowerCase('en-US');
    return host === 'hh.ru' || host.endsWith('.hh.ru');
  } catch {
    return false;
  }
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
    laquo: '«', raquo: '»', mdash: '—', ndash: '–',
  };
  return value
    .replace(/&#(\d+);/g, (match, rawCode: string) => {
      const code = Number(rawCode);
      try { return Number.isInteger(code) ? String.fromCodePoint(code) : match; } catch { return match; }
    })
    .replace(/&#x([\da-f]+);/gi, (match, rawCode: string) => {
      const code = Number.parseInt(rawCode, 16);
      try { return Number.isInteger(code) ? String.fromCodePoint(code) : match; } catch { return match; }
    })
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLocaleLowerCase('en-US')] ?? match);
}

function htmlText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

function htmlAttribute(attributes: string, name: string): string {
  const match = attributes.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'),
  );
  return decodeHtmlEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? '');
}

function cleanHhResumeTitle(value: string): string {
  let title = htmlText(value)
    .replace(/^(?:открыть|посмотреть)\s+(?:резюме\s*)?/i, '')
    .replace(/^резюме\s+[«"]?/i, '')
    .replace(/[»"]?\s*(?:—|–|-)\s*(?:резюме\b.*|hh\.ru\b.*|headhunter\b.*)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (
    /^(?:резюме|мои резюме|открыть|посмотреть|редактировать|обновить|поднять в поиске|статистика|скачать|удалить|настройки видимости)$/i.test(title)
  ) return '';
  if (title.length > 240) title = title.slice(0, 240).trim();
  return title;
}

function resumeTitleScore(title: string): number {
  if (!title || !/[\p{L}\p{N}]/u.test(title)) return 0;
  return Math.min(title.length, 160) + (/\p{L}/u.test(title) ? 100 : 0);
}

export function resumeTitleMatches(left: string, right: string): boolean {
  const normalize = (value: string) => value.toLocaleLowerCase('ru').replace(/\s+/g, ' ').trim();
  const leftNormalized = normalize(left);
  const rightNormalized = normalize(right);
  if (!leftNormalized || !rightNormalized) return false;
  if (leftNormalized.includes(rightNormalized) || rightNormalized.includes(leftNormalized)) return true;
  const tokens = (value: string) =>
    new Set(value.split(/[^a-zа-яё0-9+#.]+/i).filter((token) => token.length > 2));
  const leftTokens = tokens(leftNormalized);
  const rightTokens = tokens(rightNormalized);
  const smaller = Math.min(leftTokens.size, rightTokens.size);
  if (smaller === 0) return false;
  let overlap = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
  return overlap >= Math.max(2, Math.ceil(smaller * 0.6));
}

function normalizeHhResumeTitleForSelection(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

function explicitlySelectedTitleIndex(titles: string[], selectedResumeTitle: string): number | null {
  const selected = normalizeHhResumeTitleForSelection(selectedResumeTitle);
  if (!selected) return null;
  const exactIndices = titles.flatMap((title, index) =>
    normalizeHhResumeTitleForSelection(title) === selected ? [index] : []);
  if (exactIndices.length === 1) return exactIndices[0];
  // A persisted résumé is factual provenance for salary, city and experience.
  // Never silently replace it with the only fuzzy-looking card: even without
  // a salary in the title it can be a different résumé with different facts.
  return null;
}

/**
 * Resolves an explicitly persisted résumé title without letting a fuzzy match
 * swap two otherwise identical résumés that have different salary targets.
 */
export function findExplicitlySelectedHhResume(
  resumes: HhApplicantResume[],
  selectedResumeTitle: string,
): HhApplicantResume | undefined {
  const index = explicitlySelectedTitleIndex(
    resumes.map((resume) => resume.title),
    selectedResumeTitle,
  );
  return index == null ? undefined : resumes[index];
}

function resumeTitleFactSources(
  selectedResumeTitle: string | undefined,
  configuredResumeTitles: string[],
): string[] {
  const selected = selectedResumeTitle?.trim() ?? '';
  if (selected) return [selected];
  const configured = configuredResumeTitles.filter((title) => title.trim());
  // With several configured résumés, a title-level fact (most importantly the
  // salary) is ambiguous until the exact résumé for this vacancy is selected.
  return configured.length === 1 ? configured : [];
}

function selectedResumeFactSources(
  selectedResumeTitle: string | undefined,
  selectedResumeText: string,
  configuredResumeTitles: string[],
): string[] {
  const selected = selectedResumeTitle?.trim() ?? '';
  const explicitSalaryLines = selectedResumeText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /(?:финансов[а-яё]*\s+ожидан|зарплатн[а-яё]*\s+ожидан|(?:желаем|ожидаем|expected|desired).{0,40}(?:зарплат|доход|компенсац|оплат|salary|income|compensation)|(?:зарплат|доход|компенсац|оплат|salary|income|compensation).{0,40}(?:желаем|ожидаем|expected|desired))/i.test(line));
  return selected
    ? [selected, ...explicitSalaryLines].filter(Boolean)
    : [...explicitSalaryLines, ...resumeTitleFactSources(undefined, configuredResumeTitles)].filter(Boolean);
}

function normalizeHhResumeLink(rawUrl: string): { id: string; url: string } | null {
  const unescaped = decodeHtmlEntities(rawUrl)
    .replace(/\\u002f/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/');
  try {
    const url = new URL(unescaped, 'https://hh.ru');
    if (url.protocol !== 'https:' || !isHhPage(url.toString())) return null;
    const match = url.pathname.match(/^\/resume\/([a-zA-Z0-9-]{8,})(?:\/|$)/);
    if (!match) return null;
    url.pathname = `/resume/${match[1]}`;
    url.search = '';
    url.hash = '';
    return { id: match[1], url: url.toString() };
  } catch {
    return null;
  }
}

export function extractHhResumeTitleFromHtml(html: string): string {
  const patterns = [
    /<[^>]+data-qa=["'][^"']*resume[^"']*(?:title|position)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
    /<[^>]+data-qa=["'][^"']*(?:title|position)[^"']*resume[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
    /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
    /<title\b[^>]*>([\s\S]*?)<\/title>/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    const title = cleanHhResumeTitle(match?.[1] ?? '');
    if (resumeTitleScore(title) > 0) return title;
  }
  return '';
}

export function extractHhResumesFromHtml(html: string): HhApplicantResume[] {
  const normalizedHtml = html.replace(/\\u002f/gi, '/').replace(/\\\//g, '/');
  const resumes = new Map<string, { resume: HhApplicantResume; titleScore: number }>();
  const remember = (rawUrl: string, rawTitle = '') => {
    const normalized = normalizeHhResumeLink(rawUrl);
    if (!normalized) return;
    const title = cleanHhResumeTitle(rawTitle);
    const titleScore = resumeTitleScore(title);
    const current = resumes.get(normalized.id);
    if (!current || titleScore > current.titleScore) {
      resumes.set(normalized.id, {
        resume: { ...normalized, title },
        titleScore,
      });
    }
  };

  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of normalizedHtml.matchAll(anchorPattern)) {
    const attributes = match[1] ?? '';
    const href = htmlAttribute(attributes, 'href');
    if (!href.includes('/resume/')) continue;
    const text = htmlText(match[2] ?? '');
    const ariaLabel = htmlAttribute(attributes, 'aria-label');
    const titleAttribute = htmlAttribute(attributes, 'title');
    const candidates = [text, ariaLabel, titleAttribute];
    candidates.sort((left, right) => resumeTitleScore(cleanHhResumeTitle(right)) - resumeTitleScore(cleanHhResumeTitle(left)));
    remember(href, candidates[0] ?? '');
  }

  const fullUrlPattern = /https:\/\/(?:[a-z0-9-]+\.)*hh\.ru\/resume\/[a-zA-Z0-9-]{8,}(?:[/?#][^"'<>\\\s]*)?/gi;
  for (const match of normalizedHtml.matchAll(fullUrlPattern)) remember(match[0]);
  const relativeUrlPattern = /(?:^|["'=:({\s])(\/resume\/[a-zA-Z0-9-]{8,}(?:[/?#][^"'<>\\\s]*)?)/gi;
  for (const match of normalizedHtml.matchAll(relativeUrlPattern)) remember(match[1] ?? '');

  return [...resumes.values()].map(({ resume }) => resume);
}

function normalizePlatform(value: unknown): JobPlatform {
  return value === 'linkedin' || value === 'avito' ? value : 'hh';
}

function allowedHost(host: string, roots: string[]): boolean {
  const normalized = host.toLocaleLowerCase('en-US');
  return roots.some((root) => normalized === root || normalized.endsWith(`.${root}`));
}

function isPlatformPage(platform: JobPlatform, rawUrl: string): boolean {
  try { return allowedHost(new URL(rawUrl).hostname, PLATFORM_INFO[platform].hosts); } catch { return false; }
}

function normalizeJobUrl(platform: JobPlatform, raw: string): string {
  if (platform === 'hh') return normalizeHhVacancyUrl(raw);
  try {
    const url = new URL(raw, PLATFORM_INFO[platform].homeUrl);
    if (url.protocol !== 'https:' || !allowedHost(url.hostname, PLATFORM_INFO[platform].hosts)) return '';
    if (platform === 'linkedin') {
      const match = url.pathname.match(/^\/jobs\/view\/(?:[^/]*-)?(\d+)\/?$/);
      return match ? `https://www.linkedin.com/jobs/view/${match[1]}` : '';
    }
    const match = url.pathname.match(/\/vakansii\/[^/?]*?_(\d+)\/?$/);
    if (!match) return '';
    url.search = ''; url.hash = ''; url.pathname = url.pathname.replace(/\/$/, '');
    return url.toString();
  } catch { return ''; }
}

function jobIdFromUrl(platform: JobPlatform, raw: string): string {
  const url = normalizeJobUrl(platform, raw);
  if (!url) return '';
  if (platform === 'hh') return url.match(/\/vacancy\/(\d+)$/)?.[1] ?? '';
  if (platform === 'linkedin') return url.match(/\/jobs\/view\/(\d+)$/)?.[1] ?? '';
  return url.match(/_(\d+)$/)?.[1] ?? '';
}

function jobKey(platform: JobPlatform, id: string): string { return `${platform}:${id}`; }

function buildPlatformSearchUrl(
  platform: JobPlatform,
  config: HhAssistantConfig,
  page = 0,
  query = config.query,
): string {
  if (platform === 'hh') return buildHhSearchUrl({ ...config, query }, page);
  if (platform === 'linkedin') {
    const url = new URL('https://www.linkedin.com/jobs/search/');
    if (query) url.searchParams.set('keywords', query);
    if (config.linkedinLocation) url.searchParams.set('location', config.linkedinLocation);
    if (config.linkedinEasyApplyOnly) url.searchParams.set('f_AL', 'true');
    if (page) url.searchParams.set('start', String(page * 25));
    return url.toString();
  }
  const url = new URL(`https://www.avito.ru/${config.avitoCity || 'all'}/vakansii`);
  if (query) url.searchParams.set('q', query);
  if (config.salaryFrom) url.searchParams.set('pmin', String(config.salaryFrom));
  url.searchParams.set('p', String(page + 1));
  return url.toString();
}

async function firstText(root: Page | Locator, selectors: string[]): Promise<string> {
  for (const selector of selectors) {
    const locator = root.locator(selector).first();
    if ((await locator.count().catch(() => 0)) === 0) continue;
    const text = String(await locator.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (text) return text;
    const content = String(await locator.getAttribute('content').catch(() => '')).trim();
    if (content) return content;
  }
  return '';
}

async function extractPlatformCards(page: Page, platform: JobPlatform): Promise<Array<HhVacancy & { description: string; easyApply: boolean }>> {
  const info = PLATFORM_INFO[platform];
  let cards: Locator | null = null;
  for (const selector of info.cards) {
    const candidate = page.locator(selector);
    if ((await candidate.count().catch(() => 0)) > 0) { cards = candidate; break; }
  }
  if (!cards) return [];
  const result: Array<HhVacancy & { description: string; easyApply: boolean }> = [];
  const seen = new Set<string>();
  for (let index = 0, count = Math.min(await cards.count(), 100); index < count; index += 1) {
    const card = cards.nth(index);
    let title = (await firstText(card, info.titles)).slice(0, 300);
    let href = '';
    for (const selector of info.links) {
      href = String(await card.locator(selector).first().getAttribute('href').catch(() => '')).trim();
      if (href) break;
    }
    let url = normalizeJobUrl(platform, href);
    let componentId = '';
    if (platform === 'linkedin' && !url) {
      componentId = String(await card.getAttribute('componentkey').catch(() => '')).match(/^job-card-component-ref-(\d+)$/)?.[1] ?? '';
      if (componentId) {
        url = `https://www.linkedin.com/jobs/view/${componentId}`;
        const paragraphs = await card.locator('p').allInnerTexts().catch(() => []);
        title = String(paragraphs[0] ?? title).replace(/\s+/g, ' ').trim().slice(0, 300);
      }
    }
    const id = platform === 'avito'
      ? String(await card.getAttribute('data-item-id').catch(() => '')).trim() || jobIdFromUrl(platform, url)
      : componentId || jobIdFromUrl(platform, url);
    if (!id || !title || !url || seen.has(id)) continue;
    seen.add(id);
    const description = (await firstText(card, info.descriptions)).slice(0, 4000);
    result.push({ id, key: jobKey(platform, id), platform, title, url,
      company: (await firstText(card, info.companies)).slice(0, 300),
      salary: (await firstText(card, info.salaries)).slice(0, 120),
      description,
      easyApply: platform === 'linkedin' && /easy apply|прост(?:ая|ой)|быстр(?:ая|ый)/i.test(description),
    });
  }
  return result;
}

export function browserCandidatePaths(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Array<{ label: string; executable: string }> {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  if (platform === 'darwin') {
    const applicationRoots = [
      '/Applications',
      env.HOME ? join(env.HOME, 'Applications') : '',
    ].filter(Boolean);
    const appExecutables = [
      ['Google Chrome', 'Google Chrome.app/Contents/MacOS/Google Chrome'],
      ['Microsoft Edge', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      ['Brave', 'Brave Browser.app/Contents/MacOS/Brave Browser'],
    ] as const;
    return applicationRoots.flatMap((root) => appExecutables.map(([label, relative]) => ({
      label,
      executable: join(root, relative),
    })));
  }

  if (platform === 'linux') {
    return [
      { label: 'Google Chrome', executable: '/usr/bin/google-chrome' },
      { label: 'Chromium', executable: '/usr/bin/chromium' },
      { label: 'Chromium', executable: '/usr/bin/chromium-browser' },
    ];
  }

  const envValue = (key: string): string => {
    const actualKey = Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    return actualKey ? String(env[actualKey] ?? '').trim() : '';
  };
  const localAppData = envValue('LOCALAPPDATA');
  const roots = [
    localAppData,
    envValue('PROGRAMFILES'),
    envValue('PROGRAMW6432'),
    envValue('PROGRAMFILES(X86)'),
  ].filter((root, index, all): root is string => Boolean(root) && (
    all.findIndex((candidate) => candidate.toLowerCase() === root.toLowerCase()) === index
  ));
  const explicitCandidates = [
    ['Google Chrome', envValue('CHROME_PATH')],
    ['Microsoft Edge', envValue('EDGE_PATH')],
    ['Brave', envValue('BRAVE_PATH')],
    ['Vivaldi', envValue('VIVALDI_PATH')],
    ['Chromium', envValue('CHROMIUM_PATH')],
  ] as const;
  const installations = [
    ['Google Chrome', 'Google', 'Chrome', 'Application', 'chrome.exe'],
    ['Google Chrome Beta', 'Google', 'Chrome Beta', 'Application', 'chrome.exe'],
    ['Google Chrome Canary', 'Google', 'Chrome SxS', 'Application', 'chrome.exe'],
    ['Microsoft Edge', 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
    ['Microsoft Edge Beta', 'Microsoft', 'Edge Beta', 'Application', 'msedge.exe'],
    ['Microsoft Edge Dev', 'Microsoft', 'Edge Dev', 'Application', 'msedge.exe'],
    ['Brave', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
    ['Vivaldi', 'Vivaldi', 'Application', 'vivaldi.exe'],
    ['Chromium', 'Chromium', 'Application', 'chrome.exe'],
  ] as const;
  const candidates: Array<{ label: string; executable: string }> = [];
  for (const [label, executable] of explicitCandidates) {
    if (executable) candidates.push({ label, executable });
  }
  candidates.push(...roots.flatMap((root) => installations.map(([label, ...relative]) => ({
    label,
    executable: join(root, ...relative),
  }))));
  if (localAppData) {
    candidates.push({
      label: 'Chromium',
      executable: join(localAppData, 'Programs', 'Chromium', 'Application', 'chrome.exe'),
    });
  }
  return candidates;
}

function installedBrowserCandidates(): Array<{ label: string; executable: string }> {
  const candidates = browserCandidatePaths(process.platform, process.env);
  return candidates.filter((candidate, index, all) => fs.existsSync(candidate.executable) && all.findIndex((item) => item.executable.toLowerCase() === candidate.executable.toLowerCase()) === index);
}

export function browserLaunchFailureMessage(
  attemptedCandidates: number,
  errors: string[],
): string {
  if (attemptedCandidates === 0) {
    return [
      'Для подключения HH нужен Chrome, Edge, Brave, Vivaldi или Chromium.',
      'Установите поддерживаемый браузер и повторите подключение.',
      'Firefox не подходит для автоматизации HH через Chromium DevTools.',
    ].join(' ');
  }
  const details = errors.length > 0 ? ` ${errors.join(' | ')}` : '';
  return `Не удалось запустить поддерживаемый Chromium-браузер.${details}`;
}

interface ProfileDebugInfo {
  port: number;
  mode: BrowserRunMode | null;
}

const WINDOWS_BROWSER_PROCESS_NAME_FILTER = [
  "$_.Name -eq 'chrome.exe'",
  "$_.Name -eq 'msedge.exe'",
  "$_.Name -eq 'brave.exe'",
  "$_.Name -eq 'vivaldi.exe'",
].join(' -or ');

export function debugInfoFromBrowserCommandLine(commandLine: string): ProfileDebugInfo | null {
  const port = Number(commandLine.match(/--remote-debugging-port(?:=|\s+)(\d+)/i)?.[1]);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return null;
  return {
    port,
    mode: /--headless(?:=|\s|$)/i.test(commandLine) ? 'background' : 'interactive',
  };
}

function profileDebugInfo(profileDir: string): ProfileDebugInfo | null {
  try {
    const customPath = path.join(profileDir, 'SkillCueDebugPort');
    const portFile = fs.existsSync(customPath) ? customPath : path.join(profileDir, 'DevToolsActivePort');
    const lines = fs.readFileSync(portFile, 'utf8').split(/\r?\n/);
    const port = Number(lines[0]);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) return null;
    const mode = lines[1] === 'background' || lines[1] === 'interactive' ? lines[1] : null;
    return { port, mode };
  } catch { return null; }
}


export function profileBrowserCommandLineScript(): string {
  return [
    "$target = [IO.Path]::GetFullPath($env:SKILLCUE_AUTOMATION_PROFILE).TrimEnd('\\')",
    // Keep the complete Where-Object expression in one PowerShell statement.
    // Joining the old multiline form with semicolons produced `{; ... -and;`
    // and silently made live-profile discovery fail on every retry.
    `$browser = Get-CimInstance Win32_Process | Where-Object { (${WINDOWS_BROWSER_PROCESS_NAME_FILTER}) -and $_.CommandLine -and $_.CommandLine.IndexOf($target, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -match '--remote-debugging-port(?:=|\\s+)(\\d+)' } | Select-Object -First 1`,
    "if ($browser) { [Console]::Out.Write($browser.CommandLine) }",
  ].join('; ');
}

async function runningProfileDebugInfo(profileDir: string): Promise<ProfileDebugInfo | null> {
  if (process.platform !== 'win32') return null;
  const script = profileBrowserCommandLineScript();
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        env: { ...process.env, SKILLCUE_AUTOMATION_PROFILE: path.resolve(profileDir) },
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    );
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.once('error', () => resolve(null));
    child.once('exit', () => resolve(debugInfoFromBrowserCommandLine(stdout)));
  });
}

export function browserLaunchArguments(
  profileDir: string,
  debugPort: number,
  mode: BrowserRunMode,
): string[] {
  const args = [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    '--remote-allow-origins=*',
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
  ];
  if (mode === 'background') {
    args.push('--headless=new', '--window-size=1365,900', '--disable-gpu');
  } else {
    args.push('--start-maximized');
  }
  // Chrome creates one initial target itself. Do not append about:blank: doing
  // so adds another restorable tab on every application start.
  return args;
}

async function allocateDebugPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('не удалось выделить CDP-порт')));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function terminateBrowserProcessTree(child: ChildProcess | null): Promise<void> {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform !== 'win32') {
    child.kill();
    return;
  }
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => resolve());
    killer.once('exit', () => resolve());
  });
}

/**
 * A previous packaged SkillCue version may leave its dedicated Chrome/Edge
 * process alive without SkillCueDebugPort. Starting another browser against
 * the same profile then reuses that visible window and adds another blank tab.
 * Kill only browser processes whose command line contains this exact private
 * profile path; regular user Chrome/Edge profiles are never matched.
 */
export function profileBrowserCleanupScript(): string {
  return [
    "$target = [IO.Path]::GetFullPath($env:SKILLCUE_AUTOMATION_PROFILE).TrimEnd('\\')",
    "$browsers = Get-CimInstance Win32_Process | Where-Object {",
    `  (${WINDOWS_BROWSER_PROCESS_NAME_FILTER}) -and`,
    "  $_.CommandLine -and $_.CommandLine.IndexOf($target, [StringComparison]::OrdinalIgnoreCase) -ge 0",
    '}',
    '$browsers | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
  ].join('; ');
}

async function terminateOrphanedProfileBrowsers(profileDir: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const script = profileBrowserCleanupScript();
  const cleanup = new Promise<void>((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        env: { ...process.env, SKILLCUE_AUTOMATION_PROFILE: path.resolve(profileDir) },
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    child.once('error', () => resolve());
    child.once('exit', () => resolve());
  });
  await settleWithin(cleanup, 5_000);
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    void promise.then(finish, finish);
  });
}

export function isRecoverableHhLoginNavigationAbort(
  error: unknown,
  currentUrl: string,
): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes('net::ERR_ABORTED')) return false;
  try {
    const url = new URL(currentUrl);
    return isHhPage(currentUrl) && url.pathname.startsWith('/account/login');
  } catch {
    return false;
  }
}

export function isBrokenHhLoginSourcePage(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (!isHhPage(rawUrl)) return false;
    return url.pathname === '/negotiations' || url.pathname.startsWith('/404');
  } catch {
    return false;
  }
}

async function navigateToHhLogin(page: Page): Promise<void> {
  const loginUrl =
    'https://hh.ru/account/login?backurl=%2Fapplicant%2Fresumes&role=applicant';
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.goto(loginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      return;
    } catch (error) {
      lastError = error;
      // HH sometimes interrupts the initial navigation while rebuilding its
      // login route. Playwright reports ERR_ABORTED even though the expected
      // page is already open and usable.
      await page.waitForTimeout(250);
      if (isRecoverableHhLoginNavigationAbort(error, page.url())) {
        await page
          .waitForLoadState('domcontentloaded', { timeout: 5_000 })
          .catch(() => undefined);
        return;
      }
      if (!String(error).includes('net::ERR_ABORTED') || attempt === 1) throw error;
    }
  }
  throw lastError;
}

async function waitForHhOtpReady(
  page: Page,
  timeout = 20_000,
): Promise<{ container: Locator; input: Locator }> {
  const container = page.locator(LOGIN_OTP_CONTAINER_SELECTOR).first();
  const input = page.locator(LOGIN_CODE_INPUT_SELECTOR).first();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const inputAttached = (await input.count().catch(() => 0)) > 0;
    const inputEnabled = inputAttached && (await input.isEnabled().catch(() => false));
    if (inputEnabled) return { container, input };
    await page.waitForTimeout(200);
  }
  throw new Error(
    'HH не показал поле для кода. Запросите новый код и оставьте открытое окно HH.',
  );
}

async function firstVisibleText(page: Page, selector: string): Promise<string> {
  const matches = page.locator(selector);
  const count = Math.min(await matches.count().catch(() => 0), 20);
  for (let index = 0; index < count; index += 1) {
    const match = matches.nth(index);
    if (!(await match.isVisible().catch(() => false))) continue;
    const text = (await match.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return '';
}

function hhVacancyId(rawUrl: string): string {
  return normalizeHhVacancyUrl(rawUrl).match(/\/vacancy\/(\d+)$/)?.[1] ?? '';
}

export function isAlreadyAppliedHhText(value: string): boolean {
  const text = value.toLocaleLowerCase('ru').replace(/\s+/g, ' ').trim();
  return [
    'вы откликнулись',
    'вы уже откликнулись',
    'вы уже откликались',
    'отклик уже отправлен',
    'отклик был отправлен',
  ].some((marker) => text.includes(marker));
}

async function hasVisible(page: Page, selector: string): Promise<boolean> {
  const locator = page.locator(selector);
  const count = Math.min(await locator.count(), 20);
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

/**
 * HH also renders generic "ask the employer" suggestion cards whose data-qa
 * starts with vacancy-response-question. They are not screening questions and
 * must not block an application. Only controls inside the actual response form
 * or modal are treated as blockers.
 */
async function hasVisibleResponseFlowBlocker(page: Page): Promise<boolean> {
  const locator = page.locator(`${RESPONSE_QUESTION_SELECTOR}, ${RESPONSE_TEST_SELECTOR}`);
  const count = Math.min(await locator.count().catch(() => 0), 30);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const isInsideResponseFlow = await candidate
      .evaluate((element, containerSelector) =>
        Boolean(element.closest(String(containerSelector))), RESPONSE_FLOW_CONTAINER_SELECTOR)
      .catch(() => false);
    if (isInsideResponseFlow) return true;
  }
  return false;
}

const LEGACY_TRANSIENT_SCREENING_REASON =
  'Не удалось получить безопасный AI-ответ: Screening answer generation timed out';

function normalizeStoredScreeningQuestion(value: unknown): HhScreeningQuestion | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const id = String(item.id ?? '').trim().slice(0, 100);
  const prompt = String(item.prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 1_200);
  if (!id || !prompt) return null;
  const rawKind = String(item.kind ?? 'text');
  const kind = new Set(['text', 'single', 'multiple', 'select']).has(rawKind)
    ? rawKind as HhScreeningQuestion['kind']
    : 'text';
  const options = Array.isArray(item.options)
    ? item.options.map((option) => String(option).trim().slice(0, 300)).filter(Boolean).slice(0, 30)
    : [];
  const storedAssistantReason = String(item.assistantReason ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const storedSuggestedAnswer = String(item.suggestedAnswer ?? '').trim().slice(0, 2_000);
  const storedSuggestedOptions = Array.isArray(item.suggestedOptions)
    ? item.suggestedOptions
      .map((option) => String(option).trim().slice(0, 300))
      .filter((option) => option && options.includes(option))
      .slice(0, 30)
    : [];
  const normalized: HhScreeningQuestion = {
    id,
    prompt,
    kind,
    options,
    required: Boolean(item.required),
    assistantReason: storedAssistantReason || undefined,
    suggestedAnswer: storedSuggestedAnswer || undefined,
    suggestedOptions: storedSuggestedOptions.length > 0 ? storedSuggestedOptions : undefined,
  };
  const fallback = buildHhScreeningReviewDraft(normalized);
  const unsafeLegacySensitiveDraft = isSensitiveHhScreeningChoice(prompt);
  // Persisted queue suggestions predate provenance metadata. Any preselected
  // closed-choice value can encode an invented preference or status even when
  // its prompt is not yet in our sensitivity vocabulary. Rebuild all such
  // options on upgrade; exact résumé/fact rules will rehydrate grounded values.
  const unsafeLegacyClosedSelection = kind !== 'text' && storedSuggestedOptions.length > 0;
  const storedDraftUsable = isUsableHhScreeningDraft(normalized, {
    answer: storedSuggestedAnswer,
    selectedOptions: storedSuggestedOptions,
  });
  if (!unsafeLegacySensitiveDraft && !unsafeLegacyClosedSelection && storedDraftUsable) return normalized;

  // Builds before the provenance contract persisted empty questions and, in
  // some cases, guessed Да/Нет for legal or personal-history choices. They
  // have no source metadata, so only a newly built review-only fallback is
  // safe to restore. Grounded city/salary facts are reconciled immediately
  // afterwards by reconcileKnownPendingScreeningQuestions.
  return {
    ...normalized,
    assistantReason: storedAssistantReason === LEGACY_TRANSIENT_SCREENING_REASON
      ? storedAssistantReason
      : fallback.reason || normalized.assistantReason,
    suggestedAnswer: fallback.answer || undefined,
    suggestedOptions: fallback.selectedOptions.length > 0
      ? fallback.selectedOptions
      : undefined,
  };
}

function isLegacyTransientScreeningQuestion(question: HhScreeningQuestion): boolean {
  // Deliberately exact: only the synthetic timeout generated by the affected
  // builds is migrated. Real unanswered employer questions stay untouched.
  return question.assistantReason === LEGACY_TRANSIENT_SCREENING_REASON;
}

function normalizeStoredScreeningAnswer(value: unknown): HhStoredScreeningAnswer | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const questionId = String(item.questionId ?? '').trim().slice(0, 100);
  const question = String(item.question ?? '').replace(/\s+/g, ' ').trim().slice(0, 1_200);
  const answer = String(item.answer ?? '').trim().slice(0, 2_000);
  const selectedOptions = Array.isArray(item.selectedOptions)
    ? item.selectedOptions.map((option) => String(option).trim().slice(0, 300)).filter(Boolean).slice(0, 30)
    : [];
  if (!questionId || !question || (!answer && selectedOptions.length === 0)) return null;
  return {
    questionId,
    question,
    answer,
    selectedOptions,
    ...(item.confirmedByUser === true ? { confirmedByUser: true } : {}),
  };
}

function normalizeScreeningFacts(value: unknown): HhScreeningFact[] {
  if (!Array.isArray(value)) return [];
  const byQuestion = new Map<string, HhScreeningFact>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const question = String(item.question ?? '').replace(/\s+/g, ' ').trim().slice(0, 1_200);
    const answer = String(item.answer ?? '').trim().slice(0, 2_000);
    const selectedOptions = Array.isArray(item.selectedOptions)
      ? item.selectedOptions.map((option) => String(option).trim().slice(0, 300)).filter(Boolean).slice(0, 30)
      : [];
    if (!question || (!answer && selectedOptions.length === 0)) continue;
    // Older builds treated the default HH search format "remote" as an
    // explicit refusal to relocate. The HH settings screen never asked the
    // user to confirm that preference, so this synthetic fact is not valid
    // provenance and must not survive an upgrade.
    if (answer === REMOTE_ONLY_RUSSIA_ANSWER && selectedOptions.length === 0) continue;
    const updatedAt = String(item.updatedAt ?? '');
    const fact: HhScreeningFact = {
      id: String(item.id ?? `fact-${Date.now()}-${byQuestion.size}`).trim().slice(0, 140),
      question,
      answer,
      selectedOptions,
      updatedAt: Number.isNaN(Date.parse(updatedAt)) ? nowIso() : updatedAt,
    };
    byQuestion.set(screeningQuestionSemanticKey(fact.question), fact);
    if (byQuestion.size >= 100) break;
  }
  return [...byQuestion.values()];
}

export function normalizePersistedQueue(
  value: unknown,
  _restoreLegacyPreSubmissionState = true,
): HhQueueItem[] {
  if (!Array.isArray(value)) return [];
  const result: HhQueueItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const inferredPlatform: JobPlatform = String(item.url ?? '').includes('linkedin.com')
      ? 'linkedin' : String(item.url ?? '').includes('avito.ru') ? 'avito' : 'hh';
    const platform = normalizePlatform(item.platform ?? inferredPlatform);
    const url = normalizeJobUrl(platform, String(item.url ?? ''));
    const id = jobIdFromUrl(platform, url);
    const title = String(item.title ?? '').trim().slice(0, 300);
    if (!id || !title) continue;
    const rawStatus = String(item.status ?? 'new') as HhQueueStatus;
    const addedAt = String(item.addedAt ?? '');
    const reason = typeof item.reason === 'string'
      ? item.reason.trim().slice(0, 300) || undefined
      : undefined;
    const sentAt =
      typeof item.sentAt === 'string' && !Number.isNaN(Date.parse(item.sentAt))
        ? item.sentAt
        : undefined;
    const legacyAlreadyApplied = rawStatus === 'sent'
      && !sentAt
      && /(?:уже отклик|hh показывает|отправлен ранее)/i.test(reason ?? '');
    // This is not a terminal HH state. Older builds could enter the
    // post-response cover-letter flow before the response itself had been
    // submitted, fail to find a negotiation and then hide a perfectly
    // actionable vacancy. Repair it on every load (not only once by schema
    // version), because the same false state can also be persisted by a newer
    // interrupted run.
    const stalePreSubmissionCoverLetterState = rawStatus === 'skipped'
      && /отклик больше не найден в активных переговорах hh/i.test(reason ?? '')
      && !sentAt;
    // Older versions treated the absence of an explicit "remote" sentence as
    // proof that the role was office-only. That hides valid hybrid/unspecified
    // vacancies even when the employer never requires office attendance. Only
    // an explicit office requirement is a safe negative signal, so return the
    // old false-negative state to the live queue for a fresh page check.
    const staleUnconfirmedRemoteState = rawStatus === 'skipped'
      && /(?:не подтвержд[её]н выбранный удал[её]нный формат|отсутств(?:ует|ие) явн(?:ой|ого).{0,80}удал[её]н)/i.test(reason ?? '')
      && !sentAt;
    const staleFalseNegativeState = stalePreSubmissionCoverLetterState || staleUnconfirmedRemoteState;
    const storedPendingQuestions = Array.isArray(item.pendingQuestions)
      ? item.pendingQuestions.map(normalizeStoredScreeningQuestion).filter((question): question is HhScreeningQuestion => Boolean(question)).slice(0, 60)
      : [];
    const pendingQuestions = storedPendingQuestions.filter(
      (question) => !isLegacyTransientScreeningQuestion(question),
    );
    const removedTransientQuestions = storedPendingQuestions.length - pendingQuestions.length;
    const onlyLegacyTransientQuestions = removedTransientQuestions > 0
      && pendingQuestions.length === 0
      && rawStatus !== 'sent'
      && rawStatus !== 'already_applied'
      && rawStatus !== 'skipped';
    const screeningAnswers = Array.isArray(item.screeningAnswers)
      ? item.screeningAnswers
        .map(normalizeStoredScreeningAnswer)
        .filter((answer): answer is HhStoredScreeningAnswer => Boolean(answer))
        // See normalizeScreeningFacts: this exact text was generated from a
        // default search filter, not from a confirmed screening answer.
        .filter((answer) => answer.answer !== REMOTE_ONLY_RUSSIA_ANSWER)
        .slice(0, 60)
      : [];
    const preparationNotes = Array.isArray(item.preparationNotes)
      ? [...new Set(item.preparationNotes
        .map((note) => String(note).replace(/\s+/g, ' ').trim().slice(0, 500))
        .filter(Boolean))].slice(0, 20)
      : [];
    const coverLetterAdded = Boolean(item.coverLetterAdded);
    const recentUnconfirmedLetter = rawStatus === 'sent'
      && !coverLetterAdded
      && Boolean(sentAt)
      && Date.now() - Date.parse(sentAt as string) <= 7 * 24 * 60 * 60 * 1_000
      && /^отклик отправлен\.?$/i.test(reason ?? '');
    const needsScreeningInput = pendingQuestions.length > 0
      && rawStatus !== 'sent'
      && rawStatus !== 'already_applied'
      && rawStatus !== 'skipped';
    const coverLetterPending = rawStatus !== 'skipped'
      && !needsScreeningInput
      && !coverLetterAdded
      && (Boolean(item.coverLetterPending) || recentUnconfirmedLetter);
    const storedAutoRetryBlock = item.autoRetryBlockedUntil === 'manual'
      || item.autoRetryBlockedUntil === 'daily'
      ? item.autoRetryBlockedUntil
      : undefined;
    // v8 originally forced every multi-resume user to open settings and
    // confirm a resume once. That made an enabled auto-send queue stop on
    // every restored vacancy even though the assistant refreshes the actual
    // HH resume list, ranks it per vacancy and verifies the selected title in
    // the response form. Release those historical gates back to automation.
    const staleManualResumeGate = storedAutoRetryBlock === 'manual' && (
      /после обновления нужно один раз явно выбрать резюме hh/i.test(reason ?? '')
      || /выбранное резюме .+ больше не найдено в hh или не определяется однозначно/i.test(reason ?? '')
      || /не удалось однозначно выбрать одно из резюме hh/i.test(reason ?? '')
    );
    // A grounded skill mismatch is terminal for this vacancy, not a request
    // for the user to launch it manually. Older builds persisted the model's
    // explanation as a manual cover-letter failure.
    const staleManualSkillMismatch = rawStatus === 'opened'
      && storedAutoRetryBlock === 'manual'
      && /^отклик не начат:/iu.test(reason ?? '')
      && /(?:does not provide direct experience|does not align closely enough|core requirements|skill mismatch|недостаточно подтвержд[её]нн)/i.test(reason ?? '');
    // Builds before persisted retry gates left cover-letter preparation
    // failures as plain `opened` items. Restoring those items used to arm the
    // 10-second queue timer and regenerate the same rejected letter forever.
    // Keep them available for an explicit retry, but never auto-resume them.
    const legacyUngatedCoverLetterFailure = rawStatus === 'opened'
      && !coverLetterPending
      && !storedAutoRetryBlock
      && /^Отклик не начат:/iu.test(reason ?? '');
    const normalizedStatus: HhQueueStatus = staleManualSkillMismatch
      ? 'skipped'
      : needsScreeningInput
      ? 'needs_input'
      : onlyLegacyTransientQuestions
        ? 'opened'
        : coverLetterPending
          ? 'opened'
          : staleFalseNegativeState
            ? 'new'
            : legacyAlreadyApplied
              ? 'already_applied'
              : rawStatus === 'needs_input' && pendingQuestions.length === 0
                ? 'prepared'
                : rawStatus === 'skipped' && reason === 'Не удалось распознать состояние страницы HH.'
                  ? 'opened'
                  : QUEUE_STATUSES.has(rawStatus) ? rawStatus : 'new';
    // Terminal cleanup must follow recovery. A legacy `skipped` item can be
    // restored to `opened`; using its raw status here used to erase saved
    // employer questions and answers before the recovered retry could use them.
    const terminalStatus = normalizedStatus === 'sent'
      || normalizedStatus === 'already_applied'
      || normalizedStatus === 'skipped';
    const autoRetryBlockedUntil = terminalStatus || staleManualResumeGate
      ? undefined
      : onlyLegacyTransientQuestions
        ? 'daily' as const
        : legacyUngatedCoverLetterFailure
          ? 'manual' as const
          : storedAutoRetryBlock;
    result.push({
      key: jobKey(platform, id),
      id,
      platform,
      title,
      company: String(item.company ?? '').trim().slice(0, 300),
      salary: String(item.salary ?? '').trim().slice(0, 120),
      url,
      description: String(item.description ?? '').trim().slice(0, 12000),
      easyApply: Boolean(item.easyApply),
      status: normalizedStatus,
      reason: staleManualSkillMismatch
        ? `Пропущено автоматически: ${String(reason ?? '').replace(/^Отклик не начат:\s*/iu, '')}`
        : staleManualResumeGate
          ? 'Повторно проверю актуальные резюме HH и автоматически выберу подходящее для вакансии.'
          : stalePreSubmissionCoverLetterState
            ? 'Предыдущая попытка не подтвердила отправку отклика. Вакансия возвращена в очередь для проверки на странице HH.'
        : staleUnconfirmedRemoteState
          ? 'Удалённый формат не был опровергнут. Вакансия возвращена в очередь и будет проверена по фактическим условиям на странице HH.'
        : recentUnconfirmedLetter
          ? 'Отклик отправлен без подтверждённого письма. Добавлю и проверю сопроводительное письмо в чате HH.'
        : onlyLegacyTransientQuestions
          ? 'Временный сбой подготовки ответов работодателю. Повторю в следующем ежедневном или ручном запуске.'
          : needsScreeningInput
            ? pendingEmployerQuestionsReason(pendingQuestions.length)
            : reason,
      addedAt: Number.isNaN(Date.parse(addedAt)) ? nowIso() : addedAt,
      sentAt,
      pendingQuestions: !terminalStatus && pendingQuestions.length > 0 ? pendingQuestions : undefined,
      screeningAnswers: !terminalStatus && screeningAnswers.length > 0 ? screeningAnswers : undefined,
      preparationNotes: preparationNotes.length > 0 ? preparationNotes : undefined,
      coverLetterPending: staleFalseNegativeState ? undefined : coverLetterPending || undefined,
      coverLetterAdded: coverLetterAdded || undefined,
      selectedResumeTitle: typeof item.selectedResumeTitle === 'string'
        ? item.selectedResumeTitle.trim().slice(0, 240) || undefined
        : undefined,
      selectedResumeVerified: item.selectedResumeVerified === true || undefined,
      autoRetryBlockedUntil,
    });
    if (result.length >= 5_000) break;
  }
  const deduplicated = result.map((item) => {
    if (
      item.platform !== 'hh'
      || item.status === 'sent'
      || item.status === 'already_applied'
      || item.status === 'skipped'
    ) return item;
    const owner = findHhSemanticDuplicate(result, item, item.description ?? '');
    if (!owner) return item;
    return {
      ...item,
      status: 'skipped' as const,
      reason: `Точный дубль вакансии ${owner.company || owner.title} (${owner.id}); оставлен один отклик.`,
      pendingQuestions: undefined,
      screeningAnswers: undefined,
      coverLetterPending: false,
      autoRetryBlockedUntil: undefined,
    };
  });
  return deduplicated.map((item) => {
    if (
      item.platform !== 'hh'
      || item.status === 'sent'
      || item.status === 'already_applied'
      || item.status === 'skipped'
      || !item.selectedResumeTitle?.trim()
    ) return item;
    // Startup reconciliation is deliberately narrower than live relevance:
    // both stacks must be explicit in the selected résumé title and vacancy
    // title. Description mentions may name the product backend or a technology
    // that is explicitly *not* required, so they are not migration evidence.
    const compatibility = evaluateHhStackCompatibility({
      resumeContext: item.selectedResumeTitle,
      vacancyTitle: item.title,
      vacancyDescription: '',
    });
    if (
      compatibility.compatible
      || compatibility.candidateStacks.length === 0
      || compatibility.vacancyStacks.length === 0
    ) return item;
    return {
      ...item,
      status: 'skipped' as const,
      reason: `Убрано при восстановлении очереди: ${compatibility.reason ?? 'явный стек вакансии не совпадает с выбранным резюме.'}`,
      pendingQuestions: undefined,
      screeningAnswers: undefined,
      coverLetterPending: false,
      coverLetterAdded: false,
      autoRetryBlockedUntil: undefined,
    };
  });
}

function normalizeRunHistory(value: unknown): HhAutomationRun[] {
  if (!Array.isArray(value)) return [];
  const triggers = new Set<HhAutomationRunTrigger>(['manual', 'schedule', 'resume', 'direct_link']);
  const statuses = new Set<HhAutomationRunStatus>(['running', 'completed', 'attention', 'failed', 'stopped']);
  return value.flatMap((raw): HhAutomationRun[] => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const startedAt = String(item.startedAt ?? '');
    if (Number.isNaN(Date.parse(startedAt))) return [];
    const trigger = String(item.trigger ?? 'manual') as HhAutomationRunTrigger;
    const status = String(item.status ?? 'failed') as HhAutomationRunStatus;
    const wasRunning = status === 'running';
    const count = (key: string) => Math.max(0, Math.min(1_000, Math.round(Number(item[key]) || 0)));
    return [{
      id: String(item.id ?? `legacy-${startedAt}`).slice(0, 120),
      platform: normalizePlatform(item.platform),
      trigger: triggers.has(trigger) ? trigger : 'manual',
      status: statuses.has(status) && !wasRunning ? status : 'attention',
      startedAt,
      finishedAt: typeof item.finishedAt === 'string' && !Number.isNaN(Date.parse(item.finishedAt))
        ? item.finishedAt
        : startedAt,
      query: String(item.query ?? '').trim().slice(0, 200),
      vacancyUrl: normalizeHhVacancyUrl(String(item.vacancyUrl ?? '')) || undefined,
      found: count('found'),
      attempted: count('attempted'),
      sent: count('sent'),
      alreadyApplied: count('alreadyApplied'),
      skipped: count('skipped'),
      needsAttention: count('needsAttention'),
      message: wasRunning
        ? 'Приложение перезапустилось. Очередь сохранена и продолжится автоматически.'
        : String(item.message ?? '').trim().slice(0, 500),
    }];
  }).slice(0, 20);
}

export class HhBrowserAssistant {
  private browser: Browser | null = null;
  private browserProcess: ChildProcess | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private chatPage: Page | null = null;
  private browserMode: BrowserRunMode | null = null;
  private ensureBrowserPromise: Promise<Page> | null = null;
  private chatPagePromise: Promise<Page | null> | null = null;
  private readonly profileDir: string;
  private readonly statePath: string;
  private readonly emitState: EmitState;
  private state: HhAssistantState;
  private stopApplyRequested = false;
  private applyInFlight = false;
  private automationRunInFlight = false;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private scheduleRunning = false;
  private queueResumeTimer: NodeJS.Timeout | null = null;
  private queueResumeTimerReason = '';
  private queueResumeRunning = false;
  private lastScanFoundCount = 0;
  private applicantResumes: HhApplicantResume[] = [];
  private resumeSelectionConfirmed = false;
  private readonly resumeTextCache = new Map<string, { text: string; cachedAt: number }>();
  private readonly preparedCoverLetters = new Map<string, string>();
  private automationDiagnostics: HhAutomationDiagnosticEvent[] = [];
  private activeDailyLimit = 10;

  constructor(
    userDataDir: string,
    emitState: EmitState,
    private readonly generateScreeningAnswers?: GenerateHhScreeningAnswers,
    private readonly generateCoverLetter?: GenerateHhCoverLetter,
    private readonly getLicensePlan?: () => Promise<string | null>,
  ) {
    this.profileDir = path.join(userDataDir, 'job-browser-profile-v2');
    this.statePath = path.join(userDataDir, 'hh-browser-assistant.json');
    this.emitState = emitState;
    const persisted = safeJsonRead<PersistedState>(this.statePath);
    const persistedVersion = persisted?.version ?? 0;
    this.automationDiagnostics = normalizeHhAutomationDiagnostics(persisted?.automationDiagnostics);
    const persistedConfig = persisted?.config ?? DEFAULT_HH_ASSISTANT_CONFIG;
    const migratedConfig = persistedVersion >= 3
      ? persistedConfig
      : {
          ...persistedConfig,
          area: persistedConfig.area === '113' ? '' : persistedConfig.area,
          employment: persistedConfig.employment === 'full' ? '' : persistedConfig.employment,
          schedule: persistedConfig.schedule || 'remote',
          maxQueueSize: Math.max(5000, persistedConfig.maxQueueSize || 0),
          maxPages: Math.max(20, persistedConfig.maxPages || 0),
          dailyLimit: Math.min(20, persistedConfig.dailyLimit || 20),
          autoRunDaily: false,
          autoSend: true,
        };
    // v4 changes the default run mode to automatic. Apply it once to existing
    // installations; a later explicit switch back to review-only is retained.
    const v4Config = persistedVersion >= 4
      ? migratedConfig
      : { ...migratedConfig, autoSend: true };
    // v0.0.33 could silently replace a configured 220k résumé with a fuzzy
    // 240k card. Force one explicit account-résumé confirmation on upgrade;
    // inferred per-vacancy titles remain untrusted until HH visibly selects one.
    const expandedDiscoveryConfig = v4Config.maxQueueSize <= 500
      ? { ...v4Config, maxQueueSize: 5000 }
      : v4Config;
    const config = persistedVersion >= 8
      ? expandedDiscoveryConfig
      : { ...expandedDiscoveryConfig, resumeTitles: [], resumeTitleContains: '' };
    this.resumeSelectionConfirmed = persistedVersion >= 8
      && persisted?.resumeSelectionConfirmed === true;
    const normalizedQueue = normalizePersistedQueue(persisted?.queue);
    this.state = {
      phase: 'idle',
      browserOpen: false,
      loginRequired: false,
      message: '',
      currentVacancyId: null,
      applying: false,
      stopRequested: false,
      queuePaused: persisted?.queuePaused === true,
      applyProgress: null,
      config: normalizeHhAssistantConfig(config),
      queue: persistedVersion >= 8
        ? normalizedQueue
        : normalizedQueue.map((item) => {
            const screeningAnswers = item.screeningAnswers?.filter((answer) => (
              !isSalaryRelatedQuestion(answer.question)
              && !isCurrentLocationQuestion(answer.question)
            ));
            return {
              ...item,
              selectedResumeTitle: undefined,
              selectedResumeVerified: undefined,
              screeningAnswers: screeningAnswers?.length ? screeningAnswers : undefined,
            };
          }),
      screeningFacts: normalizeScreeningFacts(persisted?.screeningFacts),
      runHistory: normalizeRunHistory(persisted?.runHistory),
      lastScanSummary: null,
      nextRunAt: null,
      nextQueueResumeAt: null,
      updatedAt: nowIso(),
    };
    const reconciledQuestions = this.reconcileKnownPendingScreeningQuestions();
    if (persistedVersion < 8 || reconciledQuestions > 0) this.persist();
  }

  /**
   * Re-checks persisted manual questions against explicit search preferences and
   * remembered facts. This prevents old queues from asking the same preference
   * again after the application is updated or restarted.
   */
  private reconcileKnownPendingScreeningQuestions(): number {
    const facts = new Map(
      this.state.screeningFacts.map((fact) => [screeningQuestionSemanticKey(fact.question), fact]),
    );
    let changedCount = 0;
    this.state.queue = this.state.queue.map((item) => {
      if (item.platform !== 'hh') return item;
      const resumeTitleSources = resumeTitleFactSources(
        item.selectedResumeTitle,
        this.state.config.resumeTitles,
      );
      const resumeTitleContext = resumeTitleSources.join('\n').trim();
      const salaryExpectation = findSalaryExpectation(
        null,
        resumeTitleSources,
      );

      const screeningAnswers = item.screeningAnswers;

      if (item.status !== 'needs_input' || !item.pendingQuestions?.length) {
        return screeningAnswers === item.screeningAnswers ? item : { ...item, screeningAnswers };
      }
      const resolved: HhStoredScreeningAnswer[] = [];
      const pendingQuestions = item.pendingQuestions.filter((question) => {
        const exactVacancyAnswer = findExactVacancyScreeningAnswer(question, screeningAnswers);
        const exactMapped = exactVacancyAnswer
          ? reusableScreeningAnswer(question, exactVacancyAnswer)
          : null;
        if (exactMapped?.canAutoFill) {
          resolved.push({
            questionId: question.id,
            question: question.prompt,
            answer: exactMapped.answer,
            selectedOptions: exactMapped.selectedOptions,
            confirmedByUser: true,
          });
          changedCount += 1;
          return false;
        }
        const fact = facts.get(screeningQuestionSemanticKey(question.prompt))
          ?? findReusableScreeningFact(question, facts.values());
        // Startup reconciliation is synchronous and has not loaded the selected
        // résumé body yet. A remembered city may be stale, so keep the current-
        // location question pending until the live fill/suggestion path can
        // compare it with the actually selected résumé.
        if (isCurrentLocationQuestion(question.prompt)) return true;
        // `salaryFrom` is a search floor, not a confirmed questionnaire answer.
        // Before a live form has visibly confirmed the exact résumé, keep the
        // salary pending instead of trusting a legacy/inferred title.
        if (isSalaryRelatedQuestion(question.prompt) && item.selectedResumeVerified !== true) return true;
        const known = knownScreeningAnswer(question, salaryExpectation, resumeTitleContext);
        const salaryQuestion = isSalaryRelatedQuestion(question.prompt);
        const answer = salaryQuestion
          ? known
          : (fact ? reusableScreeningAnswer(question, fact) : null) ?? known;
        if (!answer?.canAutoFill) return true;
        resolved.push({
          questionId: question.id,
          question: question.prompt,
          answer: answer.answer,
          selectedOptions: answer.selectedOptions,
        });
        changedCount += 1;
        return false;
      });
      if (resolved.length === 0) {
        return screeningAnswers === item.screeningAnswers ? item : { ...item, screeningAnswers };
      }
      const answers = new Map(
        (screeningAnswers ?? []).map((answer) => [screeningQuestionSemanticKey(answer.question), answer]),
      );
      for (const answer of resolved) answers.set(screeningQuestionSemanticKey(answer.question), answer);
      return {
        ...item,
        status: pendingQuestions.length === 0 ? 'prepared' as const : 'needs_input' as const,
        reason: pendingQuestions.length === 0
          ? 'Известные условия применены автоматически. Вакансия вернулась в очередь.'
          : `Известные условия применены. Осталось уточнить: ${pendingQuestions.length}.`,
        pendingQuestions: pendingQuestions.length > 0 ? pendingQuestions : undefined,
        screeningAnswers: [...answers.values()].slice(-60),
        autoRetryBlockedUntil: pendingQuestions.length === 0
          ? undefined
          : item.autoRetryBlockedUntil,
      };
    });
    return changedCount;
  }

  getState(): HhAssistantState {
    return structuredClone(this.state);
  }

  /** Отдать текущую страницу браузера (для Chat Browser). */
  async getPage(): Promise<Page | null> {
    try {
      return await this.ensureBrowser('background');
    } catch {
      return null;
    }
  }

  /**
   * Chat polling must never navigate the search/application tab. Keeping a
   * dedicated page also makes background HR checks independent of an open
   * response modal.
   */
  async getChatPage(options: { explicit?: boolean } = {}): Promise<Page | null> {
    // A scheduled poll must stay invisible while the user is working in the
    // interactive HH window. Chromium cannot hide an individual tab, so defer
    // the poll instead of creating a visible /negotiations tab next to the
    // vacancy the user opened. Explicit actions (notification/chat button) may
    // still open it.
    if (this.browserMode === 'interactive' && !options.explicit) return null;
    if (this.chatPage && !this.chatPage.isClosed()) {
      await this.closeExcessAutomationPages(new Set([this.page, this.chatPage].filter(Boolean) as Page[]));
      return this.chatPage;
    }
    if (this.chatPagePromise) return this.chatPagePromise;
    const task = (async (): Promise<Page | null> => {
      try {
        await this.ensureBrowser('background');
        if (!this.context) return null;
        if (this.chatPage && !this.chatPage.isClosed()) return this.chatPage;
        const chatPage = await this.context.newPage();
        this.chatPage = chatPage;
        chatPage.on('framenavigated', (frame) => {
          if (frame === chatPage.mainFrame()) void this.restoreInteractivePage();
        });
        chatPage.once('close', () => {
          if (this.chatPage === chatPage) this.chatPage = null;
        });
        await this.closeExcessAutomationPages(new Set([this.page, chatPage].filter(Boolean) as Page[]));
        await this.restoreInteractivePage();
        return chatPage;
      } catch {
        return null;
      }
    })();
    this.chatPagePromise = task;
    try {
      return await task;
    } finally {
      if (this.chatPagePromise === task) this.chatPagePromise = null;
    }
  }

  /** Return focus after a background HH chat check without opening negotiations to the user. */
  async restoreInteractivePage(): Promise<void> {
    const page = this.page;
    if (this.browserMode !== 'interactive' || !page || page.isClosed() || page === this.chatPage) return;
    await page.bringToFront().catch(() => undefined);
  }

  /** Explicit user action: show the already authenticated HH conversation page. */
  async showChatPage(): Promise<void> {
    const page = await this.getChatPage({ explicit: true });
    if (!page || page.isClosed()) return;
    await page.bringToFront();
  }

  /** Инжектит stealth-скрипт во все страницы контекста, чтобы скрыть автоматизацию. */
  private async injectStealthScript(context: BrowserContext): Promise<void> {
    try {
      await context.addInitScript(() => {
        // Скрываем navigator.webdriver
        Object.defineProperty(navigator, 'webdriver', { get: () => false });

        // Подделываем chrome.runtime
        // @ts-expect-error chrome runtime
        window.chrome = {
          runtime: {},
          loadTimes: () => {},
          csi: () => {},
          app: {},
        };

        // Подделываем permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = ((parameters: PermissionDescriptor) =>
          parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
            : originalQuery(parameters)) as typeof originalQuery;

        // Подделываем plugins
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5],
        });

        // Подделываем languages
        Object.defineProperty(navigator, 'languages', {
          get: () => ['ru-RU', 'ru', 'en-US', 'en'],
        });

        // Убираем Playwright-специфичные следы
        const win = window as unknown as Record<string, unknown>;
        delete win.__playwright;
        delete win.__pw_manual;
        delete win.__PW_inspect;
      });
    } catch {
      // Best-effort: если контекст уже используется, скрипт не инжектится
    }
  }

  /** Пересчитывает таймер при изменении конфига (час запуска мог смениться). */
  saveConfig(value: HhAssistantConfigUpdate): HhAssistantState {
    const { resumeSelectionExplicitlyConfirmed, ...configValue } = value;
    if (resumeSelectionExplicitlyConfirmed === true) {
      this.resumeSelectionConfirmed = Array.isArray(configValue.resumeTitles)
        && configValue.resumeTitles.some((title) => String(title).trim());
    } else if (
      resumeSelectionExplicitlyConfirmed === false
      && Array.isArray(configValue.resumeTitles)
      && configValue.resumeTitles.length === 0
    ) {
      this.resumeSelectionConfirmed = false;
    }
    this.state.config = normalizeHhAssistantConfig({
      ...this.state.config,
      ...configValue,
    });
    this.recordAutomationDiagnostic('config_saved', 'configuration', 'settings_saved');
    this.reconcileKnownPendingScreeningQuestions();
    if (this.state.config.autoRunDaily) {
      this.startDailySchedule();
    } else {
      this.stopDailySchedule();
    }
    if (this.state.config.autoSend) {
      this.scheduleQueueResume(2_000);
    } else {
      this.clearQueueResumeTimer();
    }
    this.update({ message: 'Настройки сохранены.' });
    return this.getState();
  }

  /** Поднимает таймер ежедневного авто-прогона после старта приложения. */
  restoreSchedule(): void {
    this.recordAutomationDiagnostic('app_restored', 'application', 'application_startup');
    if (this.state.config.autoRunDaily) {
      this.startDailySchedule();
    }
    this.scheduleQueueResume(10_000, 'startup_restore');
  }

  /** Переключает ежедневный авто-прогон из UI. */
  setDailySchedule(enabled: boolean): HhAssistantState {
    this.state.config = normalizeHhAssistantConfig({
      ...this.state.config,
      autoRunDaily: enabled,
    });
    this.recordAutomationDiagnostic('config_saved', 'configuration', enabled ? 'daily_enabled' : 'daily_disabled');
    if (enabled) {
      this.startDailySchedule();
    } else {
      this.stopDailySchedule();
    }
    this.scheduleQueueResume(2_000, 'daily_setting_changed');
    this.update({
      message: enabled
        ? `Ежедневный авто-прогон включён, старт в ${this.state.config.autoRunHour}:00.`
        : 'Ежедневный авто-прогон остановлен.',
    });
    return this.getState();
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(
        this.statePath,
        JSON.stringify(
          {
            version: 8,
            config: this.state.config,
            queue: this.state.queue,
            screeningFacts: this.state.screeningFacts,
            runHistory: this.state.runHistory,
            automationDiagnostics: this.automationDiagnostics,
            queuePaused: this.state.queuePaused,
            resumeSelectionConfirmed: this.resumeSelectionConfirmed,
          } satisfies PersistedState,
          null,
          2,
        ),
        'utf8',
      );
    } catch (error) {
      console.warn('[hh-assistant] state persistence failed:', error);
    }
  }

  private diagnosticQueueCounts(): HhAutomationQueueCounts {
    const hhQueue = this.state.queue.filter((item) => item.platform === 'hh');
    return {
      total: hhQueue.length,
      actionable: hhQueue.filter(isActionableQueueItem).length,
      eligible: hhQueue.filter((item) => isQueueItemEligibleForRun(item, 'queue')).length,
      dailyBlocked: hhQueue.filter((item) => item.autoRetryBlockedUntil === 'daily').length,
      manualBlocked: hhQueue.filter((item) => item.autoRetryBlockedUntil === 'manual').length,
      sentToday: countTodaySent(hhQueue),
    };
  }

  private recordAutomationDiagnostic(
    kind: HhAutomationDiagnosticKind,
    source: HhAutomationDiagnosticSource,
    reason: string,
    details: Partial<Pick<
      HhAutomationDiagnosticEvent,
      'scheduledFor' | 'delayMs' | 'runId' | 'result' | 'vacancy'
    >> = {},
  ): void {
    const now = new Date();
    const scheduled = details.scheduledFor ? new Date(details.scheduledFor) : null;
    const event: HhAutomationDiagnosticEvent = {
      id: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      at: now.toISOString(),
      localAt: localDiagnosticTime(now),
      timezone: diagnosticTimezone(),
      utcOffsetMinutes: -now.getTimezoneOffset(),
      kind,
      source,
      reason: reason.slice(0, 240),
      scheduledFor: details.scheduledFor,
      localScheduledFor: scheduled && !Number.isNaN(scheduled.getTime())
        ? localDiagnosticTime(scheduled)
        : undefined,
      delayMs: details.delayMs,
      runId: details.runId,
      autoRunDaily: this.state.config.autoRunDaily,
      autoRunHour: this.state.config.autoRunHour,
      autoSend: this.state.config.autoSend,
      queuePaused: this.state.queuePaused,
      queue: this.diagnosticQueueCounts(),
      result: details.result,
      vacancy: details.vacancy,
    };
    this.automationDiagnostics = [...this.automationDiagnostics, event].slice(-500);
    this.persist();
  }

  getDiagnosticsSnapshot(): HhAutomationDiagnosticSnapshot {
    return {
      schemaVersion: 1,
      exportedAt: nowIso(),
      timezone: diagnosticTimezone(),
      explanation: 'Ежедневный поиск и продолжение сохранённой очереди — независимые таймеры. autoRunHour управляет только ежедневным поиском.',
      config: {
        autoRunDaily: this.state.config.autoRunDaily,
        autoRunHour: this.state.config.autoRunHour,
        autoSend: this.state.config.autoSend,
        dailyLimit: this.state.config.dailyLimit,
      },
      queue: this.diagnosticQueueCounts(),
      findings: analyzeHhAutomationDiagnostics(this.automationDiagnostics),
      events: [...this.automationDiagnostics],
    };
  }

  private update(patch: Partial<HhAssistantState>): void {
    this.state = { ...this.state, ...patch, updatedAt: nowIso() };
    this.persist();
    this.emitState(this.getState());
  }

  private beginRun(trigger: HhAutomationRunTrigger, vacancyUrl?: string): HhAutomationRun {
    this.stopApplyRequested = false;
    const startedAt = nowIso();
    const run: HhAutomationRun = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      platform: this.state.config.platform,
      trigger,
      status: 'running',
      startedAt,
      query: this.state.config.query,
      vacancyUrl,
      found: 0,
      attempted: 0,
      sent: 0,
      alreadyApplied: 0,
      skipped: 0,
      needsAttention: 0,
      message: trigger === 'schedule'
        ? 'Запущено по ежедневному расписанию.'
        : trigger === 'resume'
          ? 'Продолжаю сохранённую очередь после паузы.'
        : trigger === 'direct_link'
          ? 'Проверяю конкретную вакансию по ссылке.'
          : 'Запущено вручную.',
    };
    this.update({
      stopRequested: false,
      queuePaused: false,
      runHistory: [run, ...this.state.runHistory].slice(0, 20),
    });
    this.recordAutomationDiagnostic(
      'run_started',
      trigger === 'schedule'
        ? 'daily_search'
        : trigger === 'resume'
          ? 'queue_resume'
          : trigger === 'direct_link' ? 'direct_link' : 'manual',
      trigger,
      { runId: run.id },
    );
    return run;
  }

  private finishRun(
    runId: string,
    patch: Partial<Omit<HhAutomationRun, 'id' | 'trigger' | 'startedAt'>>,
  ): void {
    this.update({
      runHistory: this.state.runHistory.map((run) => run.id === runId
        ? { ...run, ...patch, finishedAt: nowIso() }
        : run),
    });
    const run = this.state.runHistory.find((item) => item.id === runId);
    if (run) {
      this.recordAutomationDiagnostic(
        'run_finished',
        run.trigger === 'schedule'
          ? 'daily_search'
          : run.trigger === 'resume'
            ? 'queue_resume'
            : run.trigger === 'direct_link' ? 'direct_link' : 'manual',
        run.message || run.status,
        {
          runId,
          result: {
            status: run.status,
            attempted: run.attempted,
            sent: run.sent,
            needsAttention: run.needsAttention,
          },
        },
      );
    }
  }

  private progressRun(
    runId: string | undefined,
    patch: Partial<Pick<HhAutomationRun, 'found' | 'attempted' | 'sent' | 'alreadyApplied' | 'skipped' | 'needsAttention' | 'message'>>,
  ): void {
    if (!runId) return;
    this.update({
      runHistory: this.state.runHistory.map((run) => run.id === runId && run.status === 'running'
        ? { ...run, ...patch }
        : run),
    });
  }

  private async hasHhAuthCookie(): Promise<boolean> {
    if (!this.context) return false;
    const cookies = await this.context.cookies().catch(() => []);
    return cookies.some(
      (cookie) => cookie.name === HH_AUTH_COOKIE_NAME && Boolean(cookie.value),
    );
  }

  private async enrichApplicantResumeTitles(
    resumes: HhApplicantResume[],
  ): Promise<HhApplicantResume[]> {
    if (!this.context) return resumes.filter((resume) => resume.title);
    const request = this.context.request;
    const enriched = [...resumes];
    const missing = enriched
      .map((resume, index) => ({ resume, index }))
      .filter(({ resume }) => resumeTitleScore(resume.title) === 0)
      .slice(0, 20);

    for (let offset = 0; offset < missing.length; offset += 4) {
      const batch = missing.slice(offset, offset + 4);
      const titles = await Promise.all(batch.map(async ({ resume }) => {
        try {
          const response = await request.get(resume.url, {
            failOnStatusCode: false,
            timeout: 12_000,
            headers: { accept: 'text/html,application/xhtml+xml' },
          });
          if (!response.ok() || !isHhPage(response.url())) return '';
          return extractHhResumeTitleFromHtml(await response.text());
        } catch {
          return '';
        }
      }));
      batch.forEach(({ index }, batchIndex) => {
        if (titles[batchIndex]) enriched[index] = { ...enriched[index], title: titles[batchIndex] };
      });
    }

    return enriched.filter((resume) => resumeTitleScore(resume.title) > 0);
  }

  private syncCurrentApplicantResume(resumes: HhApplicantResume[]): void {
    const hadConfiguredTitle = this.state.config.resumeTitles.some((title) => title.trim());
    const configured = this.state.config.resumeTitles
      .map((title) => findExplicitlySelectedHhResume(resumes, title))
      .find((resume): resume is HhApplicantResume => Boolean(resume));
    // A title synchronized from HH becomes provenance for salary, city and
    // experience. Never replace an existing choice with a fuzzy-looking card.
    // With no configured choice, only a single account résumé is unambiguous.
    const currentTitle = configured?.title
      ?? (!hadConfiguredTitle && resumes.length === 1
        ? resumes[0]?.title
        : undefined);
    if (!currentTitle) {
      // A previously confirmed title may disappear or be renamed in HH. With
      // multiple remaining resumes there is no safe replacement, so require a
      // fresh explicit selection instead of silently ranking another card.
      if (hadConfiguredTitle || this.resumeSelectionConfirmed) {
        this.resumeSelectionConfirmed = false;
        this.state.config = normalizeHhAssistantConfig({
          ...this.state.config,
          resumeTitles: [],
          resumeTitleContains: '',
        });
      }
      return;
    }
    if (resumes.length === 1) this.resumeSelectionConfirmed = true;
    const resumeTitles = currentTitle ? [currentTitle] : [];
    if (
      this.state.config.resumeTitles.length === resumeTitles.length &&
      this.state.config.resumeTitles.every((title, index) => title === resumeTitles[index])
    ) return;
    this.state.config = normalizeHhAssistantConfig({
      ...this.state.config,
      resumeTitles,
      resumeTitleContains: '',
    });
  }

  private async readApplicantResumesFromSession(): Promise<{
    resumes: HhApplicantResume[];
    loginRequired: boolean;
  }> {
    if (!this.context) return { resumes: [], loginRequired: false };
    const response = await this.context.request.get(HH_APPLICANT_RESUMES_URL, {
      failOnStatusCode: false,
      timeout: 20_000,
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    const finalUrl = response.url();
    const html = await response.text();
    const loginRequired = finalUrl.includes('/account/login') || (
      /data-qa=["'][^"']*(?:applicant-login|account-login)[^"']*["']/i.test(html) &&
      !(await this.hasHhAuthCookie())
    );
    if (loginRequired) return { resumes: [], loginRequired: true };
    if (!response.ok()) throw new Error(`HH вернул код ${response.status()} при загрузке резюме.`);
    return {
      resumes: await this.enrichApplicantResumeTitles(extractHhResumesFromHtml(html)),
      loginRequired: false,
    };
  }

  private async readApplicantResumesFromPage(page: Page): Promise<{
    resumes: HhApplicantResume[];
    loginRequired: boolean;
    confirmedEmpty: boolean;
  }> {
    await page.goto(HH_APPLICANT_RESUMES_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    });
    if (await this.isLoginRequired(page)) {
      return { resumes: [], loginRequired: true, confirmedEmpty: false };
    }
    if (page.url().includes('/404')) throw new Error('HH открыл страницу 404 вместо списка резюме.');

    await page
      .locator('a[href*="/resume/"], [data-qa*="resume"]')
      .first()
      .waitFor({ state: 'attached', timeout: 6_000 })
      .catch(() => undefined);
    const candidates = await page.locator('a[href*="/resume/"]').evaluateAll((elements) =>
      elements.slice(0, 100).map((element) => {
        const anchor = element as HTMLAnchorElement;
        const container = anchor.closest(
          '[data-qa*="resume"], article, li, [class*="resume"]',
        );
        const heading = container?.querySelector(
          '[data-qa*="title"], [data-qa*="position"], h1, h2, h3',
        );
        return {
          href: anchor.href || anchor.getAttribute('href') || '',
          text: anchor.textContent || '',
          ariaLabel: anchor.getAttribute('aria-label') || '',
          title: anchor.getAttribute('title') || '',
          heading: heading?.textContent || '',
        };
      }),
    );
    const resumesById = new Map<string, HhApplicantResume>();
    const scoresById = new Map<string, number>();
    for (const candidate of candidates) {
      const normalized = normalizeHhResumeLink(candidate.href);
      if (!normalized) continue;
      const titles = [candidate.text, candidate.heading, candidate.ariaLabel, candidate.title]
        .map(cleanHhResumeTitle)
        .sort((left, right) => resumeTitleScore(right) - resumeTitleScore(left));
      const title = titles[0] ?? '';
      const score = resumeTitleScore(title);
      if (!resumesById.has(normalized.id) || score > (scoresById.get(normalized.id) ?? 0)) {
        resumesById.set(normalized.id, { ...normalized, title });
        scoresById.set(normalized.id, score);
      }
    }

    if (resumesById.size === 0) {
      const pageHtml = await page.content();
      for (const resume of extractHhResumesFromHtml(pageHtml)) resumesById.set(resume.id, resume);
    }
    const resumes = await this.enrichApplicantResumeTitles([...resumesById.values()]);
    if (resumes.length > 0) return { resumes, loginRequired: false, confirmedEmpty: false };

    const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    const confirmedEmpty = /(?:у вас|пока)\s+нет[^.]{0,80}резюм|созда(?:йте|ть)[^.]{0,80}резюм|резюме\s+не\s+найден/i.test(body);
    return { resumes: [], loginRequired: false, confirmedEmpty };
  }

  private async resetBrowserConnection(): Promise<void> {
    const context = this.context;
    const browser = this.browser;
    const browserProcess = this.browserProcess;
    this.browser = null;
    this.browserProcess = null;
    this.context = null;
    this.page = null;
    this.chatPage = null;
    this.browserMode = null;
    this.chatPagePromise = null;
    fs.rmSync(path.join(this.profileDir, 'SkillCueDebugPort'), { force: true });
    // Give Chrome a chance to flush session cookies before using taskkill as a
    // fallback. Killing first made a successful HH login disappear on restart.
    if (browser) await settleWithin(browser.close(), 4_000);
    if (context) await settleWithin(context.close(), 1_000);
    await terminateBrowserProcessTree(browserProcess);
    await terminateOrphanedProfileBrowsers(this.profileDir);
  }

  private async launchInstalledBrowser(mode: BrowserRunMode): Promise<BrowserContext> {
    fs.mkdirSync(this.profileDir, { recursive: true });
    const errors: string[] = [];
    // Prefer the live process command line over the persisted port file. Older
    // builds could leave a stale SkillCueDebugPort behind; trying to launch a
    // second Chrome with the same user-data-dir then exits with code 21.
    const runningBrowser = await runningProfileDebugInfo(this.profileDir);
    const persistedBrowser = profileDebugInfo(this.profileDir);
    const activeBrowsers = [runningBrowser, persistedBrowser]
      .filter((entry): entry is ProfileDebugInfo => Boolean(entry))
      .filter((entry, index, all) => all.findIndex((candidate) => candidate.port === entry.port) === index);
    for (const activeBrowser of activeBrowsers) {
      try {
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${activeBrowser.port}`, { timeout: 2500 });
        const context = browser.contexts()[0];
        if (!context) throw new Error('браузер не вернул основной профиль');
        const activeMode = activeBrowser.mode ?? 'interactive';
        if (activeMode !== mode) {
          await settleWithin(browser.close(), 4_000);
          fs.rmSync(path.join(this.profileDir, 'SkillCueDebugPort'), { force: true });
          throw new Error(`перезапуск из режима ${activeMode} в ${mode}`);
        }
        await this.injectStealthScript(context);
        this.browser = browser;
        this.browserMode = mode;
        fs.writeFileSync(
          path.join(this.profileDir, 'SkillCueDebugPort'),
          `${activeBrowser.port}\n${mode}`,
          'utf8',
        );
        return context;
      } catch (error) {
        errors.push(`existing browser: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Old releases did not always persist the CDP port and could leave a
    // start-maximized browser behind. Remove that exact-profile orphan before
    // launching; otherwise Chromium forwards this launch into the old window.
    await terminateOrphanedProfileBrowsers(this.profileDir);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const debugPortPath = path.join(this.profileDir, 'DevToolsActivePort');
    const skillCuePortPath = path.join(this.profileDir, 'SkillCueDebugPort');
    const candidates = installedBrowserCandidates();
    if (candidates.length === 0) throw new Error(browserLaunchFailureMessage(0, []));
    for (const candidate of candidates) {
      let child: ChildProcess | null = null;
      try {
        fs.rmSync(debugPortPath, { force: true });
        fs.rmSync(skillCuePortPath, { force: true });
        const debugPort = await allocateDebugPort();
        child = spawn(
          candidate.executable,
          browserLaunchArguments(this.profileDir, debugPort, mode),
          { detached: false, stdio: 'ignore', windowsHide: true },
        );
        child.unref();
        const deadline = Date.now() + 20_000;
        let browser: Browser | null = null;
        while (Date.now() < deadline) {
          if (child.exitCode !== null) throw new Error(`процесс завершился с кодом ${child.exitCode}`);
          try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 1200 }); break; } catch { /* endpoint is still starting */ }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!browser) throw new Error('не удалось подключиться к локальному DevTools');
        const context = browser.contexts()[0];
        if (!context) throw new Error('браузер не вернул основной профиль');
        await this.injectStealthScript(context);
        this.browser = browser;
        this.browserProcess = child;
        this.browserMode = mode;
        fs.writeFileSync(skillCuePortPath, `${debugPort}\n${mode}`, 'utf8');
        return context;
      } catch (error) {
        await terminateBrowserProcessTree(child);
        await terminateOrphanedProfileBrowsers(this.profileDir);
        errors.push(`${candidate.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(browserLaunchFailureMessage(candidates.length, errors));
  }

  /**
   * The profile belongs exclusively to SkillCue. Chrome may restore targets
   * from a previous forced shutdown, so keeping only the pages owned by the
   * current run prevents both stale HH tabs and accumulated about:blank tabs.
   */
  private async closeExcessAutomationPages(keep: Set<Page>): Promise<void> {
    if (!this.context) return;
    for (const candidate of this.context.pages()) {
      if (keep.has(candidate) || candidate.isClosed()) continue;
      await settleWithin(candidate.close(), 1_500);
    }
  }

  private browserModeSatisfies(requestedMode: BrowserRunMode): boolean {
    return this.browserMode === requestedMode || (
      requestedMode === 'background' && this.browserMode === 'interactive'
    );
  }

  private async ensureBrowser(mode: BrowserRunMode = 'background'): Promise<Page> {
    if (this.context && this.browserModeSatisfies(mode) && this.page && !this.page.isClosed()) {
      await this.closeExcessAutomationPages(new Set([this.page, ...(this.chatPage && !this.chatPage.isClosed() ? [this.chatPage] : [])]));
      return this.page;
    }
    if (this.ensureBrowserPromise) {
      const pendingPage = await this.ensureBrowserPromise;
      if (this.browserModeSatisfies(mode) && !pendingPage.isClosed()) {
        await this.closeExcessAutomationPages(new Set([pendingPage, ...(this.chatPage && !this.chatPage.isClosed() ? [this.chatPage] : [])]));
        return pendingPage;
      }
    }
    const pending = this.ensureBrowserUnlocked(mode);
    this.ensureBrowserPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.ensureBrowserPromise === pending) this.ensureBrowserPromise = null;
    }
  }

  private async ensureBrowserUnlocked(mode: BrowserRunMode): Promise<Page> {
    if (this.context && !this.browserModeSatisfies(mode)) await this.resetBrowserConnection();
    if (this.context && this.page && !this.page.isClosed()) return this.page;
    if (this.context) {
      const existingContext = this.context;
      try {
        // Restored Chrome tabs can look healthy in /json yet never answer CDP
        // commands. A fresh target is cheap and avoids inheriting that renderer.
        this.page = await existingContext.newPage();
        await this.closeExcessAutomationPages(new Set([this.page, ...(this.chatPage && !this.chatPage.isClosed() ? [this.chatPage] : [])]));
        return this.page;
      } catch {
        if (this.context === existingContext) this.context = null;
        this.page = null;
      }
    }
    const context = await this.launchInstalledBrowser(mode);
    this.context = context;
    const browser = this.browser;
    const handleBrowserClosed = () => {
      if (this.context !== context) return;
      fs.rmSync(path.join(this.profileDir, 'SkillCueDebugPort'), { force: true });
      this.browser = null;
      this.browserProcess = null;
      this.context = null;
      this.page = null;
      this.chatPage = null;
      this.browserMode = null;
      this.ensureBrowserPromise = null;
      this.chatPagePromise = null;
      this.update({
        phase: 'idle',
        browserOpen: false,
        currentVacancyId: null,
        message: 'Окно поиска вакансий закрыто.',
      });
    };
    context.once('close', handleBrowserClosed);
    browser?.once('disconnected', handleBrowserClosed);
    // Do not reuse Chrome's session-restored tab here. In practice HH can
    // restore it in a renderer that is visible but unresponsive to automation.
    this.page = await context.newPage();
    await this.closeExcessAutomationPages(new Set([this.page]));
    await this.injectStealthScript(context);
    this.update({ browserOpen: true, phase: 'browser_open' });
    return this.page;
  }

  private async openFreshHhLoginPage(): Promise<Page> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.ensureBrowser('background');
      const context = this.context;
      if (!context) throw new Error('Не удалось получить контекст браузера HH.');
      let loginPage: Page | null = null;
      try {
        // A restored HH renderer can remain alive on /negotiations while every
        // Playwright navigation against that tab times out. A new CDP target is
        // independent of that renderer and is the reliable login boundary.
        loginPage = await context.newPage();
        await navigateToHhLogin(loginPage);
        const openedLogin = loginPage.url().includes('/account/login');
        if (!openedLogin && !(await this.hasHhAuthCookie())) {
          throw new Error('HH не открыл страницу входа. Повторите попытку.');
        }
        this.page = loginPage;
        await this.closeExcessAutomationPages(new Set([loginPage]));
        return loginPage;
      } catch (error) {
        lastError = error;
        if (loginPage && !loginPage.isClosed()) {
          await settleWithin(loginPage.close(), 1_000);
        }
        if (attempt === 0) {
          await this.resetBrowserConnection();
          continue;
        }
      }
    }
    throw lastError;
  }

  async openBrowser(platformValue?: JobPlatform): Promise<HhAssistantState> {
    const platform = normalizePlatform(platformValue ?? this.state.config.platform);
    const info = PLATFORM_INFO[platform];
    try {
      const page = await this.ensureBrowser('interactive');
      if (!isPlatformPage(platform, page.url())) {
        await page.goto(info.homeUrl, { waitUntil: 'domcontentloaded' });
      }
      await page.bringToFront();
      const loginRequired = await this.isLoginRequired(page, platform);
      this.state.config = normalizeHhAssistantConfig({ ...this.state.config, platform });
      this.update({
        phase: 'browser_open',
        browserOpen: true,
        loginRequired,
        message: loginRequired
          ? `Войдите в ${info.label} в открытом окне. SkillCue сохранит сессию локально.`
          : `${info.label} открыт и готов к работе.`,
      });
    } catch (error) {
      this.fail(error);
    }
    return this.getState();
  }

  /**
   * Вход в HH по телефону/почте + пароль (без ручного ввода в браузере).
   * Поддерживает:
   * - Почта + пароль
   * - Телефон + пароль (если пароль установлен)
   * Возвращает true если вход успешен.
   */
  async loginWithCredentials(
    login: string,
    password: string,
  ): Promise<{ ok: boolean; message: string }> {
    try {
      const page = await this.ensureBrowser('background');

      // Переходим на страницу входа
      await page.goto('https://hh.ru/account/login?backurl=%2Fapplicant%2Fresumes&role=applicant', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });

      // Ждём загрузки формы
      await page.waitForTimeout(1500);

      // Находим поле ввода и кнопку
      // HH использует два шага: сначала логин, потом пароль

      // Шаг 1: Вводим логин (телефон или почту)
      const loginInput = page.locator([
        'input[data-qa="account-login-input"]',
        'input[name="login"]',
        'input[name="username"]',
        'input[type="text"]',
        'input[type="email"]',
        'input[placeholder*="почт" i]',
        'input[placeholder*="телефон" i]',
        'input[placeholder*="email" i]',
        'input[placeholder*="логин" i]',
      ].join(', ')).first();

      await loginInput.waitFor({ timeout: 10_000 }).catch(() => undefined);
      await loginInput.click().catch(() => undefined);
      await loginInput.fill('').catch(() => undefined);
      await loginInput.type(login, { delay: 30 }).catch(() => {
        void loginInput.fill(login);
      });

      await page.waitForTimeout(500);

      // Нажимаем «Продолжить» или «Войти» (первая кнопка)
      const submitBtn = page.locator([
        'button[data-qa="account-login-submit"]',
        'button[type="submit"]',
        'button:has-text("Продолжить")',
        'button:has-text("Войти")',
        'button:has-text("Далее")',
      ].join(', ')).first();

      const submitCount = await submitBtn.count();
      if (submitCount > 0) {
        await submitBtn.click().catch(() => undefined);
      } else {
        await page.keyboard.press('Enter');
      }

      // Ждём перехода на шаг пароля или загрузки
      await page.waitForTimeout(2000);

      // Шаг 2: Вводим пароль (если поле появилось)
      const passwordInput = page.locator([
        'input[data-qa="account-login-password"]',
        'input[name="password"]',
        'input[type="password"]',
        'input[placeholder*="парол" i]',
      ].join(', ')).first();

      const passCount = await passwordInput.count();
      if (passCount > 0 && await passwordInput.isVisible().catch(() => false)) {
        await passwordInput.click().catch(() => undefined);
        await passwordInput.fill('').catch(() => undefined);
        await passwordInput.type(password, { delay: 30 }).catch(() => {
          void passwordInput.fill(password);
        });

        await page.waitForTimeout(500);

        // Нажимаем «Войти»
        const loginBtn = page.locator([
          'button[data-qa="account-login-submit"]',
          'button[type="submit"]',
          'button:has-text("Войти")',
        ].join(', ')).first();

        if (await loginBtn.count() > 0) {
          await loginBtn.click().catch(() => undefined);
        } else {
          await page.keyboard.press('Enter');
        }

        // Ждём завершения входа
        await page.waitForTimeout(3000);
      }

      // Проверяем, успешен ли вход
      const stillOnLogin = page.url().includes('/account/login');
      const loginRequired = await this.isLoginRequired(page);

      if (!loginRequired && !stillOnLogin) {
        this.update({
          phase: 'browser_open',
          browserOpen: true,
          loginRequired: false,
          message: 'Вход в HH выполнен успешно.',
        });
        return { ok: true, message: 'Вход выполнен успешно.' };
      }

      // Проверяем на ошибку
      const errorText = await page
        .locator('[data-qa*="error"], [class*="error"], [class*="alert"]')
        .first()
        .innerText()
        .catch(() => '');

      return {
        ok: false,
        message: errorText || 'Не удалось войти. Проверьте логин/пароль или войдите вручную.',
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Ошибка входа',
      };
    }
  }

  async requestLoginCode(email: string): Promise<{ ok: boolean; message: string }> {
    try {
      const normalized = email.trim();
      if (!/^\S+@\S+\.\S+$/.test(normalized)) {
        return { ok: false, message: 'Введите корректную почту.' };
      }
      const page = await this.openFreshHhLoginPage();

      const emailInputSelector = [
        'input[data-qa="applicant-login-input-email"]',
        'input[data-qa="account-login-input"]',
        'input[name="login"]',
        'input[name="username"]',
        'input[type="email"]',
      ].join(', ');
      let input = page.locator(emailInputSelector).first();

      // Current HH first asks for the account type. Older/remembered sessions
      // may open directly on credentials, so this step is conditional.
      if (!(await input.isVisible().catch(() => false))) {
        const applicantType = page
          .locator('input[data-qa^="account-type-card-APPLICANT"]')
          .first();
        await applicantType.waitFor({ state: 'attached', timeout: 15_000 });
        await applicantType.check({ force: true }).catch(() => undefined);
        const accountSubmit = page.locator('button[data-qa="submit-button"]').first();
        await accountSubmit.waitFor({ state: 'visible', timeout: 15_000 });
        const hydrationDeadline = Date.now() + 15_000;
        while (!(await accountSubmit.isEnabled().catch(() => false))) {
          if (Date.now() >= hydrationDeadline) throw new Error('Форма HH не завершила загрузку. Обновите окно и повторите вход.');
          await page.waitForTimeout(200);
        }
        await accountSubmit.click();
        await page.locator('input[data-qa^="credential-type-email"]').first()
          .waitFor({ state: 'visible', timeout: 15_000 });
      }

      const emailMethod = page.locator('input[data-qa^="credential-type-email"]').first();
      if (await emailMethod.isVisible().catch(() => false)) {
        await emailMethod.check({ force: true });
      }

      input = page.locator(emailInputSelector).first();
      await input.waitFor({ state: 'visible', timeout: 10_000 });
      await input.fill(normalized);
      await page
        .locator(
          'button[data-qa="submit-button"], button[data-qa="account-login-submit"], button[type="submit"], button:has-text("Продолжить"), button:has-text("Далее")',
        )
        .first()
        .click();
      await page.waitForTimeout(1_500);
      const codeMethod = page
        .locator(
          'button:has-text("Получить код"), button:has-text("Войти по коду"), button:has-text("Код на почту"), a:has-text("Войти по коду")',
        )
        .first();
      if (await codeMethod.isVisible().catch(() => false)) await codeMethod.click();
      // HH renders a visible PIN container and keeps its real text input
      // visually hidden. Waiting for that input to be visible causes a false
      // timeout even though the code screen is already ready.
      await waitForHhOtpReady(page);
      this.update({
        browserOpen: true,
        loginRequired: true,
        message: 'Код отправлен на почту.',
      });
      return { ok: true, message: 'Код отправлен на почту.' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        message: message.includes('net::ERR_ABORTED')
          ? 'HH прервал загрузку страницы входа. Закройте открытое окно HH и попробуйте ещё раз.'
          : message || 'Не удалось отправить код.',
      };
    }
  }

  async confirmLoginCode(code: string): Promise<{ ok: boolean; message: string }> {
    try {
      const page = await this.ensureBrowser('background');
      const normalized = code.replace(/\s/g, '');
      if (!/^\d{4,8}$/.test(normalized)) {
        return { ok: false, message: 'Введите код из письма: от 4 до 8 цифр.' };
      }

      // A previous attempt may already have completed while the renderer was
      // waiting. The HttpOnly crypted_id cookie is HH's durable session marker
      // and is also what JobTurbo's local sidecar waits for.
      if (!(await this.hasHhAuthCookie())) {
        const { container, input } = await waitForHhOtpReady(page);
        const inputCount = await input.count().catch(() => 0);
        const inputDataQa = inputCount
          ? await input.getAttribute('data-qa').catch(() => null)
          : null;
        const isMagrittePin = inputDataQa === 'magritte-pincode-input-field';

        if (await container.isVisible().catch(() => false)) {
          await container.click();
        } else if (inputCount) {
          await input.focus();
        } else {
          throw new Error('HH не показал активное поле для кода. Запросите новый код.');
        }

        if (inputCount) {
          await input
            .evaluate((element) => (element as HTMLInputElement).focus())
            .catch(() => undefined);
        }

        if (isMagrittePin || !(await input.isVisible().catch(() => false))) {
          // Magritte stores digits in React state and handles them on keydown;
          // fill() writes into the hidden input but does not populate the PIN.
          // Backspaces make a retry deterministic without reading the OTP.
          for (let index = 0; index < 8; index += 1) {
            await page.keyboard.press('Backspace');
          }
          await page.keyboard.type(normalized, { delay: 35 });
        } else {
          await input.fill(normalized);
        }

        // The current HH form submits itself after the last digit. Do not click
        // a generic submit button: after redirect it may belong to another page.
        await page.waitForTimeout(300);
        const authDeadline = Date.now() + 30_000;
        let authenticationError = '';
        while (Date.now() < authDeadline) {
          const hasCookie = await this.hasHhAuthCookie();
          const leftLoginPage = !page.url().includes('/account/login');
          if (hasCookie && leftLoginPage) break;
          authenticationError = await firstVisibleText(
            page,
            '[data-qa*="otp"][data-qa*="error"], [data-qa*="code"][data-qa*="error"], [role="alert"], [data-qa*="error"]',
          );
          if (authenticationError) {
            this.update({ loginRequired: true, message: authenticationError });
            return { ok: false, message: authenticationError };
          }
          await page.waitForTimeout(250);
        }
      }

      if (!(await this.hasHhAuthCookie())) {
        const errorText = await firstVisibleText(
          page,
          '[data-qa*="otp"][data-qa*="error"], [data-qa*="code"][data-qa*="error"], [role="alert"], [data-qa*="error"]',
        );
        const message = errorText || 'Код не подошёл или истёк. Запросите новый код из последнего письма.';
        this.update({ loginRequired: true, message });
        return { ok: false, message };
      }

      if (page.url().includes('/404') || page.url().includes('/account/login')) {
        await page.goto('https://hh.ru/applicant/resumes', {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
      }
      this.update({ phase: 'ready', browserOpen: true, loginRequired: false, message: 'HH подключён.' });
      return { ok: true, message: 'HH подключён.' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Не удалось подтвердить код.' };
    }
  }

  async getApplicantResumes(): Promise<HhApplicantResume[]> {
    let page = await this.ensureBrowser('background');
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // This request shares the Chrome profile's cookie jar but does not rely
        // on the HH renderer. It stays responsive even when the visible tab has
        // ended up on HH's post-login 404 page.
        const sessionResult = await this.readApplicantResumesFromSession();
        if (sessionResult.loginRequired) {
          this.update({
            browserOpen: true,
            loginRequired: true,
            message: 'Сессия HH закончилась. Подключите HH ещё раз.',
          });
          return [];
        }
        if (sessionResult.resumes.length > 0) {
          // "Обновить из HH" must also refresh salary/city/body facts; keeping
          // an old body here could auto-submit a value the user just changed.
          this.resumeTextCache.clear();
          this.applicantResumes = sessionResult.resumes;
          this.syncCurrentApplicantResume(sessionResult.resumes);
          this.update({
            browserOpen: true,
            loginRequired: false,
            phase: 'ready',
            message: `Найдено резюме в HH: ${sessionResult.resumes.length}.`,
          });
          return sessionResult.resumes;
        }
      } catch (error) {
        console.warn('[hh-assistant] session resume lookup failed, trying the page:', error);
      }

      try {
        const pageResult = await this.readApplicantResumesFromPage(page);
        if (pageResult.loginRequired) {
          this.update({
            browserOpen: true,
            loginRequired: true,
            message: 'Сессия HH закончилась. Подключите HH ещё раз.',
          });
          return [];
        }
        if (pageResult.resumes.length > 0) {
          this.resumeTextCache.clear();
          this.applicantResumes = pageResult.resumes;
          this.syncCurrentApplicantResume(pageResult.resumes);
          this.update({
            browserOpen: true,
            loginRequired: false,
            phase: 'ready',
            message: `Найдено резюме в HH: ${pageResult.resumes.length}.`,
          });
          return pageResult.resumes;
        }
        if (pageResult.confirmedEmpty) {
          this.update({
            browserOpen: true,
            loginRequired: false,
            phase: 'ready',
            message: 'HH подтвердил, что опубликованных резюме в аккаунте нет.',
          });
          return [];
        }
        lastError = new Error('HH открыл страницу, но не отдал карточки резюме.');
      } catch (error) {
        lastError = error;
      }

      if (attempt === 0) {
        this.update({
          browserOpen: true,
          phase: 'browser_open',
          message: 'HH не ответил. Перезапускаю окно и повторяю загрузку резюме…',
        });
        await this.resetBrowserConnection();
        page = await this.ensureBrowser('background');
      }
    }

    console.warn('[hh-assistant] applicant resumes load failed:', lastError);
    const message =
      'HH не отдал список резюме даже после повторного подключения. Нажмите «Повторить» — заново входить не нужно.';
    this.update({
      phase: 'error',
      browserOpen: Boolean(this.context),
      loginRequired: false,
      message,
    });
    throw new Error(message);
  }

  /** Reads one explicitly selected HH resume without navigating or creating a tab. */
  async getApplicantResumeContent(resumeId: string): Promise<HhPreparationResume> {
    await this.ensureBrowser('background');
    if (!this.context) throw new Error('Не удалось подключиться к фоновой сессии HH.');
    if (this.applicantResumes.length === 0) {
      const result = await this.readApplicantResumesFromSession();
      if (result.loginRequired) {
        throw new Error('Сессия HH закончилась. Подключите HH ещё раз во вкладке «Отклики».');
      }
      this.applicantResumes = result.resumes;
      this.syncCurrentApplicantResume(result.resumes);
    }
    const resume = this.applicantResumes.find((item) => item.id === resumeId.trim());
    if (!resume) throw new Error('Выбранное резюме больше не найдено в HH. Обновите список.');

    const cached = this.resumeTextCache.get(resume.id);
    if (cached && Date.now() - cached.cachedAt <= HH_RESUME_TEXT_CACHE_TTL_MS) {
      return { ...resume, text: cached.text };
    }
    if (cached) this.resumeTextCache.delete(resume.id);
    const response = await this.context.request.get(resume.url, {
      failOnStatusCode: false,
      timeout: 20_000,
      headers: { accept: 'text/html,application/xhtml+xml' },
    }).catch(() => null);
    if (!response?.ok()) throw new Error('HH не отдал выбранное резюме. Повторите загрузку.');
    const text = parseHhResumeText(await response.text());
    if (text.length < 80) {
      throw new Error('HH открыл резюме, но не отдал его содержимое. Обновите резюме на HH и повторите.');
    }
    this.resumeTextCache.set(resume.id, { text, cachedAt: Date.now() });
    return { ...resume, text };
  }

  /** Imports a vacancy for preparation only; never opens the response form or applies. */
  async inspectVacancyUrl(rawUrl: string): Promise<HhPreparationVacancy> {
    const url = normalizeHhVacancyUrl(rawUrl);
    if (!url) throw new Error('Вставьте ссылку вида https://hh.ru/vacancy/123456.');
    await this.ensureBrowser('background');
    if (!this.context) throw new Error('Не удалось подключиться к фоновой сессии HH.');
    const response = await this.context.request.get(url, {
      failOnStatusCode: false,
      timeout: 20_000,
      headers: { accept: 'text/html,application/xhtml+xml' },
    }).catch(() => null);
    if (!response?.ok()) throw new Error('Не удалось загрузить вакансию с HH. Проверьте ссылку.');
    return parseHhVacancyPage(url, await response.text());
  }

  private async isLoginRequired(page: Page, platformValue: JobPlatform = 'hh'): Promise<boolean> {
    const platform = normalizePlatform(platformValue);
    const loginLink = page.locator(PLATFORM_INFO[platform].login.join(', '));
    if (platform !== 'hh') return (await loginLink.count()) > 0;
    if (await this.hasHhAuthCookie()) return false;
    const applicantMenu = page.locator(APPLICANT_MENU_SELECTOR);
    return (await applicantMenu.count()) === 0 && (await loginLink.count()) > 0;
  }

  private async detectManualBlocker(page: Page): Promise<string | null> {
    const body = (await page.locator('body').innerText().catch(() => '')).toLocaleLowerCase('ru');
    if (
      body.includes('подтвердите, что вы не робот') ||
      body.includes('введите код с картинки') ||
      (await hasVisible(page, CAPTCHA_SELECTOR))
    ) {
      return 'HH запросил проверку. Завершите её вручную в браузере.';
    }
    if (await hasVisibleResponseFlowBlocker(page)) {
      return 'Для этой вакансии нужны дополнительные ответы или тест.';
    }
    return null;
  }

  private async scrapeCurrentPage(page: Page): Promise<Array<HhVacancy & { alreadyApplied: boolean }>> {
    const cards = parseHhSearchResults(await page.content(), 100);
    const result: Array<HhVacancy & { alreadyApplied: boolean }> = [];
    for (const card of cards) {
      const url = normalizeHhVacancyUrl(card.rawUrl);
      const id = hhVacancyId(url);
      if (!id || !card.title || !url) continue;
      result.push({
        id,
        title: card.title,
        company: card.company,
        salary: card.salary,
        url,
        alreadyApplied: card.alreadyApplied,
      });
    }
    return result;
  }

  async scan(platformValue?: JobPlatform, runId?: string): Promise<HhAssistantState> {
    const platform = normalizePlatform(platformValue ?? this.state.config.platform);
    const info = PLATFORM_INFO[platform];
    this.lastScanFoundCount = 0;
    if (!this.state.config.query) {
      this.update({
        phase: 'error',
        lastScanSummary: null,
        message: 'Укажите должность или специальность для поиска.',
      });
      return this.getState();
    }

    try {
      this.state.config = normalizeHhAssistantConfig({ ...this.state.config, platform });
      const openingMessage = `Открываю ${info.label} и проверяю сессию…`;
      this.update({ phase: 'scanning', lastScanSummary: null, message: openingMessage });
      this.progressRun(runId, { message: openingMessage });
      const page = await this.ensureBrowser('background');
      const searchResumeContext = platform === 'hh'
        ? await this.getConfiguredSearchResumeContext()
        : '';
      const queries = platform === 'hh'
        ? buildHhSearchQueries(this.state.config, searchResumeContext)
        : [this.state.config.query];
      const collected = new Map<string, HhVacancy & {
        description?: string;
        easyApply?: boolean;
        alreadyApplied?: boolean;
      }>();
      const previous = new Map(this.state.queue.map((item) => [item.key, item]));
      const excludedKeys = new Set<string>();
      const exhaustedQueries = new Set<string>();
      const nextPageByQuery = new Map(queries.map((query) => [query, 0]));
      // Each synonym is an independent HH result set. A shared 100-page
      // budget silently starved later queries and missed vacancies. Exhaust
      // every query up to HH's configured per-query page limit.
      const pagesToScan = platform === 'hh'
        ? queries.length * this.state.config.maxPages
        : this.state.config.maxPages;
      const queueLimit = this.state.config.maxQueueSize;
      let pagesScanned = 0;

      // HH's personalised home feed can surface a strong match that is buried
      // deep in text search. Treat it as an additional discovery source. A
      // generic QA title is verified against the full vacancy body before it is
      // allowed into the automatic queue, so this does not broaden auto-apply
      // to unrelated manual-QA or non-Python jobs.
      if (platform === 'hh' && !this.stopApplyRequested) {
        const recommendationMessage = 'Сверяю персональные рекомендации HH с выбранной ролью…';
        this.update({ phase: 'scanning', browserOpen: true, message: recommendationMessage });
        this.progressRun(runId, { found: collected.size, message: recommendationMessage });
        await page.goto('https://hh.ru/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
        const blocker = await this.detectManualBlocker(page);
        if (blocker) {
          this.update({ phase: 'manual_required', browserOpen: true, message: blocker });
          return this.getState();
        }
        if (await this.isLoginRequired(page, platform)) {
          this.update({
            phase: 'manual_required',
            browserOpen: true,
            loginRequired: true,
            message: `Сначала войдите в ${info.label} в открытом браузере.`,
          });
          return this.getState();
        }
        await page.locator(info.cards.join(', ')).first().waitFor({ timeout: 6_000 }).catch(() => undefined);
        const recommendations = await this.scrapeCurrentPage(page);
        for (const recommendation of recommendations) {
          if (this.stopApplyRequested || collected.size >= queueLimit) break;
          const key = jobKey(platform, recommendation.id);
          if (shouldExcludeVacancy(recommendation, this.state.config)) {
            excludedKeys.add(key);
            continue;
          }
          if (!isVacancyRelevantToSearchQuery(recommendation, this.state.config.query)) continue;

          let candidate: HhVacancy & {
            description?: string;
            easyApply?: boolean;
            alreadyApplied?: boolean;
          } = { ...recommendation, description: '', easyApply: false };
          if (
            !isVacancyRelevantToSearchProfile(
              candidate,
              this.state.config.query,
              '',
              searchResumeContext,
            )
            || !isVacancyCompatibleWithSearchSchedule(
              candidate,
              this.state.config.schedule,
              candidate.description,
            )
          ) {
            const response = await this.context?.request.get(candidate.url, {
              failOnStatusCode: false,
              timeout: 20_000,
              headers: { accept: 'text/html,application/xhtml+xml' },
            }).catch(() => null);
            if (!response?.ok()) continue;
            try {
              const details = parseHhVacancyPage(candidate.url, await response.text());
              candidate = { ...candidate, ...details };
            } catch {
              continue;
            }
          }
          if (!isVacancyRelevantToSearchProfile(
            candidate,
            this.state.config.query,
            candidate.description,
            searchResumeContext,
          )) continue;
          if (!isVacancyCompatibleWithSearchSchedule(
            candidate,
            this.state.config.schedule,
            candidate.description,
          )) continue;
          if (!collected.has(key)) collected.set(key, candidate);
        }
      }

      scanLoop: while (
        pagesScanned < pagesToScan
        && collected.size < queueLimit
        && exhaustedQueries.size < queries.length
        && !this.stopApplyRequested
      ) {
        let requestedInRound = false;
        for (const searchQuery of queries) {
          if (this.stopApplyRequested) break scanLoop;
          if (
            exhaustedQueries.has(searchQuery)
            || pagesScanned >= pagesToScan
            || collected.size >= queueLimit
          ) continue;
          requestedInRound = true;
          const pageIndex = nextPageByQuery.get(searchQuery) ?? 0;
          nextPageByQuery.set(searchQuery, pageIndex + 1);
          pagesScanned += 1;
          const pageMessage = queries.length > 1
            ? `Проверяю ${pagesScanned} из ${pagesToScan}: ${searchQuery} · страница ${pageIndex + 1}…`
            : `Ищу вакансии: страница ${pageIndex + 1} из ${pagesToScan}…`;
          this.update({ phase: 'scanning', browserOpen: true, message: pageMessage });
          this.progressRun(runId, { found: collected.size, message: pageMessage });
          await page.goto(
            buildPlatformSearchUrl(platform, this.state.config, pageIndex, searchQuery),
            { waitUntil: 'domcontentloaded', timeout: 30_000 },
          );
          if (this.stopApplyRequested) break scanLoop;
          const blocker = await this.detectManualBlocker(page);
          if (blocker) {
            this.update({
              phase: 'manual_required',
              browserOpen: true,
              message: blocker,
            });
            return this.getState();
          }
          const loginRequired = await this.isLoginRequired(page, platform);
          if (loginRequired) {
            this.update({
              phase: 'manual_required',
              browserOpen: true,
              loginRequired: true,
              message: `Сначала войдите в ${info.label} в открытом браузере.`,
            });
            return this.getState();
          }
          await page.locator(info.cards.join(', ')).first().waitFor({ timeout: 6_000 }).catch(() => undefined);
          if (this.stopApplyRequested) break scanLoop;
          const pageVacancies = platform === 'hh'
            ? (await this.scrapeCurrentPage(page)).map((vacancy) => ({ ...vacancy, description: '', easyApply: false }))
            : await extractPlatformCards(page, platform);
          if (pageVacancies.length === 0) {
            exhaustedQueries.add(searchQuery);
            continue;
          }
          for (const rawVacancy of pageVacancies) {
            let vacancy = rawVacancy;
            const key = jobKey(platform, vacancy.id);
            if (shouldExcludeVacancy(vacancy, this.state.config)) {
              excludedKeys.add(key);
              continue;
            }
            if (platform === 'hh') {
              if (!isVacancyRelevantToSearchQuery(vacancy, searchQuery)) {
                excludedKeys.add(key);
                continue;
              }
              if (!isVacancyRelevantToSearchProfile(
                vacancy, this.state.config.query, vacancy.description, searchResumeContext,
              )) {
                // Search cards frequently have a generic "QA Engineer" title
                // and omit the body where automation/Python is stated. Load it
                // before rejecting, otherwise valid automation roles vanish.
                const response = await this.context?.request.get(vacancy.url, {
                  failOnStatusCode: false,
                  timeout: 20_000,
                  headers: { accept: 'text/html,application/xhtml+xml' },
                }).catch(() => null);
                if (response?.ok()) {
                  try {
                    vacancy = { ...vacancy, ...parseHhVacancyPage(vacancy.url, await response.text()) };
                  } catch { /* keep the card and fail closed below */ }
                }
                if (!isVacancyRelevantToSearchProfile(
                  vacancy, this.state.config.query, vacancy.description, searchResumeContext,
                )) {
                  excludedKeys.add(key);
                  continue;
                }
              }
            }
            if (!collected.has(key)) collected.set(key, vacancy);
            if (collected.size >= queueLimit) break;
          }
          const foundMessage = `Найдено ${collected.size} · проверено страниц ${pagesScanned}`;
          this.update({ message: foundMessage });
          this.progressRun(runId, { found: collected.size, message: foundMessage });
        }
        if (!requestedInRound) break;
      }

      const queue: HhQueueItem[] = [];
      for (const vacancy of collected.values()) {
        const key = jobKey(platform, vacancy.id);
        const old = previous.get(key);
        const alreadyApplied = vacancy.alreadyApplied === true;
        const retryFalseMissingNegotiation = old?.status === 'skipped'
          && !old.sentAt
          && /отклик больше не найден в активных переговорах hh/i.test(old.reason ?? '');
        const vacancyData = { ...vacancy };
        delete vacancyData.alreadyApplied;
        queue.push({
          ...old,
          ...vacancyData,
          key,
          platform,
          description: mergeHhVacancyDescription(old?.description, vacancy.description),
          status: alreadyApplied
            ? old?.coverLetterPending
              ? 'opened'
              : old?.status === 'sent' && Boolean(old.sentAt) ? 'sent' : 'already_applied'
            : retryFalseMissingNegotiation ? 'new' : old?.status ?? 'new',
          reason: alreadyApplied
            ? old?.coverLetterPending
              ? old.reason ?? 'Дожидаюсь формы сопроводительного письма; отклик пока не считаю завершённым.'
              : old?.status === 'sent' && Boolean(old.sentAt)
              ? old.reason
              : 'HH показывает: отклик уже был отправлен ранее.'
            : retryFalseMissingNegotiation
              ? 'Страница HH снова показывает доступный отклик. Вакансия возвращена в очередь.'
              : old?.reason,
          addedAt: old?.addedAt ?? nowIso(),
          pendingQuestions: alreadyApplied ? undefined : old?.pendingQuestions,
          screeningAnswers: alreadyApplied ? undefined : old?.screeningAnswers,
          coverLetterPending: retryFalseMissingNegotiation ? false : old?.coverLetterPending,
          coverLetterAdded: retryFalseMissingNegotiation ? false : old?.coverLetterAdded,
          autoRetryBlockedUntil: alreadyApplied || retryFalseMissingNegotiation
            ? undefined
            : old?.autoRetryBlockedUntil,
          selectedResumeTitle: old?.selectedResumeTitle ?? rankHhResumeTitlesForVacancy(
            vacancy.title,
            this.applicantResumes.map((resume) => resume.title),
            this.state.config.resumeTitles,
          )[0],
          selectedResumeVerified: old?.selectedResumeTitle
            ? old.selectedResumeVerified
            : undefined,
        });
      }
      const foundCount = queue.length;
      this.lastScanFoundCount = foundCount;
      const newVacancies = queue.filter(
        (item) => !previous.has(item.key) && isActionableQueueItem(item),
      ).length;
      const readyToApply = queue.filter((item) => isActionableQueueItem(item)).length;
      const summary: HhScanSummary = {
        platform,
        queries,
        pagesScanned,
        found: foundCount,
        newVacancies,
        readyToApply,
        alreadyProcessed: Math.max(0, foundCount - readyToApply),
        excluded: [...excludedKeys].filter((key) => !collected.has(key)).length,
        schedule: this.state.config.schedule,
      };
      const summaryMessage = scanSummaryMessage(summary);
      const finalMessage = this.stopApplyRequested
        ? `Поиск остановлен вами. Найденные вакансии сохранены: ${foundCount}. Отклики больше не отправляются.`
        : summaryMessage;
      const queuedIds = new Set(queue.map((item) => item.key));
      for (const item of this.state.queue) {
        if (!queuedIds.has(item.key)) {
          queue.push(
            item.status === 'new' && excludedKeys.has(item.key)
              ? { ...item, status: 'skipped', reason: 'Не соответствует названию выбранной роли.' }
              : item,
          );
          queuedIds.add(item.key);
        }
        if (queue.length >= 5_000) break;
      }
      this.update({
        phase: 'ready',
        browserOpen: true,
        loginRequired: false,
        queue,
        lastScanSummary: summary,
        message: finalMessage,
      });
      this.progressRun(runId, {
        found: foundCount,
        message: this.stopApplyRequested
          ? finalMessage
          : foundCount && readyToApply > 0
          ? `${summaryMessage} Перехожу к откликам…`
          : summaryMessage,
      });
    } catch (error) {
      this.fail(error);
    }
    return this.getState();
  }

  async applyVacancyUrl(rawUrl: string): Promise<HhAssistantState> {
    const url = normalizeHhVacancyUrl(rawUrl);
    if (this.applyInFlight || this.automationRunInFlight) {
      this.update({ message: 'Дождитесь завершения текущего прогона, затем проверьте ссылку.' });
      return this.getState();
    }
    const run = this.beginRun('direct_link', url || undefined);
    if (!url) {
      const message = 'Вставьте ссылку вида https://hh.ru/vacancy/123456.';
      this.update({ phase: 'error', message });
      this.finishRun(run.id, { status: 'failed', message });
      return this.getState();
    }
    try {
      const page = await this.ensureBrowser('background');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const blocker = await this.detectManualBlocker(page);
      if (blocker) {
        this.update({ phase: 'manual_required', browserOpen: true, message: blocker });
        this.finishRun(run.id, { status: 'attention', found: 1, needsAttention: 1, message: blocker });
        return this.getState();
      }
      if (await this.isLoginRequired(page, 'hh')) {
        const message = 'Сессия HH закончилась. Подключите HH ещё раз.';
        this.update({ phase: 'manual_required', browserOpen: true, loginRequired: true, message });
        this.finishRun(run.id, { status: 'attention', found: 1, needsAttention: 1, message });
        return this.getState();
      }
      const id = hhVacancyId(page.url()) || hhVacancyId(url);
      const title = (await firstText(page, [VACANCY_PAGE_TITLE_SELECTOR])).slice(0, 300);
      if (!id || !title) throw new Error('HH не отдал название вакансии по этой ссылке.');
      const key = jobKey('hh', id);
      const existing = this.state.queue.find((item) => item.key === key);
      const responseAvailable = await hasVisible(page, RESPONSE_BUTTON_SELECTOR);
      const vacancy: HhQueueItem = {
        key,
        platform: 'hh',
        id,
        title,
        company: (await firstText(page, [VACANCY_PAGE_COMPANY_SELECTOR])).slice(0, 300),
        salary: (await firstText(page, [VACANCY_PAGE_SALARY_SELECTOR])).slice(0, 120),
        url,
        description: (await firstText(page, PLATFORM_INFO.hh.descriptions)).slice(0, 12_000),
        status: responseAvailable
          ? 'new'
          : existing?.status === 'sent'
          ? 'sent'
          : existing?.status === 'already_applied'
            ? 'already_applied'
            : existing?.status === 'needs_input' ? 'needs_input' : 'new',
        reason: responseAvailable
          ? undefined
          : existing?.status === 'sent'
          || existing?.status === 'already_applied'
          || existing?.status === 'needs_input'
          ? existing.reason
          : undefined,
        addedAt: existing?.addedAt ?? nowIso(),
        sentAt: responseAvailable ? undefined : existing?.sentAt,
        pendingQuestions: existing?.pendingQuestions,
        screeningAnswers: existing?.screeningAnswers,
        preparationNotes: existing?.preparationNotes,
        coverLetterPending: responseAvailable ? false : existing?.coverLetterPending,
        coverLetterAdded: responseAvailable ? false : existing?.coverLetterAdded,
        selectedResumeTitle: existing?.selectedResumeTitle ?? rankHhResumeTitlesForVacancy(
          title,
          this.applicantResumes.map((resume) => resume.title),
          this.state.config.resumeTitles,
        )[0],
        selectedResumeVerified: existing?.selectedResumeTitle
          ? existing.selectedResumeVerified
          : undefined,
      };
      this.update({
        phase: 'ready',
        browserOpen: true,
        loginRequired: false,
        queue: [vacancy, ...this.state.queue.filter((item) => item.key !== key)].slice(0, 1_000),
        currentVacancyId: key,
        message: `Вакансия «${title}» добавлена по ссылке. Начинаю отклик…`,
      });
      await this.applyOne(key, { explicitUserSelection: true });
      if (this.state.queuePaused) {
        this.finishRun(run.id, {
          status: 'stopped',
          found: 1,
          message: this.state.message,
        });
        return this.getState();
      }
      const result = this.state.queue.find((item) => item.key === key);
      const sent = result?.status === 'sent' ? 1 : 0;
      const alreadyApplied = result?.status === 'already_applied' ? 1 : 0;
      const skipped = result?.status === 'skipped' ? 1 : 0;
      const needsAttention = sent || alreadyApplied || skipped ? 0 : 1;
      this.finishRun(run.id, {
        status: needsAttention ? 'attention' : 'completed',
        found: 1,
        attempted: 1,
        sent,
        alreadyApplied,
        skipped,
        needsAttention,
        message: result?.reason || this.state.message,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.fail(error);
      this.finishRun(run.id, { status: 'failed', message });
    }
    return this.getState();
  }

  async openVacancy(vacancyId: string): Promise<HhAssistantState> {
    const vacancy = this.state.queue.find((item) => item.key === vacancyId || item.id === vacancyId);
    if (!vacancy) {
      this.update({ phase: 'error', message: 'Вакансия не найдена в очереди.' });
      return this.getState();
    }
    try {
      // Inspecting a vacancy is an explicit single-page action. Close a chat
      // tab left by a previous explicit command so negotiations do not appear
      // beside the vacancy the user just opened.
      if (this.chatPage && !this.chatPage.isClosed()) {
        await this.chatPage.close().catch(() => undefined);
        this.chatPage = null;
      }
      const page = await this.ensureBrowser('interactive');
      await page.goto(vacancy.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.bringToFront();
      await this.captureVacancyDescription(page, vacancy);
      const blocker = await this.detectManualBlocker(page);
      const terminalStatus = vacancy.status === 'sent'
        || vacancy.status === 'already_applied'
        || vacancy.status === 'skipped';
      this.patchQueue(vacancy.key, {
        status: terminalStatus
          ? vacancy.status
          : vacancy.status === 'needs_input' ? 'needs_input' : 'opened',
      });
      this.update({
        phase: blocker ? 'manual_required' : 'ready',
        currentVacancyId: vacancy.key,
        browserOpen: true,
        message:
          blocker ??
          `Вакансия открыта на ${PLATFORM_INFO[vacancy.platform].label}. Проверьте её и выполните финальное действие вручную.`,
      });
    } catch (error) {
      this.fail(error);
    }
    return this.getState();
  }

  async fillCoverLetter(vacancyId: string): Promise<HhAssistantState> {
    const vacancy = this.state.queue.find((item) => item.key === vacancyId || item.id === vacancyId);
    if (!vacancy) {
      this.update({ phase: 'error', message: 'Вакансия не найдена в очереди.' });
      return this.getState();
    }
    try {
      const page = await this.ensureBrowser('interactive');
      if (vacancy.platform !== 'hh') {
        await page.goto(vacancy.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.bringToFront();
        this.update({ phase: 'manual_required', currentVacancyId: vacancy.key, message: `Откройте форму отклика на ${PLATFORM_INFO[vacancy.platform].label}. Финальная отправка остаётся ручной.` });
        return this.getState();
      }
      if (hhVacancyId(page.url()) !== vacancy.id) {
        await page.goto(vacancy.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      }
      const blocker = await this.detectManualBlocker(page);
      if (blocker) {
        this.update({ phase: 'manual_required', message: blocker });
        return this.getState();
      }
      const textarea = page.locator(LETTER_SELECTOR).first();
      if ((await textarea.count()) === 0 || !(await textarea.isVisible())) {
        this.update({
          phase: 'manual_required',
          currentVacancyId: vacancyId,
          message:
            'Сначала нажмите «Откликнуться» в браузере HH. Финальную отправку SkillCue не нажимает.',
        });
        return this.getState();
      }
      const generated = await this.prepareCoverLetter(page, vacancy);
      if (!generated.ok) {
        this.recordCoverLetterFailure(vacancy, generated);
        return this.getState();
      }
      await textarea.fill(generated.letter);
      await page.bringToFront();
      this.patchQueue(vacancy.key, {
        status: 'prepared',
        autoRetryBlockedUntil: undefined,
      });
      this.update({
        phase: 'ready',
        currentVacancyId: vacancyId,
        message: 'Письмо заполнено. Проверьте его и отправьте отклик в окне HH.',
      });
    } catch (error) {
      this.fail(error);
    }
    return this.getState();
  }

  // --- Авто-отклик: детект ситуации, конкретные действия и цикл по очереди. ---

  private buildApplyContext(): HhApplyContext {
    return {
      // Product invariant: every new automatic HH application must include a
      // confirmed cover letter. If generation is unavailable, preparation
      // blocks the application instead of silently sending it without text.
      hasCoverLetter: true,
      resumeTitleContains: (this.state.config.resumeTitles[0] ?? this.state.config.resumeTitleContains).trim(),
      resumeSelected: false,
      letterFilled: false,
      questionsFilled: false,
      responseClicked: false,
      responseSubmitted: false,
    };
  }

  private async detectApplySituation(
    page: Page,
    ctx: HhApplyContext,
  ): Promise<HhApplySituation> {
    const body = () =>
      page
        .locator('body')
        .innerText({ timeout: 5_000 })
        .then((text) => text.toLocaleLowerCase('ru'))
        .catch(() => '');

    const loginLink = page.locator(
      '[data-qa="login"], a[href*="/account/login"], a[href*="/account/signup"]',
    );
    const applicantMenu = page.locator(
      '[data-qa="mainmenu_applicantProfile"], [data-qa="mainmenu_applicantProfileAndResumes"]',
    );
    if (
      (await applicantMenu.count()) === 0 &&
      (await loginLink.count()) > 0 &&
      page.url().includes('/account/login')
    ) {
      return 'login';
    }

    const text = await body();
    if (
      text.includes('подтвердите, что вы не робот') ||
      text.includes('введите код с картинки') ||
      (await hasVisible(page, CAPTCHA_SELECTOR))
    ) {
      return 'captcha';
    }
    const alreadyAppliedVisible =
      isAlreadyAppliedHhText(text) ||
      (await hasVisible(page, ALREADY_APPLIED_SELECTOR));
    // Current HH forms can show employer test fields and the cover-letter
    // textarea at the same time. Questions are mandatory, so handle them
    // before classifying the same form as a letter editor.
    if (!ctx.questionsFilled && (await hasVisibleResponseFlowBlocker(page))) {
      return 'employer_questions';
    }
    const letter = page.locator(LETTER_SELECTOR).first();
    let letterFormVisible = (await letter.count()) > 0 && await letter.isVisible().catch(() => false);
    let addCoverLetterVisible = await hasVisible(page, ADD_COVER_LETTER_SELECTOR);
    const successVisible =
      text.includes('отклик отправлен') || (await hasVisible(page, SUCCESS_SELECTOR));
    const responseAccepted = successVisible || alreadyAppliedVisible || ctx.responseSubmitted;
    // HH often renders the success state first and adds the letter controls a
    // moment later. Give that UI a grace period before deciding the response
    // flow is finished.
    if (
      responseAccepted
      && (ctx.responseClicked || ctx.responseSubmitted)
      && ctx.hasCoverLetter
      && !ctx.letterFilled
      && !letterFormVisible
      && !addCoverLetterVisible
    ) {
      await page
        .locator(`${LETTER_SELECTOR}:visible, ${ADD_COVER_LETTER_SELECTOR}:visible`)
        .first()
        .waitFor({ state: 'visible', timeout: 5_000 })
        .catch(() => undefined);
      letterFormVisible = (await letter.count()) > 0 && await letter.isVisible().catch(() => false);
      addCoverLetterVisible = await hasVisible(page, ADD_COVER_LETTER_SELECTOR);
    }
    // HH can keep the success banner visible while the post-response letter
    // editor is open. Finish and submit that editor before marking the vacancy
    // as sent, otherwise the application silently loses its cover letter.
    if (letterFormVisible) {
      return 'letter_form';
    }
    if (addCoverLetterVisible) {
      return responseAccepted || ctx.responseClicked
        ? 'post_response_letter_offer'
        : 'letter_offer';
    }
    if (successVisible) {
      return 'success';
    }
    if (alreadyAppliedVisible) {
      // A stale HH banner can coexist with a real action button (for example
      // after switching a resume). A visible response action is the stronger
      // signal: the vacancy is actionable now.
      if (await hasVisible(page, RESPONSE_BUTTON_SELECTOR)) {
        return 'response_button';
      }
      return 'already_applied';
    }
    if (!ctx.resumeSelected && (await hasVisible(page, RESUME_ANY_SELECTOR))) {
      return 'resume_select';
    }
    if (await hasVisible(page, RESPONSE_SUBMIT_SELECTOR)) {
      return 'confirm';
    }
    if (await hasVisible(page, RESPONSE_BUTTON_SELECTOR)) {
      return 'response_button';
    }
    return 'unknown';
  }

  private async selectPreferredResume(page: Page, selectedTitles: string[], vacancyTitle: string): Promise<string> {
    if (selectedTitles.length === 0) {
      throw new Error('Не выбрано резюме для отклика HH. Отклик не отправлен.');
    }
    const allowed = selectedTitles;
    const vacancyTokens = new Set(vacancyTitle.toLocaleLowerCase('ru').split(/[^a-zа-яё0-9+#.]+/i).filter((token) => token.length > 2));
    const target = allowed
      .map((title) => ({
        title,
        score: title.toLocaleLowerCase('ru')
          .split(/[^a-zа-яё0-9+#.]+/i)
          .filter((token) => vacancyTokens.has(token)).length,
      }))
      .sort((left, right) => right.score - left.score)[0]?.title;
    if (!target) throw new Error('Не удалось определить резюме для отклика HH.');

    // Current HH response modal shows the selected resume as resume-title and
    // reveals the alternatives after that card is clicked.
    const modernTitles = page.locator('[data-qa="resume-title"]');
    const visibleModern = async (): Promise<Array<{ index: number; text: string }>> => {
      const result: Array<{ index: number; text: string }> = [];
      const count = Math.min(await modernTitles.count(), 20);
      for (let index = 0; index < count; index += 1) {
        const item = modernTitles.nth(index);
        if (!(await item.isVisible().catch(() => false))) continue;
        result.push({
          index,
          text: (await item.innerText().catch(() => '')).toLocaleLowerCase('ru').trim(),
        });
      }
      return result;
    };
    let visible = await visibleModern();
    if (visible.length > 0) {
      const currentExact = normalizeHhResumeTitleForSelection(visible[0]?.text ?? '')
        === normalizeHhResumeTitleForSelection(target);
      if (visible.length === 1 && currentExact) return target;
      if (visible.length === 1) {
        await modernTitles.nth(visible[0].index).click({ timeout: 5_000 });
        await page.waitForTimeout(250);
        visible = await visibleModern();
      }
      const selectedIndex = explicitlySelectedTitleIndex(
        visible.map((item) => item.text),
        target,
      );
      if (selectedIndex != null) {
        const option = visible[selectedIndex];
        if (option) {
          const selectedItem = modernTitles.nth(option.index);
          await selectedItem.click({ timeout: 5_000 });
          await page.waitForTimeout(250);
          const confirmed = await visibleModern();
          if (
            confirmed.length === 1
            && normalizeHhResumeTitleForSelection(confirmed[0]?.text ?? '')
              === normalizeHhResumeTitleForSelection(target)
          ) return target;
          const radio = selectedItem.locator('input[type="radio"], input[data-qa*="resume"]');
          const radioCount = await radio.count().catch(() => 0);
          const checked = radioCount > 0
            ? await radio.first().isChecked().catch(() => null)
            : null;
          const ariaSelected = await selectedItem.getAttribute('aria-selected').catch(() => null);
          const ariaChecked = await selectedItem.getAttribute('aria-checked').catch(() => null);
          if (checked === true || ariaSelected === 'true' || ariaChecked === 'true') return target;
          throw new Error(`HH не подтвердил выбор резюме «${target}». Отклик не отправлен.`);
        }
      }
      throw new Error(`Выбранное резюме «${target}» не найдено в форме отклика HH.`);
    }

    // Compatibility fallback for the previous HH response form.
    const items = page.locator(RESUME_ITEM_SELECTOR);
    const count = Math.min(await items.count(), 10);
    const itemTitles: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const item = items.nth(index);
      itemTitles.push(await item.innerText().catch(() => ''));
    }
    const selectedIndex = explicitlySelectedTitleIndex(itemTitles, target);
    if (selectedIndex != null) {
      const selectedItem = items.nth(selectedIndex);
      try {
        await selectedItem.click({ timeout: 5_000 });
      } catch (error) {
        throw new Error(`Не удалось выбрать резюме «${target}» в форме отклика HH.`, {
          cause: error,
        });
      }
      await page.waitForTimeout(100);
      const radio = selectedItem.locator('input[type="radio"], input[data-qa*="resume"]');
      const radioCount = await radio.count().catch(() => 0);
      const checked = radioCount > 0
        ? await radio.first().isChecked().catch(() => null)
        : null;
      const ariaSelected = await selectedItem.getAttribute('aria-selected').catch(() => null);
      const ariaChecked = await selectedItem.getAttribute('aria-checked').catch(() => null);
      if (checked === true || ariaSelected === 'true' || ariaChecked === 'true') return target;
      throw new Error(`HH не подтвердил выбор резюме «${target}». Отклик не отправлен.`);
    }
    throw new Error(`Выбранное резюме «${target}» не найдено в форме отклика HH.`);
  }

  private async clickFirstVisible(
    page: Page,
    selector: string,
  ): Promise<boolean> {
    const locator = page.locator(selector);
    const count = Math.min(await locator.count(), 5);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      try {
        await candidate.click({ timeout: 5_000 });
        return true;
      } catch {
        // Try another matching control: HH sometimes keeps a hidden or stale
        // duplicate button in the response modal while it re-renders.
      }
    }
    return false;
  }

  private async openResponseForm(page: Page): Promise<boolean> {
    const links = page.locator(RESPONSE_BUTTON_SELECTOR);
    const count = Math.min(await links.count(), 10);
    for (let index = 0; index < count; index += 1) {
      const link = links.nth(index);
      if (!(await link.isVisible().catch(() => false))) continue;
      const href = await link.getAttribute('href').catch(() => null);
      if (!href) continue;
      try {
        const target = new URL(href, page.url());
        if (!isHhPage(target.href) || target.pathname !== '/applicant/vacancy_response') continue;
        await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        return true;
      } catch {
        // Fall back to the rendered button below. This also covers a future HH
        // response control that stops exposing a normal href.
      }
    }
    return this.clickFirstVisible(page, RESPONSE_BUTTON_SELECTOR);
  }

  private async preferredApplicantResume(
    vacancyTitle: string,
    selectedResumeTitle = '',
  ): Promise<HhApplicantResume | undefined> {
    if (!this.context) return undefined;
    if (this.applicantResumes.length === 0) {
      const result = await this.readApplicantResumesFromSession().catch(() => null);
      if (result && !result.loginRequired) {
        this.applicantResumes = result.resumes;
        this.syncCurrentApplicantResume(result.resumes);
      }
    }
    const explicitlySelected = selectedResumeTitle.trim();
    if (explicitlySelected) {
      const selected = findExplicitlySelectedHhResume(this.applicantResumes, explicitlySelected);
      if (selected) return selected;
      // HH can reformat a card title or an older build can persist a stale
      // inferred title. Re-rank the current account resumes below instead of
      // turning the stale string into a permanent manual gate.
    }
    const rankedTitles = rankHhResumeTitlesForVacancy(
      vacancyTitle,
      this.applicantResumes.map((resume) => resume.title),
      this.state.config.resumeTitles,
    );
    const preferredTitle = rankedTitles[0];
    return preferredTitle
      ? findExplicitlySelectedHhResume(this.applicantResumes, preferredTitle)
      : undefined;
  }

  /**
   * Search belongs to the resume selected in settings, not to whichever resume
   * might later rank best for one particular vacancy.
   */
  private async getConfiguredSearchResumeContext(): Promise<string> {
    if (!this.context) return this.state.config.resumeTitles.join('\n').trim();
    if (this.applicantResumes.length === 0) {
      const result = await this.readApplicantResumesFromSession().catch(() => null);
      if (result && !result.loginRequired) {
        this.applicantResumes = result.resumes;
        this.syncCurrentApplicantResume(result.resumes);
      }
    }
    const fallback = this.state.config.resumeTitles.join('\n').trim();
    const configuredTitle = this.state.config.resumeTitles[0]?.trim() ?? '';
    const selected = configuredTitle
      ? findExplicitlySelectedHhResume(this.applicantResumes, configuredTitle)
      : this.applicantResumes.length === 1
        ? this.applicantResumes[0]
        : undefined;
    if (!selected) return fallback;
    const text = await this.getApplicantResumeContent(selected.id)
      .then((result) => result.text)
      .catch(() => '');
    return [selected.title, text].filter(Boolean).join('\n').trim() || fallback;
  }

  /** Best matching HH résumé for this vacancy, reused by forms, letters and recruiter chat. */
  async getSelectedResumeText(
    vacancyTitle: string,
    options: { throwOnFailure?: boolean; selectedResumeTitle?: string } = {},
  ): Promise<string> {
    const preferred = await this.preferredApplicantResume(
      vacancyTitle,
      options.selectedResumeTitle,
    );
    if (!preferred) {
      if (options.throwOnFailure) {
        const selected = options.selectedResumeTitle?.trim();
        throw new Error(selected
          ? `Выбранное резюме «${selected}» больше не найдено в HH. Обновите список резюме.`
          : 'Не удалось выбрать подходящее резюме в HH. Обновите список резюме.');
      }
      return '';
    }
    try {
      const result = await this.getApplicantResumeContent(preferred.id);
      // Desired salary is often stored in the HH résumé title rather than in
      // its body. Forms and recruiter chats need both verified sources.
      return [preferred.title, result.text].filter(Boolean).join('\n');
    } catch (error) {
      if (options.throwOnFailure) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Не удалось загрузить выбранное резюме «${preferred.title}»: ${detail}`, {
          cause: error,
        });
      }
      return '';
    }
  }

  private async fillEmployerQuestions(
    page: Page,
    vacancy: HhQueueItem,
  ): Promise<{
    ok: boolean;
    reason: string;
    failureKind?: 'manual' | 'transient';
    pendingQuestions?: HhScreeningQuestion[];
    preparationNotes?: string[];
  }> {
    const fields = await collectHhScreeningFields(page);
    if (fields.length === 0) {
      return {
        ok: false,
        reason: 'HH открыл внешний тест или форму без распознаваемых полей. Заполните её вручную.',
        failureKind: 'manual',
      };
    }

    this.update({
      phase: 'applying',
      message: `Готовлю ответы на вопросы работодателя: ${fields.length}…`,
    });
    const resumeTitleSources = resumeTitleFactSources(
      vacancy.selectedResumeTitle,
      this.state.config.resumeTitles,
    );
    const resumeTitleContext = resumeTitleSources.join('\n').trim();
    const titleSalaryExpectation = findSalaryExpectation(
      null,
      resumeTitleSources,
    );
    const preflightFacts = new Map<string, HhStoredScreeningAnswer | HhScreeningFact>();
    for (const fact of this.state.screeningFacts) {
      preflightFacts.set(screeningQuestionSemanticKey(fact.question), fact);
    }
    for (const answer of vacancy.screeningAnswers ?? []) {
      if (answer.confirmedByUser !== true) continue;
      preflightFacts.set(screeningQuestionSemanticKey(answer.question), answer);
    }
    const preflightAnswers = new Map(fields.flatMap((field) => {
      const exactVacancyAnswer = findExactVacancyScreeningAnswer(
        field.question,
        vacancy.screeningAnswers,
      );
      const exactMapped = exactVacancyAnswer
        ? reusableScreeningAnswer(field.question, exactVacancyAnswer)
        : null;
      if (exactMapped?.canAutoFill) {
        return [[field.question.id, exactMapped] as const];
      }
      // The selected résumé is the freshest source for the candidate's current
      // city. Do not let an older remembered answer suppress loading it.
      if (isCurrentLocationQuestion(field.question.prompt)) return [];
      const known = knownScreeningAnswer(
        field.question,
        titleSalaryExpectation,
        resumeTitleContext,
      );
      const fact = preflightFacts.get(screeningQuestionSemanticKey(field.question.prompt))
        ?? findReusableScreeningFact(field.question, preflightFacts.values());
      const salaryQuestion = isSalaryRelatedQuestion(field.question.prompt);
      const answer = salaryQuestion
        ? known
        : (fact ? reusableScreeningAnswer(field.question, fact) : null) ?? known;
      return answer?.canAutoFill ? [[field.question.id, answer] as const] : [];
    }));
    let resumeText = resumeTitleContext;
    let resumeLoadError = '';
    if (fields.some((field) => !preflightAnswers.has(field.question.id))) {
      try {
        resumeText = await this.getSelectedResumeText(vacancy.title, {
          throwOnFailure: true,
          selectedResumeTitle: vacancy.selectedResumeTitle,
        });
      } catch (error) {
        resumeLoadError = error instanceof Error
          ? error.message
          : 'Временно не удалось загрузить выбранное резюме для ответов работодателю.';
        // Continue with selected-title/config context. Every collected field
        // still receives a local review draft instead of disappearing behind
        // a transient dead-end.
        resumeText = resumeTitleContext;
      }
    }
    const confirmedAnswers = selectRelevantScreeningFacts(
      this.state.screeningFacts,
      fields.map((field) => field.question),
      30,
    )
      // Salary is scoped to the exact résumé selected for this vacancy (or an
      // explicit configured amount). A remembered value from another résumé
      // must not be sent back to the model as trusted provenance.
      .filter((item) => (
        !isSalaryRelatedQuestion(item.question)
        && !isCurrentLocationQuestion(item.question)
      ))
      .map((item) => ({
      question: item.question,
      answer: item.answer,
      selectedOptions: item.selectedOptions,
      }));
    const salaryExpectation = findSalaryExpectation(
      null,
      selectedResumeFactSources(
        vacancy.selectedResumeTitle,
        resumeText,
        this.state.config.resumeTitles,
      ),
    );
    const knownAnswers = new Map(
      fields.flatMap((field) => {
        const exactVacancyAnswer = findExactVacancyScreeningAnswer(
          field.question,
          vacancy.screeningAnswers,
        );
        const exactMapped = exactVacancyAnswer
          ? reusableScreeningAnswer(field.question, exactVacancyAnswer)
          : null;
        if (exactMapped?.canAutoFill) {
          return [[field.question.id, exactMapped] as const];
        }
        const answer = knownScreeningAnswer(field.question, salaryExpectation, resumeText);
        return answer ? [[field.question.id, answer] as const] : [];
      }),
    );
    const reviewFallback = (question: HhScreeningQuestion): HhScreeningAnswer => (
      localScreeningDraft(question, vacancy.title, vacancy.company)
      ?? buildHhScreeningReviewDraft(question, {
        vacancyTitle: vacancy.title,
        vacancyCompany: vacancy.company,
        resumeText,
      })
    );
    let generatedAnswers: HhScreeningAnswer[] = fields.map((field) => (
      reviewFallback(field.question)
    ));
    const transientQuestionIds = new Set<string>();
    const transientFailureDetails = new Set<string>();
    if (resumeLoadError) transientFailureDetails.add(resumeLoadError.slice(0, 180));
    if (this.generateScreeningAnswers) {
      const pendingForAi = fields.filter((field) => !knownAnswers.has(field.question.id));
      const pendingGroups = new Map<string, typeof pendingForAi>();
      for (const field of pendingForAi) {
        const key = screeningQuestionSemanticKey(field.question.prompt);
        const group = pendingGroups.get(key) ?? [];
        group.push(field);
        pendingGroups.set(key, group);
      }
      const representatives = [...pendingGroups.values()].map((group) => group[0]);
      const batches = Array.from(
        { length: Math.ceil(representatives.length / 6) },
        (_, index) => representatives.slice(index * 6, index * 6 + 6),
      );
      const batchResults = await allSettledWithConcurrency(batches, 2, (batch) =>
        this.generateScreeningAnswers!({
          vacancyTitle: vacancy.title,
          vacancyCompany: vacancy.company,
          vacancyDescription: vacancy.description ?? '',
          resumeText,
          questions: batch.map((field) => field.question),
          confirmedAnswers,
          language: 'ru',
        }));
      const byId = new Map(generatedAnswers.map((answer) => [answer.id, answer]));
      batchResults.forEach((result, batchIndex) => {
        const batch = batches[batchIndex] ?? [];
        if (result.status === 'fulfilled') {
          for (const answer of result.value.answers) {
            const representative = batch.find((field) => field.question.id === answer.id);
            if (!representative) continue;
            const fallbackAnswer = reviewFallback(representative.question);
            const usefulAnswer = isUsableHhScreeningDraft(representative.question, answer)
              ? answer
              : {
                  ...fallbackAnswer,
                  reason: answer.reason?.trim() || fallbackAnswer.reason,
                };
            byId.set(answer.id, usefulAnswer);
            const group = pendingGroups.get(screeningQuestionSemanticKey(representative.question.prompt)) ?? [];
            for (const duplicate of group) {
              if (duplicate.question.id === answer.id) continue;
              const mapped = reusableScreeningAnswer(duplicate.question, {
                question: representative.question.prompt,
                answer: usefulAnswer.answer,
                selectedOptions: usefulAnswer.selectedOptions,
              });
              if (mapped) {
                byId.set(duplicate.question.id, {
                  ...mapped,
                  // Reusing the value for an equivalent field must never
                  // promote a review-only model suggestion to automatic
                  // submission. Only the representative answer's verified
                  // autofill decision may authorize its duplicates.
                  canAutoFill: usefulAnswer.canAutoFill,
                  reason: usefulAnswer.reason,
                  preparationNote: usefulAnswer.preparationNote,
                });
              }
            }
          }
          return;
        }
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        for (const field of batch) {
          const group = pendingGroups.get(screeningQuestionSemanticKey(field.question.prompt)) ?? [field];
          for (const duplicate of group) {
            byId.set(duplicate.question.id, reviewFallback(duplicate.question));
          }
        }
        if (reason.trim()) transientFailureDetails.add(reason.trim().slice(0, 180));
      });
      generatedAnswers = [...byId.values()];
      if (batches.length === 0) {
        generatedAnswers = fields.map((field) => knownAnswers.get(field.question.id)!).filter(Boolean);
      }
    }

    // A user-entered answer is authoritative. Preference keys deliberately keep
    // relocation inside Russia separate from international relocation.
    const confirmedByMeaning = new Map<string, HhStoredScreeningAnswer>();
    for (const item of this.state.screeningFacts) {
      confirmedByMeaning.set(screeningQuestionSemanticKey(item.question), {
        questionId: '',
        question: item.question,
        answer: item.answer,
        selectedOptions: item.selectedOptions,
      });
    }
    for (const item of vacancy.screeningAnswers ?? []) {
      if (item.confirmedByUser !== true) continue;
      confirmedByMeaning.set(screeningQuestionSemanticKey(item.question), item);
    }
    const generatedById = new Map(generatedAnswers.map((answer) => [answer.id, answer]));
    const mergedAnswers = fields.map((field): HhScreeningAnswer => {
      const exactVacancyAnswer = findExactVacancyScreeningAnswer(
        field.question,
        vacancy.screeningAnswers,
      );
      const exactMapped = exactVacancyAnswer
        ? reusableScreeningAnswer(field.question, exactVacancyAnswer)
        : null;
      if (exactMapped?.canAutoFill) return exactMapped;
      const confirmed = confirmedByMeaning.get(screeningQuestionSemanticKey(field.question.prompt))
        ?? findReusableScreeningFact(field.question, confirmedByMeaning.values());
      if (isSalaryRelatedQuestion(field.question.prompt)) {
        // Salary is scoped to the configured expectation or the exact résumé
        // selected for this vacancy. A global remembered value can belong to a
        // different résumé and therefore is never automatic provenance.
        return knownAnswers.get(field.question.id)
          ?? generatedById.get(field.question.id)
          ?? reviewFallback(field.question);
      }
      if (isCurrentLocationQuestion(field.question.prompt)) {
        // City and salary from the résumé selected for this exact vacancy are
        // newer and more contextual than a globally remembered answer. A city
        // remembered under another résumé is useful only as a review draft,
        // never as automatic provenance for this vacancy.
        return knownAnswers.get(field.question.id)
          ?? generatedById.get(field.question.id)
          ?? reviewFallback(field.question);
      }
      if (!confirmed) {
        return knownAnswers.get(field.question.id)
          ?? generatedById.get(field.question.id)
          ?? reviewFallback(field.question);
      }
      return reusableScreeningAnswer(field.question, confirmed)
        ?? knownAnswers.get(field.question.id)
        ?? generatedById.get(field.question.id)
        ?? reviewFallback(field.question);
    });
    const preparationNotes = [...new Set(mergedAnswers
      .filter((answer) => answer.canAutoFill)
      .map((answer) => answer.preparationNote?.replace(/\s+/g, ' ').trim() ?? '')
      .filter(Boolean))].slice(0, 20);
    const result = await fillHhScreeningFields(page, fields, mergedAnswers);
    if (result.unresolved.length > 0) {
      const unresolvedById = new Map(result.unresolved.map((item) => [item.id, item]));
      const answerById = new Map(mergedAnswers.map((answer) => [answer.id, answer]));
      const partition = partitionUnresolvedScreeningQuestions(
        fields.map((field) => field.question),
        new Set(unresolvedById.keys()),
        transientQuestionIds,
      );
      const pendingQuestions = partition.pendingQuestions.map((question) => {
        const unresolved = unresolvedById.get(question.id);
        const suggestion = answerById.get(question.id);
        return {
          ...question,
          assistantReason: unresolved?.reason,
          suggestedAnswer: suggestion?.answer || undefined,
          suggestedOptions: suggestion?.selectedOptions.length
            ? suggestion.selectedOptions
            : undefined,
        };
      });
      if (partition.transientUnresolved > 0) {
        const detail = [...transientFailureDetails][0];
        const manualSuffix = pendingQuestions.length > 0
          ? ` Ещё ${pendingQuestions.length} ${pendingQuestions.length === 1 ? 'ответ требует' : 'ответа требуют'} вашего подтверждения.`
          : '';
        return {
          ok: false,
          failureKind: 'transient',
          reason: `Временно не удалось подготовить ${partition.transientUnresolved} ${partition.transientUnresolved === 1 ? 'ответ работодателю' : 'ответа работодателю'}${detail ? `: ${detail}` : '.'}${manualSuffix}`,
          pendingQuestions: pendingQuestions.length > 0 ? pendingQuestions : undefined,
          preparationNotes,
        };
      }
      return {
        ok: false,
        failureKind: 'manual',
        reason: pendingEmployerQuestionsReason(pendingQuestions.length),
        pendingQuestions,
        preparationNotes,
      };
    }
    return {
      ok: result.filled === fields.length,
      reason: `Ответы работодателю заполнены: ${result.filled}.`,
      preparationNotes,
    };
  }

  private async captureVacancyDescription(
    page: Page,
    vacancy: HhQueueItem,
  ): Promise<string> {
    const stored = String(vacancy.description ?? '').replace(/\s+/g, ' ').trim();
    const workFormat = vacancy.platform === 'hh'
      ? compactHhText(
        await page.locator('[data-qa="work-formats-text"]').first()
          .innerText({ timeout: 2_000 }).catch(() => ''),
      )
      : '';
    const withWorkFormat = (description: string): string => {
      if (!workFormat || description.toLocaleLowerCase('ru').includes(workFormat.toLocaleLowerCase('ru'))) {
        return description.slice(0, 12_000);
      }
      return `${description}\n${workFormat}`.slice(0, 12_000);
    };
    if (stored.length >= 80) {
      const description = withWorkFormat(stored);
      if (description !== stored) {
        vacancy.description = description;
        this.patchQueue(vacancy.key, { description });
      }
      return description;
    }

    await page
      .locator(PLATFORM_INFO[vacancy.platform].descriptions.join(', '))
      .first()
      .waitFor({ state: 'visible', timeout: 5_000 })
      .catch(() => undefined);
    const description = withWorkFormat((
      await firstText(page, PLATFORM_INFO[vacancy.platform].descriptions)
    ));
    if (description.length >= 80) {
      vacancy.description = description;
      this.patchQueue(vacancy.key, { description });
      return description;
    }
    return stored;
  }

  private async prepareCoverLetter(
    page: Page,
    vacancy: HhQueueItem,
  ): Promise<PreparedHhCoverLetter> {
    const cached = this.preparedCoverLetters.get(vacancy.key);
    if (cached) return { ok: true, letter: cached };
    if (!this.generateCoverLetter) {
      return {
        ok: false,
        reason: 'Персональное письмо сейчас недоступно. Проверьте вакансию и добавьте письмо вручную.',
        retry: 'manual',
      };
    }
    const vacancyDescription = await this.captureVacancyDescription(page, vacancy);
    if (vacancyDescription.length < 80) {
      return {
        ok: false,
        reason: 'Не удалось прочитать описание вакансии. Добавьте письмо вручную после проверки требований.',
        retry: 'manual',
      };
    }

    this.update({
      phase: 'applying',
      currentVacancyId: vacancy.key,
      message: `Сопоставляю резюме с вакансией «${vacancy.title}» и готовлю письмо…`,
    });
    let response: HhCoverLetterResponse;
    let request: HhCoverLetterRequest;
    try {
      const resumeText = await this.getSelectedResumeText(vacancy.title, {
        throwOnFailure: true,
        selectedResumeTitle: vacancy.selectedResumeTitle,
      });
      request = {
        vacancyTitle: vacancy.title,
        vacancyCompany: vacancy.company,
        vacancyDescription,
        resumeText,
        language: 'ru',
      };
      response = await this.generateCoverLetter(request);
    } catch (error) {
      return {
        ok: false,
        reason: `Не удалось подготовить персональное письмо: ${error instanceof Error ? error.message : String(error)}`,
        // Provider quota, timeout and transport failures are all retryable,
        // but only from a later daily run or an explicit manual retry. The
        // current run must stop instead of creating a 30-minute retry loop.
        retry: 'later',
      };
    }
    const validated = validateGeneratedHhCoverLetter(response, request);
    if (!validated) {
      return {
        ok: false,
        reason:
          response.reason?.trim()
          || 'Не найдено достаточно подтверждённых совпадений с вакансией. Проверьте письмо вручную.',
        retry: response.failureKind === 'skill_mismatch' ? 'never' : 'manual',
      };
    }
    this.preparedCoverLetters.set(vacancy.key, validated.letter);
    return { ok: true, letter: validated.letter };
  }

  private recordCoverLetterFailure(
    vacancy: HhQueueItem,
    failure: Extract<PreparedHhCoverLetter, { ok: false }>,
    prefix = '',
    coverLetterPending = false,
  ): HhApplyOutcome {
    const reason = `${prefix}${failure.reason}`;
    // A cover-letter failure belongs to this vacancy, not to the whole run.
    // Permanent/review-only failures are skipped automatically; transient
    // provider failures wait for the next daily run while the queue continues.
    const terminal = failure.retry === 'never' || failure.retry === 'manual';
    const autoRetryBlockedUntil = failure.retry === 'later'
      ? 'daily' as const
      : undefined;
    vacancy.coverLetterPending = terminal ? false : coverLetterPending;
    vacancy.coverLetterAdded = false;
    this.patchQueue(vacancy.key, {
      status: terminal ? 'skipped' : 'opened',
      reason,
      coverLetterPending: terminal ? false : coverLetterPending,
      coverLetterAdded: false,
      autoRetryBlockedUntil,
    });
    return { sent: false, blocked: false, reason, autoRetryBlockedUntil };
  }

  private async openVacancyChatFrame(
    page: Page,
    vacancy: HhQueueItem,
  ): Promise<Frame | null> {
    await page
      .locator(OPEN_VACANCY_CHAT_SELECTOR)
      .first()
      .waitFor({ state: 'visible', timeout: 6_000 })
      .catch(() => undefined);
    let opened = await this.clickFirstVisible(page, OPEN_VACANCY_CHAT_SELECTOR);
    if (!opened) {
      const button = page.locator(OPEN_VACANCY_CHAT_SELECTOR).first();
      if (await button.isVisible().catch(() => false)) {
        opened = await button.click({ timeout: 5_000, force: true })
          .then(() => true)
          .catch(() => false);
      }
    }
    if (!opened) return null;

    const expectedTitle = compactHhText(vacancy.title).toLocaleLowerCase('ru');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const frames = page.frames().filter((frame) => frame.url().includes(CHAT_FRAME_URL_PART));
      for (const frame of frames.reverse()) {
        const label = compactHhText(
          await frame.locator('body').innerText({ timeout: 1_500 }).catch(() => ''),
        ).toLocaleLowerCase('ru');
        if (!label) continue;
        if (!expectedTitle || label.includes(expectedTitle)) return frame;
        // The compact HH widget can shorten or omit the vacancy title. It is
        // still the only chat frame created by open-vacancy-chat on this freshly
        // navigated response page, so accept it when the application card is
        // present instead of waiting forever on a cosmetic header mismatch.
        if (/отклик на вакансию|добавить сопроводительное/i.test(label)) return frame;
      }
      await page.waitForTimeout(150);
    }
    return null;
  }

  private async openVacancyChatFromNegotiations(
    page: Page,
    vacancy: HhQueueItem,
  ): Promise<{ frame: Frame | null; rejected: boolean; found: boolean }> {
    const vacancyLinkSelector = `a[href*="/vacancy/${vacancy.id}"]`;
    for (let pageIndex = 0; pageIndex < 21; pageIndex += 1) {
      const target = pageIndex === 0
        ? HH_NEGOTIATIONS_URL
        : `${HH_NEGOTIATIONS_URL}?page=${pageIndex}`;
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page
        .locator(NEGOTIATION_ITEM_SELECTOR)
        .first()
        .waitFor({ state: 'attached', timeout: 7_000 })
        .catch(() => undefined);
      const vacancyLink = page.locator(vacancyLinkSelector).first();
      if (!(await vacancyLink.isVisible().catch(() => false))) continue;
      const item = vacancyLink
        .locator('xpath=ancestor::*[@data-qa="negotiations-item"][1]');
      const itemText = compactHhText(await item.innerText({ timeout: 2_000 }).catch(() => ''));
      const rejected = (await item.locator(NEGOTIATION_REJECTED_SELECTOR).count().catch(() => 0)) > 0
        || /^отказ(?:\s|$)/i.test(itemText);
      if (rejected) return { frame: null, rejected: true, found: true };

      const openChat = item.locator(NEGOTIATION_OPEN_CHAT_SELECTOR).first();
      if (!(await openChat.isVisible().catch(() => false))) {
        return { frame: null, rejected: false, found: true };
      }
      try {
        await openChat.click({ timeout: 5_000 });
      } catch {
        await openChat.click({ timeout: 5_000, force: true }).catch(() => undefined);
      }

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const frames = page.frames().filter((frame) => frame.url().includes(CHAT_FRAME_URL_PART));
        for (const frame of frames.reverse()) {
          const label = compactHhText(
            await frame.locator('body').innerText({ timeout: 1_500 }).catch(() => ''),
          );
          if (/отклик на вакансию|добавить сопроводительное/i.test(label)) {
            return { frame, rejected: false, found: true };
          }
        }
        await page.waitForTimeout(150);
      }
      return { frame: null, rejected: false, found: true };
    }
    return { frame: null, rejected: false, found: false };
  }

  private async attachPendingCoverLetterInChat(
    page: Page,
    vacancy: HhQueueItem,
  ): Promise<{
    attached: boolean;
    reason: string;
    terminal?: boolean;
    retryApplication?: boolean;
    coverLetterFailure?: Extract<PreparedHhCoverLetter, { ok: false }>;
  }> {
    const responseUrl = new URL('/applicant/vacancy_response', vacancy.url);
    responseUrl.searchParams.set('vacancyId', vacancy.id);
    if (page.url() !== responseUrl.href) {
      await page.goto(responseUrl.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
    if (page.url().includes('/account/login')) {
      return {
        attached: false,
        reason: 'Сессия HH истекла. Войдите в HH — письмо останется в очереди.',
      };
    }

    // The response action still exists, so there is no confirmed negotiation
    // to attach a letter to yet. Return to the normal application flow instead
    // of opening /applicant/negotiations and terminally hiding the vacancy.
    if (await hasVisible(page, RESPONSE_BUTTON_SELECTOR)) {
      return {
        attached: false,
        retryApplication: true,
        reason: 'HH показывает доступный отклик. Возвращаю вакансию к обычной отправке с сопроводительным письмом.',
      };
    }

    let frame = await this.openVacancyChatFrame(page, vacancy);
    if (!frame) {
      const fallback = await this.openVacancyChatFromNegotiations(page, vacancy);
      if (fallback.rejected) {
        return {
          attached: false,
          terminal: true,
          reason: 'Работодатель уже отказал по этой вакансии — сопроводительное письмо больше не отправляю.',
        };
      }
      if (!fallback.found) {
        return {
          attached: false,
          retryApplication: !vacancy.sentAt,
          terminal: Boolean(vacancy.sentAt),
          reason: vacancy.sentAt
            ? 'Ранее отправленный отклик больше не найден в активных переговорах HH.'
            : 'HH не подтвердил отправку отклика. Возвращаю вакансию в очередь и повторно проверю её страницу.',
        };
      }
      frame = fallback.frame;
    }
    if (!frame) {
      return {
        attached: false,
        reason: 'HH пока не открыл чат этого отклика. Повторю добавление сопроводительного письма автоматически.',
      };
    }

    const readChatBody = async (): Promise<string> => compactHhText(
      await frame.locator('body').innerText({ timeout: 2_000 }).catch(() => ''),
    );
    const addLetter = frame
      .locator(CHAT_ADD_COVER_LETTER_SELECTOR)
      .filter({ hasText: 'Добавить сопроводительное' })
      .first();
    const actionVisible = await addLetter.isVisible().catch(() => false);
    const initialBody = await readChatBody();
    if (!actionVisible && /без сопроводительного письма/i.test(initialBody)) {
      return {
        attached: false,
        reason: 'HH показывает отклик без письма, но ещё не отдал кнопку добавления. Повторю автоматически.',
      };
    }

    const generated = await this.prepareCoverLetter(page, vacancy);
    if (!generated.ok) {
      return {
        attached: false,
        reason: `Не удалось подготовить сопроводительное письмо: ${generated.reason}`,
        coverLetterFailure: generated,
      };
    }
    const expected = compactHhText(generated.letter).slice(0, 100);

    if (!actionVisible) {
      const messageTexts = await frame
        .locator(CHAT_MESSAGE_TEXT_SELECTOR)
        .allInnerTexts()
        .catch(() => [] as string[]);
      const exactLetterRendered = messageTexts.some((text) =>
        compactHhText(text).includes(expected));
      if (exactLetterRendered || initialBody.includes(expected)) {
        return {
          attached: true,
          reason: 'HH уже показывает подготовленное сопроводительное письмо в чате отклика.',
        };
      }
      return {
        attached: false,
        reason: 'HH не показал ни кнопку добавления, ни текст подготовленного письма. Повторю проверку автоматически.',
      };
    }

    try {
      await addLetter.click({ timeout: 5_000 });
    } catch {
      // The compact HH chat is rendered inside an iframe and can briefly be
      // covered by the parent-page transition. The control itself is already
      // verified visible, so retry the same semantic click without coordinates.
      await addLetter.click({ timeout: 5_000, force: true });
    }
    const preview = frame.locator(CHAT_COVER_LETTER_PREVIEW_SELECTOR).first();
    await preview.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    let previewText = compactHhText(await preview.innerText({ timeout: 1_500 }).catch(() => ''));
    if (!/сопроводительное письмо/i.test(previewText)) {
      await addLetter.click({ timeout: 5_000, force: true }).catch(() => undefined);
      await preview.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
      previewText = compactHhText(await preview.innerText({ timeout: 1_500 }).catch(() => ''));
    }
    if (!/сопроводительное письмо/i.test(previewText)) {
      return {
        attached: false,
        reason: 'HH не открыл режим сопроводительного письма в чате. Повторю автоматически.',
      };
    }

    const input = frame.locator(CHAT_INPUT_SELECTOR).first();
    await input.waitFor({ state: 'visible', timeout: 5_000 });
    await input.fill(generated.letter);
    if (compactHhText(await input.inputValue()) !== compactHhText(generated.letter)) {
      return {
        attached: false,
        reason: 'HH не принял текст сопроводительного письма в поле чата. Повторю автоматически.',
      };
    }

    const send = frame.locator(CHAT_SEND_SELECTOR).first();
    await send.waitFor({ state: 'visible', timeout: 5_000 });
    await send.click({ timeout: 5_000 });

    const verifyDeadline = Date.now() + 12_000;
    while (Date.now() < verifyDeadline) {
      const messageTexts = await frame
        .locator(CHAT_MESSAGE_TEXT_SELECTOR)
        .allInnerTexts()
        .catch(() => [] as string[]);
      const exactLetterRendered = messageTexts.some((text) =>
        compactHhText(text).includes(expected));
      const body = await readChatBody();
      const bodyHasExactLetter = body.includes(expected);
      if (exactLetterRendered || bodyHasExactLetter) {
        return {
          attached: true,
          reason: 'Отклик и сопроводительное письмо подтверждены в чате HH.',
        };
      }
      await page.waitForTimeout(200);
    }
    return {
      attached: false,
      reason: 'HH не подтвердил появление сопроводительного письма в чате. Не считаю отклик завершённым и повторю проверку.',
    };
  }

  private async finishPendingCoverLetter(
    page: Page,
    vacancy: HhQueueItem,
  ): Promise<HhApplyOutcome> {
    const result = await this.attachPendingCoverLetterInChat(page, vacancy);
    if (!result.attached) {
      if (result.coverLetterFailure) {
        return this.recordCoverLetterFailure(
          vacancy,
          result.coverLetterFailure,
          'Не удалось добавить сопроводительное письмо: ',
          true,
        );
      }
      if (result.retryApplication) {
        vacancy.coverLetterPending = false;
        vacancy.coverLetterAdded = false;
        vacancy.sentAt = undefined;
        this.patchQueue(vacancy.id, {
          status: 'new',
          reason: result.reason,
          sentAt: undefined,
          coverLetterPending: false,
          coverLetterAdded: false,
        });
        return { sent: false, blocked: false, reason: result.reason };
      }
      if (result.terminal) {
        vacancy.coverLetterPending = false;
        this.patchQueue(vacancy.id, {
          status: 'skipped',
          reason: result.reason,
          coverLetterPending: false,
          coverLetterAdded: false,
        });
        return { sent: false, blocked: false, reason: result.reason };
      }
      vacancy.coverLetterPending = true;
      this.patchQueue(vacancy.id, {
        status: 'opened',
        reason: result.reason,
        coverLetterPending: true,
        coverLetterAdded: false,
      });
      return { sent: false, blocked: false, reason: result.reason };
    }

    vacancy.coverLetterPending = false;
    vacancy.coverLetterAdded = true;
    this.patchQueue(vacancy.id, {
      status: 'sent',
      reason: result.reason,
      sentAt: vacancy.sentAt ?? nowIso(),
      pendingQuestions: undefined,
      screeningAnswers: undefined,
      coverLetterPending: false,
      coverLetterAdded: true,
    });
    return { sent: true, blocked: false, reason: result.reason };
  }

  private async applyToVacancy(
    vacancy: HhQueueItem,
    options: { explicitUserSelection?: boolean } = {},
  ): Promise<HhApplyOutcome> {
    const page = await this.ensureBrowser('background');
    const persistedResumeTitle = vacancy.selectedResumeTitle?.trim() ?? '';
    const preferredResume = await this.preferredApplicantResume(
      vacancy.title,
      persistedResumeTitle,
    );
    if (!preferredResume && (persistedResumeTitle || this.applicantResumes.length > 0)) {
      const terminal = this.applicantResumes.length > 0;
      const reason = terminal
        ? 'Пропущено автоматически: среди актуальных резюме HH не удалось однозначно выбрать подходящее.'
        : 'Не удалось загрузить актуальные резюме HH. Автоматически повторю позже.';
      this.patchQueue(vacancy.id, {
        status: terminal ? 'skipped' : 'opened',
        reason,
        autoRetryBlockedUntil: terminal ? undefined : 'daily',
      });
      return {
        sent: false,
        blocked: false,
        reason,
        autoRetryBlockedUntil: terminal ? undefined : 'daily',
      };
    }
    if (preferredResume) {
      vacancy.selectedResumeTitle = preferredResume.title;
      this.patchQueue(vacancy.id, { selectedResumeTitle: preferredResume.title });
    }
    if (hhVacancyId(page.url()) !== vacancy.id) {
      await page.goto(vacancy.url, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
    }
    const vacancyDescription = await this.captureVacancyDescription(page, vacancy);
    if (!vacancy.coverLetterPending) {
      const duplicate = findHhSemanticDuplicate(this.state.queue, vacancy, vacancyDescription);
      if (duplicate) {
        const reason = `Пропущено перед откликом: у работодателя «${vacancy.company}» уже есть вакансия с тем же описанием (HH ${duplicate.id}). Повторный автоотклик не отправляю.`;
        this.patchQueue(vacancy.id, {
          status: 'skipped',
          reason,
          coverLetterPending: false,
          coverLetterAdded: false,
        });
        return { sent: false, blocked: false, reason };
      }
    }
    const searchResumeContext = options.explicitUserSelection
      ? ''
      : await this.getConfiguredSearchResumeContext();
    if (!options.explicitUserSelection
      && !isVacancyRelevantToSearchProfile(
        vacancy,
        this.state.config.query,
        vacancyDescription,
        searchResumeContext,
      )) {
      const reason = 'Пропущено перед откликом: вакансия не соответствует выбранному резюме и направлению поиска.';
      this.patchQueue(vacancy.id, {
        status: 'skipped',
        reason,
        coverLetterPending: false,
        coverLetterAdded: false,
      });
      return { sent: false, blocked: false, reason };
    }
    if (!options.explicitUserSelection
      && !isVacancyCompatibleWithSearchSchedule(vacancy, this.state.config.schedule, vacancyDescription)) {
      const reason = 'Пропущено перед откликом: вакансия явно требует работу только в офисе.';
      this.patchQueue(vacancy.id, {
        status: 'skipped',
        reason,
        coverLetterPending: false,
        coverLetterAdded: false,
      });
      return { sent: false, blocked: false, reason };
    }
    const baseCtx: HhApplyContext = {
      ...this.buildApplyContext(),
      responseClicked: Boolean(vacancy.coverLetterPending),
      responseSubmitted: Boolean(vacancy.coverLetterPending),
    };
    if (vacancy.coverLetterPending && !vacancy.coverLetterAdded) {
      // The live page is authoritative. If HH still offers the response
      // action, the persisted post-response marker was false or interrupted.
      if (await hasVisible(page, RESPONSE_BUTTON_SELECTOR)) {
        vacancy.coverLetterPending = false;
        vacancy.coverLetterAdded = false;
        vacancy.sentAt = undefined;
        baseCtx.responseClicked = false;
        baseCtx.responseSubmitted = false;
        this.patchQueue(vacancy.id, {
          status: 'new',
          reason: 'HH показывает доступный отклик. Продолжаю обычную отправку с письмом.',
          sentAt: undefined,
          coverLetterPending: false,
          coverLetterAdded: false,
        });
      } else {
        return this.finishPendingCoverLetter(page, vacancy);
      }
    }

    let lastSituation: HhApplySituation = 'unknown';
    let repeatedSituation = 0;
    let finalSubmitClicked = false;
    for (let step = 0; step < 12; step += 1) {
      const situation = await this.detectApplySituation(page, baseCtx);
      repeatedSituation = situation === lastSituation ? repeatedSituation + 1 : 0;
      lastSituation = situation;
      if (repeatedSituation >= 2) {
        const reason = finalSubmitClicked
          ? 'Финальная кнопка нажата один раз, но HH пока не подтвердил отклик. Не нажимаю повторно; проверю статус при следующем ежедневном или ручном запуске.'
          : `HH не изменил форму после нескольких попыток. Последнее состояние: ${situation}.`;
        this.patchQueue(vacancy.id, {
          status: 'opened',
          reason,
          autoRetryBlockedUntil: finalSubmitClicked ? 'daily' : undefined,
        });
        return { sent: false, blocked: false, reason };
      }
      const decided = decideNextAction(situation, baseCtx);
      switch (decided.action) {
        case 'wait_letter':
          vacancy.coverLetterPending = true;
          this.patchQueue(vacancy.id, {
            status: 'opened',
            reason: decided.reason,
            coverLetterPending: true,
            coverLetterAdded: false,
          });
          return this.finishPendingCoverLetter(page, vacancy);
        case 'mark_sent': {
          if (
            baseCtx.hasCoverLetter
            && !baseCtx.letterFilled
            && (baseCtx.responseClicked || baseCtx.responseSubmitted)
          ) {
            vacancy.coverLetterPending = true;
            this.patchQueue(vacancy.id, {
              status: 'opened',
              reason: 'Отклик принят HH, но письмо ещё не подтверждено. Проверяю и добавляю его отдельно.',
              coverLetterPending: true,
              coverLetterAdded: false,
            });
            return this.finishPendingCoverLetter(page, vacancy);
          }
          if (situation === 'already_applied') {
            if (baseCtx.letterFilled) {
              this.patchQueue(vacancy.id, {
                status: 'sent',
                reason: 'Отклик и сопроводительное письмо отправлены',
                sentAt: nowIso(),
                pendingQuestions: undefined,
                screeningAnswers: undefined,
                coverLetterPending: false,
                coverLetterAdded: true,
              });
              return {
                sent: true,
                blocked: false,
                reason: 'Отклик и сопроводительное письмо отправлены.',
              };
            }
            this.patchQueue(vacancy.id, {
              status: vacancy.status === 'sent' && vacancy.sentAt ? 'sent' : 'already_applied',
              reason: vacancy.status === 'sent' && vacancy.sentAt
                ? vacancy.reason
                : 'HH подтверждает: отклик уже был отправлен ранее.',
              pendingQuestions: undefined,
              screeningAnswers: undefined,
            });
            return {
              sent: false,
              alreadyApplied: true,
              blocked: false,
              reason: 'Отклик уже был отправлен ранее — не считаю его новым.',
            };
          }
          const sentReason = baseCtx.letterFilled
            ? 'Отклик и сопроводительное письмо отправлены'
            : 'Отклик отправлен';
          this.patchQueue(vacancy.id, {
            status: 'sent',
            reason: sentReason,
            sentAt: nowIso(),
            pendingQuestions: undefined,
            screeningAnswers: undefined,
            coverLetterPending: false,
            coverLetterAdded: baseCtx.letterFilled || vacancy.coverLetterAdded || undefined,
          });
          return {
            sent: true,
            blocked: false,
            reason: `${sentReason}.`,
          };
        }
        case 'skip':
          this.patchQueue(vacancy.id, {
            status: decided.reason === 'Не удалось распознать состояние страницы HH.'
              ? 'opened'
              : 'skipped',
            reason: decided.reason,
          });
          return { sent: false, blocked: false, reason: decided.reason };
        case 'wait_user':
          this.patchQueue(vacancy.id, {
            status: 'opened',
            reason: decided.reason,
            autoRetryBlockedUntil: 'manual',
          });
          this.update({
            phase: 'manual_required',
            browserOpen: true,
            currentVacancyId: vacancy.id,
            message: decided.reason,
          });
          return {
            sent: false,
            blocked: true,
            reason: decided.reason,
            autoRetryBlockedUntil: 'manual',
          };
        case 'click_response': {
          if (baseCtx.hasCoverLetter) {
            const generated = await this.prepareCoverLetter(page, vacancy);
            if (!generated.ok) {
              return this.recordCoverLetterFailure(vacancy, generated, 'Отклик не начат: ');
            }
          }
          const clicked = await this.openResponseForm(page);
          if (!clicked) {
            this.patchQueue(vacancy.id, {
              status: 'opened',
              reason: 'Не удалось нажать «Откликнуться». Вакансия останется в очереди для повторной проверки.',
            });
            return {
              sent: false,
              blocked: false,
              reason: 'Не удалось нажать «Откликнуться». Повторю при следующем запуске.',
            };
          }
          await page.waitForTimeout(jitterMs(1));
          finalSubmitClicked = false;
          baseCtx.responseClicked = true;
          break;
        }
        case 'select_resume':
          {
            const preferredResume = await this.preferredApplicantResume(
              vacancy.title,
              vacancy.selectedResumeTitle,
            );
            const selectedTitles = preferredResume
              ? [preferredResume.title]
              : vacancy.selectedResumeTitle
                ? [vacancy.selectedResumeTitle]
                : this.state.config.resumeTitles.length > 0
                  ? this.state.config.resumeTitles
                  : [this.state.config.resumeTitleContains].filter(Boolean);
            const selectedResumeTitle = await this.selectPreferredResume(
              page,
              selectedTitles,
              vacancy.title,
            );
            vacancy.selectedResumeTitle = selectedResumeTitle;
            vacancy.selectedResumeVerified = true;
            this.patchQueue(vacancy.id, { selectedResumeTitle, selectedResumeVerified: true });
          }
          finalSubmitClicked = false;
          baseCtx.resumeSelected = true;
          break;
        case 'open_letter': {
          if (situation === 'post_response_letter_offer') baseCtx.responseSubmitted = true;
          const opened = await this.clickFirstVisible(page, ADD_COVER_LETTER_SELECTOR);
          if (!opened) throw new Error('HH не показал кнопку добавления сопроводительного письма.');
          await page
            .locator(LETTER_SELECTOR)
            .first()
            .waitFor({ state: 'visible', timeout: 5_000 });
          finalSubmitClicked = false;
          break;
        }
        case 'fill_letter': {
          const textarea = page.locator(LETTER_SELECTOR).first();
          const generated = await this.prepareCoverLetter(page, vacancy);
          if (!generated.ok) {
            return this.recordCoverLetterFailure(
              vacancy,
              generated,
              baseCtx.responseSubmitted
                ? 'Не удалось добавить сопроводительное письмо автоматически: '
                : '',
              baseCtx.responseSubmitted,
            );
          }
          await textarea.fill(generated.letter);
          if ((await textarea.inputValue()).trim() !== generated.letter.trim()) {
            throw new Error('HH не принял текст сопроводительного письма.');
          }
          finalSubmitClicked = false;
          baseCtx.letterFilled = true;
          break;
        }
        case 'fill_questions': {
          let result: {
            ok: boolean;
            reason: string;
            failureKind?: 'manual' | 'transient';
            pendingQuestions?: HhScreeningQuestion[];
            preparationNotes?: string[];
          };
          try {
            result = await this.fillEmployerQuestions(page, vacancy);
          } catch (error) {
            result = {
              ok: false,
              failureKind: 'transient',
              reason: `Не удалось подготовить ответы работодателю: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
          if (!result.ok) {
            const needsInput = Boolean(result.pendingQuestions?.length);
            const transientFailure = result.failureKind === 'transient';
            const manualFormBlock = result.failureKind === 'manual' && !needsInput;
            const blockedFailure = transientFailure || manualFormBlock;
            const autoRetryBlockedUntil = blockedFailure
              ? transientFailure && !needsInput
                ? 'daily' as const
                : 'manual' as const
              : undefined;
            const status: HhQueueStatus = needsInput
              ? 'needs_input'
              : blockedFailure
                ? 'opened'
                : 'prepared';
            const preparationNotes = [...new Set([
              ...(vacancy.preparationNotes ?? []),
              ...(result.preparationNotes ?? []),
            ])].slice(-20);
            this.patchQueue(vacancy.id, {
              status,
              reason: result.reason,
              pendingQuestions: result.pendingQuestions,
              preparationNotes: preparationNotes.length > 0 ? preparationNotes : undefined,
              autoRetryBlockedUntil,
            });
            this.update({
              phase: 'manual_required',
              browserOpen: true,
              currentVacancyId: vacancy.id,
              message: result.reason,
            });
            return {
              sent: false,
              // Provider failures are isolated to this vacancy by the
              // persisted retry gate. Keep processing the rest of the queue;
              // only a form that genuinely requires manual navigation should
              // hard-stop the current run.
              blocked: manualFormBlock,
              reason: result.reason,
              autoRetryBlockedUntil,
            };
          }
          finalSubmitClicked = false;
          baseCtx.questionsFilled = true;
          const preparationNotes = [...new Set([
            ...(vacancy.preparationNotes ?? []),
            ...(result.preparationNotes ?? []),
          ])].slice(-20);
          this.patchQueue(vacancy.id, {
            status: 'prepared',
            reason: result.reason,
            pendingQuestions: undefined,
            preparationNotes: preparationNotes.length > 0 ? preparationNotes : undefined,
          });
          break;
        }
        case 'click_confirm': {
          // A slow HH transition can leave the same visible submit button in
          // the DOM after the click. Never issue a second external submit in
          // one attempt; wait for a success/letter state, then defer safely.
          if (finalSubmitClicked) {
            await page.waitForTimeout(jitterMs(0.4));
            break;
          }
          if (baseCtx.hasCoverLetter && !baseCtx.letterFilled) {
            const generated = await this.prepareCoverLetter(page, vacancy);
            if (!generated.ok) {
              return this.recordCoverLetterFailure(vacancy, generated, 'Отклик не отправлен: ');
            }
          }
          const clicked = await this.clickFirstVisible(page, RESPONSE_SUBMIT_SELECTOR);
          if (!clicked) throw new Error('HH не показал финальную кнопку отклика.');
          finalSubmitClicked = true;
          baseCtx.responseSubmitted = true;
          await page.waitForTimeout(jitterMs(1));
          break;
        }
      }
      await page
        .waitForLoadState('domcontentloaded', { timeout: STEP_NAVIGATION_TIMEOUT })
        .catch(() => undefined);
      await page.waitForTimeout(jitterMs(0.6));
    }

    this.patchQueue(vacancy.id, {
      status: 'opened',
      reason: `HH не подтвердил отправку отклика. Последнее состояние формы: ${lastSituation}.`,
    });
    return {
      sent: false,
      blocked: false,
      reason: 'HH не подтвердил отправку. Вакансия оставлена во вкладке «Нужно разобрать» для повторной проверки.',
    };
  }

  private async runQueue(runId?: string, scopedKeys?: ReadonlySet<string>): Promise<QueueRunStats> {
    if (this.applyInFlight) {
      return { total: 0, attempted: 0, sent: 0, alreadyApplied: 0, skipped: 0, needsAttention: 0, stopped: false, blocked: false };
    }
    this.applyInFlight = true;
    let sentNow = 0;
    const licensePlan = await this.getLicensePlan?.().catch(() => 'trial') ?? 'trial';
    const runDailyLimit = effectiveDailyLimit(this.state.config.dailyLimit, licensePlan);
    this.activeDailyLimit = runDailyLimit;
    const runLimitConfig = { dailyLimit: runDailyLimit };
    const runTrigger = runId
      ? this.state.runHistory.find((run) => run.id === runId)?.trigger
      : undefined;
    const runMode: HhQueueRunMode = runTrigger === 'resume'
      ? 'queue'
      : runTrigger === 'schedule'
        ? 'daily'
        : 'manual';
    const diagnosticSource: HhAutomationDiagnosticSource = runTrigger === 'resume'
      ? 'queue_resume'
      : runTrigger === 'schedule' ? 'daily_search' : 'manual';
    const initial = this.state.queue.filter(
      (item) => item.platform === 'hh'
        && isQueueItemEligibleForRun(item, runMode)
        && (!scopedKeys || scopedKeys.has(item.key)),
    );
    const total = initial.length;
    if (total === 0) {
      this.applyInFlight = false;
      this.update({
        phase: 'ready', applying: false, applyProgress: null,
        message: this.state.lastScanSummary
          ? scanSummaryMessage(this.state.lastScanSummary)
          : 'Очередь проверена: новых вакансий для автоотклика нет.',
      });
      return { total: 0, attempted: 0, sent: 0, alreadyApplied: 0, skipped: 0, needsAttention: 0, stopped: false, blocked: false };
    }

    let done = 0;
    let alreadyAppliedNow = 0;
    let skippedNow = 0;
    let needsAttention = 0;
    let dailyLimitReached = false;
    let hardBlocked = false;
    let blockerReason = '';
    this.update({
      phase: 'applying', browserOpen: true, applying: true,
      applyProgress: { done: 0, total },
      message: 'Начинаю авто-отклики…',
    });
    this.progressRun(runId, {
      found: this.lastScanFoundCount,
      attempted: 0,
      sent: 0,
      alreadyApplied: 0,
      skipped: 0,
      needsAttention: 0,
      message: `Проверяю вакансии и отправляю отклики: 0 из ${total}`,
    });

    for (const item of initial) {
      if (this.stopApplyRequested) break;
      const onlyFinishingAcceptedResponse = Boolean(
        item.coverLetterPending && !item.coverLetterAdded,
      );
      if (!onlyFinishingAcceptedResponse && !canSendMore(runLimitConfig, this.state.queue)) {
        dailyLimitReached = true;
        break;
      }
      this.update({
        currentVacancyId: item.id,
        applyProgress: { done, total },
        message: `Откликаюсь на «${item.title}»… (${done + 1}/${total})`,
      });
      this.progressRun(runId, {
        attempted: done,
        sent: sentNow,
        alreadyApplied: alreadyAppliedNow,
        skipped: skippedNow,
        needsAttention,
        message: `Вакансия ${done + 1} из ${total}: ${item.title}`,
      });
      this.recordAutomationDiagnostic('vacancy_started', diagnosticSource, 'queue_item_started', {
        runId,
        vacancy: {
          key: item.key,
          title: item.title,
          company: item.company,
          status: item.status,
          gate: item.autoRetryBlockedUntil,
          blocked: false,
        },
      });
      if (item.autoRetryBlockedUntil) {
        item.autoRetryBlockedUntil = undefined;
        this.patchQueue(item.key, { autoRetryBlockedUntil: undefined });
      }
      let outcome: HhApplyOutcome;
      try {
        outcome = await this.applyToVacancy(item);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const reason = `Неожиданная ошибка при обработке вакансии: ${detail}`;
        const fatal = isFatalHhQueueError(error, this.state.loginRequired);
        this.patchQueue(item.key, {
          status: 'opened',
          reason,
          autoRetryBlockedUntil: fatal ? 'manual' : 'daily',
        });
        outcome = {
          sent: false,
          alreadyApplied: false,
          blocked: fatal,
          reason,
          autoRetryBlockedUntil: fatal ? 'manual' : 'daily',
        };
      }
      if (outcome.sent) sentNow += 1;
      if (outcome.alreadyApplied) alreadyAppliedNow += 1;
      const updatedItem = this.state.queue.find((candidate) => candidate.key === item.key);
      if (!outcome.sent && updatedItem?.status === 'skipped') skippedNow += 1;
      if (
        updatedItem?.status === 'needs_input'
        || updatedItem?.autoRetryBlockedUntil
        || outcome.blocked
      ) needsAttention += 1;
      if (outcome.blocked && !updatedItem?.autoRetryBlockedUntil) {
        this.patchQueue(item.key, {
          autoRetryBlockedUntil: outcome.autoRetryBlockedUntil ?? 'manual',
        });
      }
      this.recordAutomationDiagnostic('vacancy_finished', diagnosticSource, outcome.reason, {
        runId,
        vacancy: {
          key: item.key,
          title: item.title,
          company: item.company,
          status: updatedItem?.status ?? item.status,
          gate: updatedItem?.autoRetryBlockedUntil ?? outcome.autoRetryBlockedUntil,
          blocked: outcome.blocked,
        },
      });
      done += 1;
      this.update({ applyProgress: { done, total } });
      this.progressRun(runId, {
        attempted: done,
        sent: sentNow,
        alreadyApplied: alreadyAppliedNow,
        skipped: skippedNow,
        needsAttention,
        message: `Проверено ${done} из ${total} · отправлено сейчас ${sentNow} · уже было ${alreadyAppliedNow}`,
      });
      if (outcome.blocked) {
        hardBlocked = true;
        blockerReason = outcome.reason;
        break;
      }
      if (this.stopApplyRequested) break;
    }

    const stopped = this.stopApplyRequested;
    this.applyInFlight = false;
    this.stopApplyRequested = false;
    const remaining = this.state.queue.filter(
      (item) => item.platform === 'hh'
        && isQueueItemEligibleForRun(item, runMode)
        && (!scopedKeys || scopedKeys.has(item.key)),
    ).length;
    this.update({
      phase: hardBlocked && !stopped ? 'manual_required' : 'ready',
      applying: false,
      stopRequested: false,
      queuePaused: stopped || this.state.queuePaused,
      applyProgress: null,
      message: stopped
        ? `Поиск и автоотклики остановлены вами. Уже завершённые действия сохранены. Осталось в очереди: ${remaining}.`
        : hardBlocked
        ? blockerReason
        : dailyLimitReached
        ? `Дневной лимит выполнен: отправлено сегодня ${runDailyLimit}. Осталось в очереди: ${remaining}. Продолжу автоматически после сброса лимита.`
        : `Сессия завершена: ${
         sentNow > 0 ? `отправлено сейчас ${sentNow}` : 'новых отправок нет'
       } из ${done}. ${alreadyAppliedNow > 0 ? `Уже были отправлены: ${alreadyAppliedNow}. ` : ''}${needsAttention > 0 ? `Требуют внимания: ${needsAttention}. ` : ''}${remaining > 0 ? `Осталось в очереди: ${remaining}.` : 'Очередь пуста.'}`,
    });
    if (hardBlocked) {
      // A manual run can start while an older queue-resume timer is still
      // armed. Cancel it as well as avoiding a new timer for this failure.
      this.clearQueueResumeTimer();
    } else if (remaining > 0 && !stopped) {
      this.scheduleQueueResume(this.queueRetryDelayMs());
    }
    return {
      total,
      attempted: done,
      sent: sentNow,
      alreadyApplied: alreadyAppliedNow,
      skipped: skippedNow,
      needsAttention,
      stopped,
      blocked: hardBlocked && !stopped,
    };
  }

  async applyAll(): Promise<HhAssistantState> {
    if (this.applyInFlight || this.automationRunInFlight) return this.getState();
    this.stopApplyRequested = false;
    this.update({ stopRequested: false, queuePaused: false });
    void this.runQueue();
    return this.getState();
  }

  async suggestScreeningAnswer(
    vacancyId: string,
    questionId: string,
    currentAnswer?: string,
  ): Promise<HhScreeningDraftSuggestion> {
    const vacancy = this.state.queue.find((item) => item.key === vacancyId || item.id === vacancyId);
    if (!vacancy || vacancy.platform !== 'hh') {
      throw new Error('Вакансия с вопросом работодателя не найдена.');
    }
    const question = (vacancy.pendingQuestions ?? []).find((item) => item.id === questionId);
    if (!question) throw new Error('Этот вопрос уже обработан или больше не существует.');
    const existingDraft = question.kind === 'text'
      ? String(currentAnswer ?? '').trim().slice(0, 2_000)
      : '';

    const normalizeSuggestion = (
      answer: Pick<HhScreeningAnswer, 'answer' | 'selectedOptions'> | null | undefined,
      source: HhScreeningDraftSuggestion['source'],
      note: string,
    ): HhScreeningDraftSuggestion | null => {
      if (!answer) return null;
      const text = String(answer.answer ?? '').trim().slice(0, 2_000);
      const selectedOptions = matchScreeningOptionLabels(
        { answer: text, selectedOptions: answer.selectedOptions ?? [] },
        question.options,
        question.kind === 'multiple',
      );
      // Closed sensitive questions may intentionally return a review note with
      // no preselected option. This is still a successful suggestion request:
      // the editor keeps the exact choices visible instead of throwing.
      const valid = question.kind === 'text'
        ? Boolean(text)
        : selectedOptions.length > 0 || Boolean(text);
      return valid ? {
        questionId: question.id,
        answer: text,
        selectedOptions,
        source,
        note,
      } : null;
    };

    if (
      existingDraft
      && !isCurrentLocationQuestion(question.prompt)
      && !isSalaryRelatedQuestion(question.prompt)
    ) {
      const resumeText = await this.getSelectedResumeText(vacancy.title, {
        selectedResumeTitle: vacancy.selectedResumeTitle,
      });
      const confirmedAnswers = selectRelevantScreeningFacts(
        this.state.screeningFacts,
        [question],
        30,
      ).filter((fact) => (
        !isSalaryRelatedQuestion(fact.question)
        && !(vacancy.selectedResumeTitle?.trim() && isCurrentLocationQuestion(fact.question))
      )).map((fact) => ({
        question: fact.question,
        answer: fact.answer,
        selectedOptions: fact.selectedOptions,
      }));
      let generationError = '';
      if (this.generateScreeningAnswers) {
        try {
          const generated = await this.generateScreeningAnswers({
            vacancyTitle: vacancy.title,
            vacancyCompany: vacancy.company,
            vacancyDescription: vacancy.description ?? '',
            resumeText,
            questions: [question],
            confirmedAnswers,
            draftMode: true,
            existingDraft: {
              questionId: question.id,
              answer: existingDraft,
            },
            language: 'ru',
          });
          const answer = generated.answers.find((item) => item.id === question.id);
          if (answer) {
            const suggestion = normalizeSuggestion(
              answer,
              'ai',
              'SkillCue улучшил ваш текст, сохранив исходный смысл и факты. Проверьте итоговую формулировку.',
            );
            if (suggestion) return suggestion;
          }
        } catch (error) {
          generationError = error instanceof Error ? error.message : String(error);
        }
      }

      const polished = polishScreeningDraftLocally(existingDraft);
      if (polished && polished !== existingDraft) {
        return {
          questionId: question.id,
          answer: polished,
          selectedOptions: [],
          source: 'local',
          note: generationError
            ? 'Онлайн-ИИ сейчас недоступен, поэтому применена только базовая правка регистра, пробелов и пунктуации. Смысл ответа не менялся.'
            : 'Применена базовая редактура без изменения смысла ответа.',
        };
      }
      return {
        questionId: question.id,
        answer: existingDraft,
        selectedOptions: [],
        source: 'local',
        note: generationError
          ? 'Онлайн-ИИ сейчас недоступен. Ваш исходный ответ сохранён без изменений и готов для дальнейшего редактирования.'
          : 'Ваш ответ уже достаточно аккуратный; SkillCue сохранил его без изменения фактов и смысла.',
      };
    }

    const exactFact = this.state.screeningFacts.find(
      (fact) => screeningQuestionSemanticKey(fact.question) === screeningQuestionSemanticKey(question.prompt),
    );
    const exactVacancyAnswer = findExactVacancyScreeningAnswer(
      question,
      vacancy.screeningAnswers,
    );
    if (exactVacancyAnswer) {
      const mapped = reusableScreeningAnswer(question, exactVacancyAnswer);
      const suggestion = normalizeSuggestion(
        mapped,
        'profile',
        'Использован ответ, который вы уже подтвердили именно для этой вакансии.',
      );
      if (suggestion) return suggestion;
    }
    const reusableProfileFact = exactFact
      ?? findReusableScreeningFact(question, this.state.screeningFacts);
    const factMatchesExactPrompt = Boolean(exactFact)
      && screeningQuestionKey(exactFact!.question) === screeningQuestionKey(question.prompt);
    if (
      reusableProfileFact
      && (!isCurrentLocationQuestion(question.prompt) || !vacancy.selectedResumeTitle?.trim())
      && !isSalaryRelatedQuestion(question.prompt)
    ) {
      const reusable = reusableScreeningAnswer(question, reusableProfileFact);
      const currentCityNeedsResumeConfirmation = isCurrentLocationQuestion(question.prompt);
      const suggestion = normalizeSuggestion(
        reusable ?? (factMatchesExactPrompt ? reusableProfileFact : null),
        currentCityNeedsResumeConfirmation ? 'local' : 'profile',
        currentCityNeedsResumeConfirmation
          ? 'Город найден в ранее сохранённом ответе, но резюме для этой вакансии ещё не подтверждено. Проверьте значение.'
          : 'Ответ найден в вашем подтверждённом профиле. Проверьте, что он по-прежнему актуален.',
      );
      if (suggestion) return suggestion;
    }

    const resumeTitleSources = resumeTitleFactSources(
      vacancy.selectedResumeTitle,
      this.state.config.resumeTitles,
    );
    const resumeTitleContext = resumeTitleSources.join('\n').trim();
    const titleSalaryExpectation = findSalaryExpectation(
      null,
      resumeTitleSources,
    );
    const titleKnown = knownScreeningAnswer(
      question,
      titleSalaryExpectation,
      resumeTitleContext,
    );
    if (titleKnown) {
      const suggestion = normalizeSuggestion(
        titleKnown,
        'profile',
        'SkillCue составил ответ из данных выбранного резюме. Проверьте формулировку перед сохранением.',
      );
      if (suggestion) return suggestion;
    }

    let resumeText = resumeTitleContext;
    let resumeLoadError = '';
    try {
      if (isCurrentLocationQuestion(question.prompt) && !this.context) {
        await this.ensureBrowser('background');
      }
      resumeText = await this.getSelectedResumeText(vacancy.title, {
        throwOnFailure: Boolean(vacancy.selectedResumeTitle),
        selectedResumeTitle: vacancy.selectedResumeTitle,
      });
    } catch (error) {
      resumeLoadError = error instanceof Error ? error.message : String(error);
    }
    const salaryExpectation = findSalaryExpectation(
      null,
      selectedResumeFactSources(
        vacancy.selectedResumeTitle,
        resumeText,
        this.state.config.resumeTitles,
      ),
    );
    const known = knownScreeningAnswer(question, salaryExpectation, resumeText);
    if (known) {
      const suggestion = normalizeSuggestion(
        known,
        'profile',
        'SkillCue составил ответ из подтверждённых данных резюме. Проверьте формулировку перед сохранением.',
      );
      if (suggestion) return suggestion;
    }

    if (
      exactFact
      && !isSalaryRelatedQuestion(question.prompt)
      && (!isCurrentLocationQuestion(question.prompt)
        || !vacancy.selectedResumeTitle?.trim())
    ) {
      const reusable = reusableScreeningAnswer(question, exactFact);
      const suggestion = normalizeSuggestion(
        reusable ?? (factMatchesExactPrompt ? exactFact : null),
        'profile',
        'В выбранном резюме город не указан, поэтому использован подтверждённый ответ из профиля. Проверьте, что он по-прежнему актуален.',
      );
      if (suggestion) return suggestion;
    }

    let generationError = resumeLoadError;
    if (this.generateScreeningAnswers) {
      const confirmedAnswers = selectRelevantScreeningFacts(
        this.state.screeningFacts,
        [question],
        30,
      ).map((fact) => ({
        question: fact.question,
        answer: fact.answer,
        selectedOptions: fact.selectedOptions,
      }));
      try {
        const generated = await this.generateScreeningAnswers({
          vacancyTitle: vacancy.title,
          vacancyCompany: vacancy.company,
          vacancyDescription: vacancy.description ?? '',
          resumeText,
          questions: [question],
          confirmedAnswers,
          draftMode: true,
          language: 'ru',
        });
        const answer = generated.answers.find((item) => item.id === question.id);
        if (answer) {
          const suggestion = normalizeSuggestion(
            answer,
            'ai',
            'Это ИИ-предположение, а не подтверждённый факт. Отредактируйте всё, что не соответствует вашему опыту.',
          );
          if (suggestion) return suggestion;
        }
      } catch (error) {
        generationError = error instanceof Error ? error.message : String(error);
      }
    }

    const fallback = localScreeningDraft(question, vacancy.title, vacancy.company)
      ?? buildHhScreeningReviewDraft(question, {
        vacancyTitle: vacancy.title,
        vacancyCompany: vacancy.company,
        resumeText,
      });
    return normalizeSuggestion(
      fallback,
      'local',
      generationError
        ? 'Онлайн-генератор сейчас недоступен. SkillCue подготовил локальный черновик; неподтверждённые личные сведения нужно проверить.'
        : 'SkillCue подготовил локальный черновик. Проверьте личные сведения перед сохранением.',
    )!;
  }

  async answerScreeningQuestions(
    vacancyId: string,
    rawAnswers: unknown,
  ): Promise<HhAssistantState> {
    const vacancy = this.state.queue.find((item) => item.key === vacancyId || item.id === vacancyId);
    if (!vacancy || vacancy.platform !== 'hh') {
      this.update({ phase: 'error', message: 'Вакансия с вопросами работодателя не найдена.' });
      return this.getState();
    }
    const questions = vacancy.pendingQuestions ?? [];
    if (questions.length === 0) {
      this.update({ message: 'Для этой вакансии больше нет вопросов, ожидающих ответа.' });
      return this.getState();
    }
    if (!Array.isArray(rawAnswers)) {
      this.update({ phase: 'manual_required', message: 'Ответы не сохранены: заполните все вопросы.' });
      return this.getState();
    }
    const submitted = new Map<string, Record<string, unknown>>();
    for (const raw of rawAnswers) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      submitted.set(String(item.questionId ?? ''), item);
    }
    const accepted: HhStoredScreeningAnswer[] = [];
    const remembered: HhStoredScreeningAnswer[] = [];
    const submittedAnswers = new Map<string, HhStoredScreeningAnswer>();
    const submittedByMeaning = new Map<string, HhStoredScreeningAnswer>();
    for (const question of questions) {
      const item = submitted.get(question.id);
      if (!item) continue;
      const answer = String(item?.answer ?? '').trim().slice(0, 2_000);
      const selectedOptions = matchScreeningOptionLabels(
        {
          answer,
          selectedOptions: Array.isArray(item?.selectedOptions)
            ? item.selectedOptions.map((option) => String(option))
            : [],
        },
        question.options,
        question.kind === 'multiple',
      );
      const valid = question.kind === 'text' ? Boolean(answer) : selectedOptions.length > 0;
      if (!valid) {
        this.update({
          phase: 'manual_required',
          message: `Заполните вопрос: ${question.prompt.slice(0, 180)}`,
        });
        return this.getState();
      }
      const stored = {
        questionId: question.id,
        question: question.prompt,
        answer,
        selectedOptions,
        confirmedByUser: true,
      };
      submittedAnswers.set(question.id, stored);
      submittedByMeaning.set(screeningQuestionSemanticKey(question.prompt), stored);
      if (item?.remember) remembered.push(stored);
    }

    for (const question of questions) {
      const direct = submittedAnswers.get(question.id);
      if (direct) {
        accepted.push(direct);
        continue;
      }
      const reusable = submittedByMeaning.get(screeningQuestionSemanticKey(question.prompt))
        ?? findReusableScreeningFact(question, submittedByMeaning.values());
      const mapped = reusable && reusableScreeningAnswer(question, reusable);
      if (!mapped?.canAutoFill) {
        this.update({
          phase: 'manual_required',
          message: `Заполните вопрос: ${question.prompt.slice(0, 180)}`,
        });
        return this.getState();
      }
      accepted.push({
        questionId: question.id,
        question: question.prompt,
        answer: mapped.answer,
        selectedOptions: mapped.selectedOptions,
        confirmedByUser: true,
      });
    }

    const vacancyAnswers = new Map(
      (vacancy.screeningAnswers ?? []).map((answer) => [screeningQuestionSemanticKey(answer.question), answer]),
    );
    for (const answer of accepted) vacancyAnswers.set(screeningQuestionSemanticKey(answer.question), answer);

    const facts = new Map(
      this.state.screeningFacts.map((fact) => [screeningQuestionSemanticKey(fact.question), fact]),
    );
    for (const answer of remembered) {
      const key = screeningQuestionSemanticKey(answer.question);
      const previous = facts.get(key);
      facts.set(key, {
        id: previous?.id ?? `fact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        question: answer.question,
        answer: answer.answer,
        selectedOptions: answer.selectedOptions,
        updatedAt: nowIso(),
      });
    }
    this.state.screeningFacts = [...facts.values()].slice(-100);
    const reusableAnswers = new Map(
      remembered
        // Salary and current city are scoped to the exact résumé/vacancy. A
        // remembered value remains available as a review hint, but must never
        // become a user-confirmed answer on other queued applications.
        .filter((answer) => (
          !isSalaryRelatedQuestion(answer.question)
          && !isCurrentLocationQuestion(answer.question)
        ))
        .map((answer) => [screeningQuestionSemanticKey(answer.question), answer]),
    );
    let reusedVacancies = 0;
    if (reusableAnswers.size > 0) {
      this.state.queue = this.state.queue.map((item) => {
        if (item.key === vacancy.key || item.status !== 'needs_input' || !item.pendingQuestions?.length) {
          return item;
        }
        const reused: HhStoredScreeningAnswer[] = [];
        const pendingQuestions = item.pendingQuestions.filter((question) => {
          const reusable = reusableAnswers.get(screeningQuestionSemanticKey(question.prompt))
            ?? findReusableScreeningFact(question, reusableAnswers.values());
          if (!reusable) return true;
          const mapped = reusableScreeningAnswer(question, reusable);
          if (!mapped?.canAutoFill) return true;
          reused.push({
            questionId: question.id,
            question: question.prompt,
            answer: mapped.answer,
            selectedOptions: mapped.selectedOptions,
            confirmedByUser: true,
          });
          return false;
        });
        if (reused.length === 0) return item;
        reusedVacancies += 1;
        const answers = new Map(
          (item.screeningAnswers ?? []).map((answer) => [screeningQuestionSemanticKey(answer.question), answer]),
        );
        for (const answer of reused) answers.set(screeningQuestionSemanticKey(answer.question), answer);
        return {
          ...item,
          status: pendingQuestions.length === 0 ? 'prepared' as const : 'needs_input' as const,
          reason: pendingQuestions.length === 0
            ? 'Ответ из профиля применён автоматически. Вакансия вернулась в очередь.'
            : `Повторяющиеся ответы применены. Осталось уточнить: ${pendingQuestions.length}.`,
          pendingQuestions: pendingQuestions.length > 0 ? pendingQuestions : undefined,
          screeningAnswers: [...answers.values()].slice(-60),
          autoRetryBlockedUntil: pendingQuestions.length === 0
            ? undefined
            : item.autoRetryBlockedUntil,
        };
      });
    }
    this.patchQueue(vacancy.key, {
      status: 'prepared',
      reason: 'Ответы подтверждены. Возвращаюсь к форме HH…',
      pendingQuestions: undefined,
      screeningAnswers: [...vacancyAnswers.values()].slice(-60),
      autoRetryBlockedUntil: undefined,
    });
    this.update({
      message: reusedVacancies > 0
        ? `Ответы сохранены и применены ещё к ${reusedVacancies} ${reusedVacancies === 1 ? 'вакансии' : 'вакансиям'}. Продолжаю отклики.`
        : 'Ответы сохранены. Продолжаю отклик на эту вакансию.',
    });
    if (this.applyInFlight) {
      this.scheduleQueueResume(2_000);
      return this.getState();
    }
    const next = await this.applyOne(vacancy.key);
    this.scheduleQueueResume(2_000);
    return next;
  }

  forgetScreeningFact(factId: string): HhAssistantState {
    const next = this.state.screeningFacts.filter((fact) => fact.id !== factId);
    if (next.length === this.state.screeningFacts.length) return this.getState();
    this.update({ screeningFacts: next, message: 'Сохранённый ответ удалён.' });
    return this.getState();
  }

  async runNow(
    trigger: Exclude<HhAutomationRunTrigger, 'direct_link' | 'resume'> = 'manual',
  ): Promise<HhAssistantState> {
    if (this.applyInFlight || this.automationRunInFlight) {
      this.update({ message: 'Предыдущий прогон ещё выполняется.' });
      return this.getState();
    }
    this.automationRunInFlight = true;
    const run = this.beginRun(trigger);
    try {
      await this.scan(this.state.config.platform, run.id);
      if (this.stopApplyRequested) {
        const message = this.state.message || 'Поиск и автоотклики остановлены вами.';
        this.stopApplyRequested = false;
        this.update({
          phase: 'ready',
          applying: false,
          stopRequested: false,
          queuePaused: true,
          applyProgress: null,
          message,
        });
        this.finishRun(run.id, {
          status: 'stopped',
          found: this.lastScanFoundCount,
          message,
        });
        return this.getState();
      }
      if (this.state.phase === 'error' || this.state.phase === 'manual_required') {
        const status: HhAutomationRunStatus = this.state.phase === 'error' ? 'failed' : 'attention';
        this.finishRun(run.id, {
          status,
          found: this.lastScanFoundCount,
          needsAttention: status === 'attention' ? 1 : 0,
          message: this.state.message,
        });
        return this.getState();
      }
      if (this.state.config.platform === 'hh' && !this.state.config.autoSend) {
        const queued = this.pendingQueueCount();
        const message = queued > 0
          ? `Найденные вакансии добавлены в очередь: ${queued}. Проверьте их и отправляйте отклики по одному.`
          : 'Поиск завершён: новых подходящих вакансий для очереди нет.';
        this.update({ phase: 'ready', applying: false, applyProgress: null, message });
        this.finishRun(run.id, {
          status: 'completed',
          found: this.lastScanFoundCount,
          attempted: 0,
          sent: 0,
          message,
        });
        return this.getState();
      }
      const stats = this.state.config.platform === 'hh'
        ? await this.runQueue(run.id)
        : { total: 0, attempted: 0, sent: 0, alreadyApplied: 0, skipped: 0, needsAttention: 0, stopped: false, blocked: false };
      this.finishRun(run.id, {
        status: stats.stopped ? 'stopped' : stats.needsAttention > 0 ? 'attention' : 'completed',
        found: this.lastScanFoundCount,
        attempted: stats.attempted,
        sent: stats.sent,
        alreadyApplied: stats.alreadyApplied,
        skipped: stats.skipped,
        needsAttention: stats.needsAttention,
        message: this.state.message,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.stopApplyRequested) {
        const stoppedMessage = 'Поиск и автоотклики остановлены вами. Уже завершённые действия сохранены.';
        this.stopApplyRequested = false;
        this.update({
          phase: 'ready',
          applying: false,
          stopRequested: false,
          queuePaused: true,
          applyProgress: null,
          message: stoppedMessage,
        });
        this.finishRun(run.id, { status: 'stopped', found: this.lastScanFoundCount, message: stoppedMessage });
      } else {
        this.fail(error);
        this.finishRun(run.id, { status: 'failed', found: this.lastScanFoundCount, message });
      }
    } finally {
      this.automationRunInFlight = false;
    }
    return this.getState();
  }

  async applyOne(
    vacancyId: string,
    options: { explicitUserSelection?: boolean } = {},
  ): Promise<HhAssistantState> {
    const vacancy = this.state.queue.find((item) => item.key === vacancyId || item.id === vacancyId);
    if (!vacancy) {
      this.update({ phase: 'error', message: 'Вакансия не найдена в очереди.' });
      return this.getState();
    }
    if (vacancy.platform !== 'hh') {
      return this.openVacancy(vacancy.key);
    }
    if (this.applyInFlight) return this.getState();
    if (this.stopApplyRequested) {
      this.stopApplyRequested = false;
      this.update({
        phase: 'ready',
        applying: false,
        stopRequested: false,
        queuePaused: true,
        message: 'Отклик остановлен вами до отправки.',
      });
      return this.getState();
    }
    this.applyInFlight = true;
    if (vacancy.autoRetryBlockedUntil) {
      vacancy.autoRetryBlockedUntil = undefined;
      this.patchQueue(vacancy.key, { autoRetryBlockedUntil: undefined });
    }
    this.update({
      phase: 'applying',
      applying: true,
      currentVacancyId: vacancy.id,
      message: `Откликаюсь на «${vacancy.title}»…`,
    });
    let outcome: HhApplyOutcome;
    try {
      outcome = await this.applyToVacancy(vacancy, options);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const reason = `Неожиданная ошибка при обработке вакансии: ${detail}`;
      const fatal = isFatalHhQueueError(error, this.state.loginRequired);
      this.patchQueue(vacancy.key, {
        status: 'opened',
        reason,
        autoRetryBlockedUntil: fatal ? 'manual' : 'daily',
      });
      outcome = {
        sent: false,
        blocked: fatal,
        reason,
        autoRetryBlockedUntil: fatal ? 'manual' : 'daily',
      };
    }
    const stopped = this.stopApplyRequested;
    this.stopApplyRequested = false;
    this.applyInFlight = false;
    if (outcome.blocked) {
      const current = this.state.queue.find((item) => item.key === vacancy.key);
      if (!current?.autoRetryBlockedUntil) {
        this.patchQueue(vacancy.key, {
          autoRetryBlockedUntil: outcome.autoRetryBlockedUntil ?? 'manual',
        });
      }
      this.clearQueueResumeTimer();
    }
    this.update({
      phase: outcome.blocked && !stopped ? 'manual_required' : 'ready',
      applying: false,
      stopRequested: false,
      queuePaused: stopped || this.state.queuePaused,
      message: stopped
        ? 'Автоотклики остановлены вами. Текущая вакансия завершена, следующие не обрабатываются.'
        : outcome.reason,
    });
    if (this.queueResumePendingCount() === 0) this.clearQueueResumeTimer();
    return this.getState();
  }

  stopApply(): HhAssistantState {
    if (!this.applyInFlight && !this.automationRunInFlight && !this.queueResumeRunning) {
      return this.getState();
    }
    this.stopApplyRequested = true;
    this.clearQueueResumeTimer();
    const message = this.state.phase === 'scanning'
      ? 'Останавливаю поиск после текущей страницы…'
      : this.applyInFlight
        ? 'Останавливаю автоотклики после текущей вакансии…'
        : 'Останавливаю текущий запуск…';
    this.update({
      stopRequested: true,
      queuePaused: true,
      message,
    });
    return this.getState();
  }

  private pendingQueueCount(): number {
    return this.state.queue.filter(
      (item) => item.platform === 'hh' && isActionableQueueItem(item),
    ).length;
  }

  private queueResumePendingCount(): number {
    return this.state.queue.filter(
      (item) => item.platform === 'hh' && isQueueItemEligibleForRun(item, 'queue'),
    ).length;
  }

  private clearQueueResumeTimer(): void {
    if (!this.queueResumeTimer) return;
    clearTimeout(this.queueResumeTimer);
    this.queueResumeTimer = null;
    this.queueResumeTimerReason = '';
    this.state.nextQueueResumeAt = null;
  }

  private queueRetryDelayMs(): number {
    if (canSendMore({ dailyLimit: this.activeDailyLimit }, this.state.queue)) return 30 * 60 * 1_000;
    const nextDay = new Date();
    nextDay.setDate(nextDay.getDate() + 1);
    nextDay.setHours(0, 5, 0, 0);
    return Math.max(60_000, nextDay.getTime() - Date.now());
  }

  private scheduleQueueResume(
    delayMs = 30 * 60 * 1_000,
    reason = 'pending_queue_retry',
  ): void {
    this.clearQueueResumeTimer();
    const skippedReason = !this.state.config.autoSend
      ? 'auto_send_disabled'
      : this.state.config.platform !== 'hh'
        ? 'platform_not_hh'
        : this.queueResumePendingCount() === 0
          ? 'no_eligible_queue_items'
          : this.state.loginRequired
            ? 'hh_login_required'
            : this.state.queuePaused ? 'queue_paused' : '';
    if (skippedReason) {
      this.recordAutomationDiagnostic('timer_skipped', 'queue_resume', `${reason}:${skippedReason}`);
      return;
    }
    const boundedDelay = Math.max(1_000, delayMs);
    const scheduledFor = new Date(Date.now() + boundedDelay).toISOString();
    this.queueResumeTimerReason = reason;
    this.state.nextQueueResumeAt = scheduledFor;
    this.recordAutomationDiagnostic('timer_scheduled', 'queue_resume', reason, {
      scheduledFor,
      delayMs: boundedDelay,
    });
    this.queueResumeTimer = setTimeout(() => {
      this.queueResumeTimer = null;
      this.state.nextQueueResumeAt = null;
      const firedReason = this.queueResumeTimerReason || reason;
      this.queueResumeTimerReason = '';
      this.recordAutomationDiagnostic('timer_fired', 'queue_resume', firedReason, {
        scheduledFor,
        delayMs: boundedDelay,
      });
      void this.resumePendingQueue();
    }, boundedDelay);
    this.queueResumeTimer.unref?.();
    this.emitState(this.getState());
  }

  private async resumePendingQueue(): Promise<void> {
    if (this.state.queuePaused) return;
    if (this.queueResumeRunning || this.applyInFlight || this.automationRunInFlight) {
      this.scheduleQueueResume(30_000, 'automation_busy_retry');
      return;
    }
    if (this.queueResumePendingCount() === 0) return;
    this.clearQueueResumeTimer();
    this.queueResumeRunning = true;
    this.automationRunInFlight = true;
    const run = this.beginRun('resume');
    let queueRunBlocked = false;
    try {
      const stats = await this.runQueue(run.id);
      queueRunBlocked = stats.blocked;
      this.finishRun(run.id, {
        status: stats.stopped ? 'stopped' : stats.needsAttention > 0 ? 'attention' : 'completed',
        found: stats.total,
        attempted: stats.attempted,
        sent: stats.sent,
        alreadyApplied: stats.alreadyApplied,
        skipped: stats.skipped,
        needsAttention: stats.needsAttention,
        message: this.state.message,
      });
    } catch (error) {
      queueRunBlocked = true;
      const message = error instanceof Error ? error.message : String(error);
      this.fail(error);
      this.finishRun(run.id, { status: 'failed', message });
    } finally {
      this.automationRunInFlight = false;
      this.queueResumeRunning = false;
      if (
        !queueRunBlocked
        && this.queueResumePendingCount() > 0
        && !this.state.loginRequired
        && !this.state.queuePaused
      ) {
        this.scheduleQueueResume(
          this.queueRetryDelayMs(),
          canSendMore({ dailyLimit: this.activeDailyLimit }, this.state.queue)
            ? 'pending_queue_retry'
            : 'daily_limit_reset',
        );
      }
    }
  }

  private clearScheduleTimer(): void {
    if (this.scheduleTimer) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    this.state.nextRunAt = null;
  }

  startDailySchedule(announce = true): void {
    this.clearScheduleTimer();
    const config = this.state.config;
    if (!config.autoRunDaily) return;
    const lastScheduledRunAt = this.state.runHistory
      .find((run) => run.trigger === 'schedule')?.startedAt;
    const delay = nextDiscoveryRunDelayMs(config, lastScheduledRunAt, new Date());
    const nextRunAt = new Date(Date.now() + delay).toISOString();
    this.recordAutomationDiagnostic('timer_scheduled', 'daily_search', 'configured_daily_hour', {
      scheduledFor: nextRunAt,
      delayMs: delay,
    });
    this.scheduleTimer = setTimeout(() => {
      this.recordAutomationDiagnostic('timer_fired', 'daily_search', 'configured_daily_hour', {
        scheduledFor: nextRunAt,
        delayMs: delay,
      });
      void this.onScheduleTick();
    }, delay);
    this.update({
      nextRunAt,
      ...(announce
        ? { message: `Следующая автоматическая проверка новых вакансий: ${new Date(nextRunAt).toLocaleString('ru-RU')}.` }
        : {}),
    });
  }

  stopDailySchedule(): void {
    this.clearScheduleTimer();
  }

  private async onScheduleTick(): Promise<void> {
    if (this.scheduleRunning) return;
    this.scheduleRunning = true;
    try {
      if (this.state.config.query) await this.runNow('schedule');
    } finally {
      this.scheduleRunning = false;
      if (this.state.config.autoRunDaily) {
        this.startDailySchedule(false);
      }
    }
  }

  mark(vacancyId: string, status: Extract<HhQueueStatus, 'sent' | 'skipped'>): HhAssistantState {
    this.patchQueue(vacancyId, {
      status,
      reason: status === 'sent' ? 'Подтверждено пользователем' : 'Пропущено пользователем',
      sentAt: status === 'sent' ? nowIso() : undefined,
      coverLetterPending: false,
      autoRetryBlockedUntil: undefined,
      ...(status === 'skipped' ? { coverLetterAdded: false } : {}),
    });
    this.update({
      message: status === 'sent' ? 'Отклик отмечен как отправленный.' : 'Вакансия пропущена.',
    });
    return this.getState();
  }

  private patchQueue(vacancyId: string, patch: Partial<HhQueueItem>): void {
    const terminal = patch.status === 'sent'
      || patch.status === 'already_applied'
      || patch.status === 'skipped';
    const normalizedPatch: Partial<HhQueueItem> = terminal
      ? {
          ...patch,
          pendingQuestions: undefined,
          screeningAnswers: undefined,
          autoRetryBlockedUntil: undefined,
        }
      : patch;
    this.state.queue = this.state.queue.map((item) =>
      item.key === vacancyId || item.id === vacancyId ? { ...item, ...normalizedPatch } : item,
    );
    this.persist();
  }

  async close(): Promise<void> {
    this.stopApplyRequested = true;
    this.automationRunInFlight = false;
    this.clearScheduleTimer();
    this.clearQueueResumeTimer();
    const context = this.context;
    const browser = this.browser;
    const browserProcess = this.browserProcess;
    this.browser = null;
    this.browserProcess = null;
    this.context = null;
    this.page = null;
    this.chatPage = null;
    this.browserMode = null;
    this.ensureBrowserPromise = null;
    this.chatPagePromise = null;
    fs.rmSync(path.join(this.profileDir, 'SkillCueDebugPort'), { force: true });
    if (browser) await settleWithin(browser.close(), 4_000);
    if (context) await settleWithin(context.close(), 1_000);
    await terminateBrowserProcessTree(browserProcess);
    await terminateOrphanedProfileBrowsers(this.profileDir);
    this.update({
      phase: 'idle',
      browserOpen: false,
      currentVacancyId: null,
      applying: false,
      applyProgress: null,
      message: 'Окно HH закрыто.',
    });
  }

  private fail(error: unknown): void {
    this.update({
      phase: 'error',
      browserOpen: Boolean(this.context),
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
