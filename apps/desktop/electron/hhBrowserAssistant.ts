import fs from 'fs';
import path from 'path';
import net from 'net';
import { spawn, type ChildProcess } from 'child_process';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import {
  buildHhSearchUrl,
  DEFAULT_HH_ASSISTANT_CONFIG,
  type HhAssistantConfig,
  type HhVacancy,
  normalizeHhAssistantConfig,
  normalizeHhVacancyUrl,
  renderCoverLetter,
  shouldExcludeVacancy,
} from './hhAssistantPolicy';
import {
  decideNextAction,
  jitterMs,
  nextAutoRunDelayMs,
  type HhApplyContext,
  type HhApplySituation,
} from './hhAutoApplyPolicy';

export type HhQueueStatus = 'new' | 'opened' | 'prepared' | 'sent' | 'skipped';
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
}

export interface HhApplicantResume {
  id: string;
  title: string;
  url: string;
}

export interface HhAssistantState {
  phase: HhAssistantPhase;
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

interface PersistedState {
  config: HhAssistantConfig;
  queue: unknown;
}

type EmitState = (state: HhAssistantState) => void;
type JobPlatform = 'hh' | 'linkedin' | 'avito';

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

const CARD_SELECTOR = '[data-qa="vacancy-serp__vacancy"]';
const TITLE_SELECTOR =
  '[data-qa="serp-item__title"], [data-qa="vacancy-serp__vacancy-title"]';
const COMPANY_SELECTOR =
  '[data-qa="vacancy-serp__vacancy-employer"], [data-qa="vacancy-serp__vacancy-employer-text"]';
const SALARY_SELECTOR =
  '[data-qa="vacancy-serp__vacancy-compensation"], [data-qa="vacancy-serp__vacancy-salary"]';
const LETTER_SELECTOR = '[data-qa="vacancy-response-popup-form-letter-input"]';
const ADD_COVER_LETTER_SELECTOR = '[data-qa="add-cover-letter"]';
const CAPTCHA_SELECTOR =
  '[data-qa*="captcha"], iframe[src*="captcha"], iframe[title*="captcha" i]';
const RESPONSE_QUESTION_SELECTOR = [
  '[data-qa*="vacancy-response-question"]',
  '[data-qa*="response-question"]',
  '[data-qa*="employer-question"]',
  '[data-qa*="screening-question"]',
  '[name^="question_"]',
  '[name*="employer_question"]',
].join(', ');
const RESPONSE_TEST_SELECTOR =
  '[data-qa*="vacancy-response-test"], [data-qa*="vacancy-test"]';
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
const APPLICANT_MENU_SELECTOR =
  '[data-qa="mainmenu_applicantProfile"], [data-qa="mainmenu_applicantProfileAndResumes"]';
const SUCCESS_SELECTOR =
  '[data-qa*="vacancy-response-request-success"], [data-qa*="response-success"]';
const STEP_NAVIGATION_TIMEOUT = 20_000;
const QUEUE_STATUSES = new Set<HhQueueStatus>([
  'new',
  'opened',
  'prepared',
  'sent',
  'skipped',
]);

function nowIso(): string {
  return new Date().toISOString();
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

function buildPlatformSearchUrl(platform: JobPlatform, config: HhAssistantConfig, page = 0): string {
  if (platform === 'hh') return buildHhSearchUrl(config, page);
  if (platform === 'linkedin') {
    const url = new URL('https://www.linkedin.com/jobs/search/');
    if (config.query) url.searchParams.set('keywords', config.query);
    if (config.linkedinLocation) url.searchParams.set('location', config.linkedinLocation);
    if (config.linkedinEasyApplyOnly) url.searchParams.set('f_AL', 'true');
    if (page) url.searchParams.set('start', String(page * 25));
    return url.toString();
  }
  const url = new URL(`https://www.avito.ru/${config.avitoCity || 'all'}/vakansii`);
  if (config.query) url.searchParams.set('q', config.query);
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

function installedBrowserCandidates(): Array<{ label: string; executable: string }> {
  const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(Boolean) as string[];
  const candidates = roots.map((root) => ({ label: 'Google Chrome', executable: path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe') }));
  candidates.push(...roots.map((root) => ({ label: 'Microsoft Edge', executable: path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe') })));
  return candidates.filter((candidate, index, all) => fs.existsSync(candidate.executable) && all.findIndex((item) => item.executable.toLowerCase() === candidate.executable.toLowerCase()) === index);
}

function profileDebugPort(profileDir: string): number | null {
  try {
    const customPath = path.join(profileDir, 'SkillCueDebugPort');
    const portFile = fs.existsSync(customPath) ? customPath : path.join(profileDir, 'DevToolsActivePort');
    const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/, 1)[0]);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch { return null; }
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

function normalizePersistedQueue(value: unknown): HhQueueItem[] {
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
      status: QUEUE_STATUSES.has(rawStatus) ? rawStatus : 'new',
      reason:
        typeof item.reason === 'string'
          ? item.reason.trim().slice(0, 300) || undefined
          : undefined,
      addedAt: Number.isNaN(Date.parse(addedAt)) ? nowIso() : addedAt,
      sentAt:
        typeof item.sentAt === 'string' && !Number.isNaN(Date.parse(item.sentAt))
          ? item.sentAt
          : undefined,
    });
    if (result.length >= 100) break;
  }
  return result;
}

export class HhBrowserAssistant {
  private browser: Browser | null = null;
  private browserProcess: ChildProcess | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private chatPage: Page | null = null;
  private readonly profileDir: string;
  private readonly statePath: string;
  private readonly emitState: EmitState;
  private state: HhAssistantState;
  private stopApplyRequested = false;
  private applyInFlight = false;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private scheduleRunning = false;

  constructor(userDataDir: string, emitState: EmitState) {
    this.profileDir = path.join(userDataDir, 'job-browser-profile-v2');
    this.statePath = path.join(userDataDir, 'hh-browser-assistant.json');
    this.emitState = emitState;
    const persisted = safeJsonRead<PersistedState>(this.statePath);
    this.state = {
      phase: 'idle',
      browserOpen: false,
      loginRequired: false,
      message: '',
      currentVacancyId: null,
      applying: false,
      applyProgress: null,
      config: normalizeHhAssistantConfig(
        persisted?.config ?? DEFAULT_HH_ASSISTANT_CONFIG,
      ),
      queue: normalizePersistedQueue(persisted?.queue),
      updatedAt: nowIso(),
    };
  }

  getState(): HhAssistantState {
    return structuredClone(this.state);
  }

  /** Отдать текущую страницу браузера (для Chat Browser). */
  async getPage(): Promise<Page | null> {
    if (this.page && !this.page.isClosed()) return this.page;
    try {
      return await this.ensureBrowser();
    } catch {
      return null;
    }
  }

  /**
   * Chat polling must never navigate the search/application tab. Keeping a
   * dedicated page also makes background HR checks independent of an open
   * response modal.
   */
  async getChatPage(): Promise<Page | null> {
    try {
      await this.ensureBrowser();
      if (!this.context) return null;
      if (this.chatPage && !this.chatPage.isClosed()) return this.chatPage;
      const chatPage = await this.context.newPage();
      this.chatPage = chatPage;
      chatPage.once('close', () => {
        if (this.chatPage === chatPage) this.chatPage = null;
      });
      return chatPage;
    } catch {
      return null;
    }
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
  saveConfig(value: Partial<HhAssistantConfig>): HhAssistantState {
    this.state.config = normalizeHhAssistantConfig({
      ...this.state.config,
      ...value,
    });
    if (this.state.config.autoRunDaily) {
      this.startDailySchedule();
    } else {
      this.stopDailySchedule();
    }
    this.update({ message: 'Настройки сохранены.' });
    return this.getState();
  }

  /** Поднимает таймер ежедневного авто-прогона после старта приложения. */
  restoreSchedule(): void {
    if (this.state.config.autoRunDaily) {
      this.startDailySchedule();
    }
  }

  /** Переключает ежедневный авто-прогон из UI. */
  setDailySchedule(enabled: boolean): HhAssistantState {
    this.state.config = normalizeHhAssistantConfig({
      ...this.state.config,
      autoRunDaily: enabled,
    });
    if (enabled) {
      this.startDailySchedule();
    } else {
      this.stopDailySchedule();
    }
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
          { config: this.state.config, queue: this.state.queue } satisfies PersistedState,
          null,
          2,
        ),
        'utf8',
      );
    } catch (error) {
      console.warn('[hh-assistant] state persistence failed:', error);
    }
  }

  private update(patch: Partial<HhAssistantState>): void {
    this.state = { ...this.state, ...patch, updatedAt: nowIso() };
    this.persist();
    this.emitState(this.getState());
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
    fs.rmSync(path.join(this.profileDir, 'SkillCueDebugPort'), { force: true });
    // Give Chrome a chance to flush session cookies before using taskkill as a
    // fallback. Killing first made a successful HH login disappear on restart.
    if (browser) await settleWithin(browser.close(), 4_000);
    if (context) await settleWithin(context.close(), 1_000);
    await terminateBrowserProcessTree(browserProcess);
  }

  private async launchInstalledBrowser(): Promise<BrowserContext> {
    fs.mkdirSync(this.profileDir, { recursive: true });
    const errors: string[] = [];
    const activePort = profileDebugPort(this.profileDir);
    if (activePort) {
      try {
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${activePort}`, { timeout: 2500 });
        const context = browser.contexts()[0];
        if (!context) throw new Error('браузер не вернул основной профиль');
        await this.injectStealthScript(context);
        this.browser = browser;
        return context;
      } catch (error) {
        errors.push(`existing browser: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const debugPortPath = path.join(this.profileDir, 'DevToolsActivePort');
    const skillCuePortPath = path.join(this.profileDir, 'SkillCueDebugPort');
    for (const candidate of installedBrowserCandidates()) {
      let child: ChildProcess | null = null;
      try {
        fs.rmSync(debugPortPath, { force: true });
        fs.rmSync(skillCuePortPath, { force: true });
        const debugPort = await allocateDebugPort();
        child = spawn(candidate.executable, [
          '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${this.profileDir}`,
          '--remote-allow-origins=*', '--disable-blink-features=AutomationControlled',
          '--no-first-run', '--no-default-browser-check', '--start-maximized', 'about:blank',
        ], { detached: false, stdio: 'ignore', windowsHide: false });
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
        fs.writeFileSync(skillCuePortPath, String(debugPort), 'utf8');
        return context;
      } catch (error) {
        if (child?.exitCode === null) child.kill();
        errors.push(`${candidate.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`Не удалось открыть обычный Chrome или Edge. ${errors.join(' | ')}`);
  }

  private async ensureBrowser(): Promise<Page> {
    if (this.context && this.page && !this.page.isClosed()) return this.page;
    if (this.context) {
      const existingContext = this.context;
      try {
        // Restored Chrome tabs can look healthy in /json yet never answer CDP
        // commands. A fresh target is cheap and avoids inheriting that renderer.
        this.page = await existingContext.newPage();
        return this.page;
      } catch {
        if (this.context === existingContext) this.context = null;
        this.page = null;
      }
    }
    const context = await this.launchInstalledBrowser();
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
    await this.injectStealthScript(context);
    this.update({ browserOpen: true, phase: 'browser_open' });
    return this.page;
  }

  private async openFreshHhLoginPage(): Promise<Page> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const previousPage = await this.ensureBrowser();
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
        await loginPage.bringToFront();

        for (const candidate of context.pages()) {
          if (candidate === loginPage || candidate.isClosed()) continue;
          const candidateUrl = candidate.url();
          const staleLoginPage =
            candidate === previousPage ||
            candidateUrl === 'about:blank' ||
            candidateUrl.includes('/account/login') ||
            isBrokenHhLoginSourcePage(candidateUrl);
          if (staleLoginPage) await settleWithin(candidate.close(), 1_500);
        }
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
      const page = await this.ensureBrowser();
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
      const page = await this.ensureBrowser();

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
      const page = await this.ensureBrowser();
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
    let page = await this.ensureBrowser();
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
          this.update({
            browserOpen: true,
            loginRequired: false,
            phase: 'ready',
            message: `Найдено резюме в HH: ${sessionResult.resumes.length}.`,
          });
          return sessionResult.resumes;
        }
      } catch (error) {
        lastError = error;
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
        page = await this.ensureBrowser();
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
    if (
      body.includes('ответьте на вопросы работодателя') ||
      body.includes('пройти тест для отклика') ||
      (await hasVisibleResponseFlowBlocker(page))
    ) {
      return 'Для этой вакансии нужны дополнительные ответы или тест.';
    }
    return null;
  }

  private async scrapeCurrentPage(page: Page): Promise<HhVacancy[]> {
    const cards = page.locator(CARD_SELECTOR);
    const count = Math.min(await cards.count(), 100);
    const result: HhVacancy[] = [];
    for (let index = 0; index < count; index += 1) {
      const card = cards.nth(index);
      const titleLink = card.locator(TITLE_SELECTOR).first();
      const title = (await titleLink.innerText().catch(() => '')).trim();
      const rawUrl = (await titleLink.getAttribute('href').catch(() => null)) ?? '';
      const url = normalizeHhVacancyUrl(rawUrl);
      const id = hhVacancyId(url);
      if (!id || !title || !url) continue;
      result.push({
        id,
        title,
        company: (
          await card.locator(COMPANY_SELECTOR).first().innerText().catch(() => '')
        ).trim(),
        salary: (
          await card.locator(SALARY_SELECTOR).first().innerText().catch(() => '')
        ).trim(),
        url,
      });
    }
    return result;
  }

  async scan(platformValue?: JobPlatform): Promise<HhAssistantState> {
    const platform = normalizePlatform(platformValue ?? this.state.config.platform);
    const info = PLATFORM_INFO[platform];
    if (!this.state.config.query) {
      this.update({
        phase: 'error',
        message: 'Укажите должность или специальность для поиска.',
      });
      return this.getState();
    }

    try {
      const page = await this.ensureBrowser();
      this.state.config = normalizeHhAssistantConfig({ ...this.state.config, platform });
      this.update({
        phase: 'scanning',
        browserOpen: true,
        message: 'Собираю вакансии из видимых страниц поиска…',
      });
      const collected = new Map<string, HhVacancy & { description?: string; easyApply?: boolean }>();
      for (let pageIndex = 0; pageIndex < this.state.config.maxPages; pageIndex += 1) {
        await page.goto(buildPlatformSearchUrl(platform, this.state.config, pageIndex), {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
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
        await page.locator(info.cards.join(', ')).first().waitFor({ timeout: 10_000 }).catch(() => undefined);
        const pageVacancies = platform === 'hh'
          ? (await this.scrapeCurrentPage(page)).map((vacancy) => ({ ...vacancy, description: '', easyApply: false }))
          : await extractPlatformCards(page, platform);
        if (pageVacancies.length === 0) break;
        for (const vacancy of pageVacancies) {
          if (shouldExcludeVacancy(vacancy, this.state.config)) continue;
          const key = jobKey(platform, vacancy.id);
          if (!collected.has(key)) collected.set(key, vacancy);
          if (collected.size >= this.state.config.maxQueueSize) break;
        }
        if (collected.size >= this.state.config.maxQueueSize) break;
      }

      const previous = new Map(this.state.queue.map((item) => [item.key, item]));
      const queue: HhQueueItem[] = [];
      for (const vacancy of collected.values()) {
        const key = jobKey(platform, vacancy.id);
        const old = previous.get(key);
        queue.push({
          ...vacancy,
          key,
          platform,
          status: old?.status ?? 'new',
          reason: old?.reason,
          addedAt: old?.addedAt ?? nowIso(),
        });
      }
      const foundCount = queue.length;
      const queuedIds = new Set(queue.map((item) => item.key));
      for (const item of this.state.queue) {
        if (
          (item.status === 'sent' || item.status === 'skipped') &&
          !queuedIds.has(item.key)
        ) {
          queue.push(item);
          queuedIds.add(item.key);
        }
        if (queue.length >= 100) break;
      }
      this.update({
        phase: 'ready',
        browserOpen: true,
        loginRequired: false,
        queue,
        message: foundCount
          ? `Подготовлено вакансий: ${foundCount}.`
          : 'Подходящих вакансий на выбранных страницах не найдено.',
      });
    } catch (error) {
      this.fail(error);
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
      const page = await this.ensureBrowser();
      await page.goto(vacancy.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.bringToFront();
      const blocker = await this.detectManualBlocker(page);
      this.patchQueue(vacancy.key, { status: 'opened' });
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
      const page = await this.ensureBrowser();
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
      await textarea.fill(renderCoverLetter(this.state.config.coverLetterTemplate, vacancy));
      await page.bringToFront();
      this.patchQueue(vacancy.key, { status: 'prepared' });
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
      hasCoverLetter: this.state.config.coverLetterTemplate.trim().length > 0,
      resumeTitleContains: (this.state.config.resumeTitles[0] ?? this.state.config.resumeTitleContains).trim(),
      resumeSelected: false,
      letterFilled: false,
    };
  }

  private async detectApplySituation(
    page: Page,
    ctx: HhApplyContext,
  ): Promise<HhApplySituation> {
    const body = () =>
      page
        .locator('body')
        .innerText()
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
    if (
      text.includes('ответьте на вопросы работодателя') ||
      text.includes('пройти тест для отклика') ||
      (await hasVisibleResponseFlowBlocker(page))
    ) {
      return 'employer_questions';
    }
    if (
      text.includes('отклик отправлен') ||
      (await hasVisible(page, SUCCESS_SELECTOR))
    ) {
      return 'success';
    }
    if (text.includes('вы уже откликнулись') || text.includes('отклик уже отправлен')) {
      return 'already_applied';
    }
    if (!ctx.resumeSelected && (await hasVisible(page, RESUME_ANY_SELECTOR))) {
      return 'resume_select';
    }
    const letter = page.locator(LETTER_SELECTOR).first();
    if ((await letter.count()) > 0 && (await letter.isVisible().catch(() => false))) {
      return 'letter_form';
    }
    if (await hasVisible(page, ADD_COVER_LETTER_SELECTOR)) {
      return 'letter_offer';
    }
    if (await hasVisible(page, RESPONSE_SUBMIT_SELECTOR)) {
      return 'confirm';
    }
    if (await hasVisible(page, RESPONSE_BUTTON_SELECTOR)) {
      return 'response_button';
    }
    return 'unknown';
  }

  private async selectPreferredResume(page: Page, selectedTitles: string[], vacancyTitle: string): Promise<void> {
    if (selectedTitles.length === 0) return;
    const allowed = selectedTitles.map((title) => title.toLocaleLowerCase('ru'));
    const vacancyTokens = new Set(vacancyTitle.toLocaleLowerCase('ru').split(/[^a-zа-яё0-9+#.]+/i).filter((token) => token.length > 2));
    const target = allowed
      .map((title) => ({
        title,
        score: title
          .split(/[^a-zа-яё0-9+#.]+/i)
          .filter((token) => vacancyTokens.has(token)).length,
      }))
      .sort((left, right) => right.score - left.score)[0]?.title;
    if (!target) return;

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
      const currentMatches = resumeTitleMatches(visible[0]?.text ?? '', target);
      if (visible.length === 1 && currentMatches) return;
      if (visible.length === 1) {
        await modernTitles.nth(visible[0].index).click();
        await page.waitForTimeout(250);
        visible = await visibleModern();
      }
      const option = visible
        .slice(currentMatches ? 1 : 0)
        .find((item) => resumeTitleMatches(item.text, target));
      if (option) {
        await modernTitles.nth(option.index).click();
        return;
      }
      if (currentMatches) return;
      throw new Error(`Выбранное резюме «${selectedTitles[allowed.indexOf(target)]}» не найдено в форме отклика HH.`);
    }

    // Compatibility fallback for the previous HH response form.
    const items = page.locator(RESUME_ITEM_SELECTOR);
    const count = Math.min(await items.count(), 10);
    let best: { index: number; score: number } | null = null;
    for (let index = 0; index < count; index += 1) {
      const item = items.nth(index);
      const text = (await item.innerText().catch(() => '')).toLocaleLowerCase('ru');
      const selected = allowed.find((title) => resumeTitleMatches(text, title));
      if (!selected) continue;
      const score = selected.split(/[^a-zа-яё0-9+#.]+/i).filter((token) => vacancyTokens.has(token)).length;
      if (!best || score > best.score) best = { index, score };
    }
    if (best) await items.nth(best.index).click().catch(() => undefined);
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
      await candidate.click().catch(() => undefined);
      return true;
    }
    return false;
  }

  private async applyToVacancy(
    vacancy: HhQueueItem,
  ): Promise<{ sent: boolean; blocked: boolean; reason: string }> {
    const page = await this.ensureBrowser();
    if (hhVacancyId(page.url()) !== vacancy.id) {
      await page.goto(vacancy.url, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
    }
    const config = this.state.config;
    const baseCtx: HhApplyContext = {
      ...this.buildApplyContext(),
    };

    for (let step = 0; step < 8; step += 1) {
      const situation = await this.detectApplySituation(page, baseCtx);
      const decided = decideNextAction(situation, baseCtx);
      switch (decided.action) {
        case 'mark_sent':
          this.patchQueue(vacancy.id, {
            status: 'sent',
            reason: situation === 'already_applied' ? 'Уже откликались' : 'Отклик отправлен',
            sentAt: nowIso(),
          });
          return {
            sent: true,
            blocked: false,
            reason:
              situation === 'already_applied' ? 'Отклик уже был отправлен ранее.' : 'Отклик отправлен.',
          };
        case 'skip':
          this.patchQueue(vacancy.id, { status: 'skipped', reason: decided.reason });
          return { sent: false, blocked: false, reason: decided.reason };
        case 'wait_user':
          this.update({
            phase: 'manual_required',
            browserOpen: true,
            currentVacancyId: vacancy.id,
            message: decided.reason,
          });
          return { sent: false, blocked: true, reason: decided.reason };
        case 'click_response': {
          const clicked = await this.clickFirstVisible(page, RESPONSE_BUTTON_SELECTOR);
          if (!clicked) {
            this.patchQueue(vacancy.id, {
              status: 'skipped',
              reason: 'Кнопка «Откликнуться» не найдена.',
            });
            return { sent: false, blocked: false, reason: 'Кнопка «Откликнуться» не найдена.' };
          }
          await page.waitForTimeout(jitterMs(1));
          break;
        }
        case 'select_resume':
          await this.selectPreferredResume(
            page,
            this.state.config.resumeTitles.length > 0
              ? this.state.config.resumeTitles
              : [this.state.config.resumeTitleContains].filter(Boolean),
            vacancy.title,
          );
          baseCtx.resumeSelected = true;
          break;
        case 'open_letter': {
          const opened = await this.clickFirstVisible(page, ADD_COVER_LETTER_SELECTOR);
          if (!opened) throw new Error('HH не показал кнопку добавления сопроводительного письма.');
          await page
            .locator(LETTER_SELECTOR)
            .first()
            .waitFor({ state: 'visible', timeout: 5_000 });
          break;
        }
        case 'fill_letter': {
          const textarea = page.locator(LETTER_SELECTOR).first();
          const letter = renderCoverLetter(config.coverLetterTemplate, vacancy);
          await textarea.fill(letter);
          if ((await textarea.inputValue()).trim() !== letter.trim()) {
            throw new Error('HH не принял текст сопроводительного письма.');
          }
          baseCtx.letterFilled = true;
          break;
        }
        case 'click_confirm': {
          const clicked = await this.clickFirstVisible(page, RESPONSE_SUBMIT_SELECTOR);
          if (!clicked) throw new Error('HH не показал финальную кнопку отклика.');
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
      status: 'skipped',
      reason: 'Превышено число шагов авто-отклика.',
    });
    return {
      sent: false,
      blocked: false,
      reason: 'Не удалось завершить отклик: слишком много шагов.',
    };
  }

  private async runQueue(): Promise<void> {
    if (this.applyInFlight) return;
    this.applyInFlight = true;
    this.stopApplyRequested = false;
    let sentNow = 0;
    const initial = this.state.queue.filter(
      (item) => item.platform === 'hh' && (item.status === 'new' || item.status === 'opened' || item.status === 'prepared'),
    );
    const total = initial.length;
    if (total === 0) {
      this.applyInFlight = false;
      this.update({
        phase: 'ready', applying: false, applyProgress: null,
        message: 'Новых вакансий для авто-отклика нет.',
      });
      return;
    }

    let done = 0;
    this.update({
      phase: 'applying', browserOpen: true, applying: true,
      applyProgress: { done: 0, total },
      message: 'Начинаю авто-отклики…',
    });

    for (const item of initial) {
      if (this.stopApplyRequested) break;
      this.update({
        currentVacancyId: item.id,
        applyProgress: { done, total },
        message: `Откликаюсь на «${item.title}»… (${done + 1}/${total})`,
      });
      const outcome = await this.applyToVacancy(item).catch((error) => ({
        sent: false, blocked: false,
        reason: error instanceof Error ? error.message : String(error),
      }));
      if (outcome.sent) sentNow += 1;
      done += 1;
      this.update({ applyProgress: { done, total } });
      if (outcome.blocked) break;
      if (this.stopApplyRequested) break;
    }

    this.applyInFlight = false;
    this.stopApplyRequested = false;
    const remaining = this.state.queue.filter(
      (item) => item.status === 'new' || item.status === 'opened' || item.status === 'prepared',
    ).length;
    this.update({
      phase: 'ready', applying: false, applyProgress: null,
      message: `Сессия завершена: ${
        sentNow > 0 ? `успешно ${sentNow}` : 'успешных нет'
      } из ${total}. ${remaining > 0 ? `Осталось в очереди: ${remaining}.` : 'Очередь пуста.'}`,
    });
  }

  async applyAll(): Promise<HhAssistantState> {
    if (this.applyInFlight) return this.getState();
    void this.runQueue();
    return this.getState();
  }

  async applyOne(vacancyId: string): Promise<HhAssistantState> {
    const vacancy = this.state.queue.find((item) => item.key === vacancyId || item.id === vacancyId);
    if (!vacancy) {
      this.update({ phase: 'error', message: 'Вакансия не найдена в очереди.' });
      return this.getState();
    }
    if (vacancy.platform !== 'hh') {
      return this.openVacancy(vacancy.key);
    }
    if (this.applyInFlight) return this.getState();
    this.applyInFlight = true;
    this.update({
      phase: 'applying',
      applying: true,
      currentVacancyId: vacancy.id,
      message: `Откликаюсь на «${vacancy.title}»…`,
    });
    const outcome = await this.applyToVacancy(vacancy).catch((error) => ({
      sent: false,
      blocked: false,
      reason: error instanceof Error ? error.message : String(error),
    }));
    this.applyInFlight = false;
    this.update({
      phase: outcome.blocked ? 'manual_required' : 'ready',
      applying: false,
      message: outcome.reason,
    });
    return this.getState();
  }

  stopApply(): HhAssistantState {
    if (!this.applyInFlight) return this.getState();
    this.stopApplyRequested = true;
    this.update({
      message: 'Останавливаю авто-отклики после текущей вакансии…',
    });
    return this.getState();
  }

  private clearScheduleTimer(): void {
    if (this.scheduleTimer) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = null;
    }
  }

  startDailySchedule(): void {
    this.clearScheduleTimer();
    const config = this.state.config;
    if (!config.autoRunDaily) return;
    const delay = nextAutoRunDelayMs(config, new Date());
    this.scheduleTimer = setTimeout(() => {
      void this.onScheduleTick();
    }, delay);
    this.update({
      message: `Ежедневный авто-прогон запланирован на ${config.autoRunHour}:00 локального времени.`,
    });
  }

  stopDailySchedule(): void {
    this.clearScheduleTimer();
  }

  private async onScheduleTick(): Promise<void> {
    if (this.scheduleRunning) return;
    this.scheduleRunning = true;
    try {
      if (this.state.config.query) {
        await this.scan();
      }
      await this.runQueue();
    } finally {
      this.scheduleRunning = false;
      if (this.state.config.autoRunDaily) {
        this.startDailySchedule();
      }
    }
  }

  mark(vacancyId: string, status: Extract<HhQueueStatus, 'sent' | 'skipped'>): HhAssistantState {
    this.patchQueue(vacancyId, {
      status,
      reason: status === 'sent' ? 'Подтверждено пользователем' : 'Пропущено пользователем',
      sentAt: status === 'sent' ? nowIso() : undefined,
    });
    this.update({
      message: status === 'sent' ? 'Отклик отмечен как отправленный.' : 'Вакансия пропущена.',
    });
    return this.getState();
  }

  private patchQueue(vacancyId: string, patch: Partial<HhQueueItem>): void {
    this.state.queue = this.state.queue.map((item) =>
      item.key === vacancyId || item.id === vacancyId ? { ...item, ...patch } : item,
    );
    this.persist();
  }

  async close(): Promise<void> {
    this.stopApplyRequested = true;
    this.clearScheduleTimer();
    const context = this.context;
    const browser = this.browser;
    const browserProcess = this.browserProcess;
    this.browser = null;
    this.browserProcess = null;
    this.context = null;
    this.page = null;
    this.chatPage = null;
    fs.rmSync(path.join(this.profileDir, 'SkillCueDebugPort'), { force: true });
    if (browser) await settleWithin(browser.close(), 4_000);
    if (context) await settleWithin(context.close(), 1_000);
    await terminateBrowserProcessTree(browserProcess);
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
