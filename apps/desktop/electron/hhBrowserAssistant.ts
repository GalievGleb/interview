import fs from 'fs';
import path from 'path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
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
  status: HhQueueStatus;
  reason?: string;
  addedAt: string;
  sentAt?: string;
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

const CARD_SELECTOR = '[data-qa="vacancy-serp__vacancy"]';
const TITLE_SELECTOR =
  '[data-qa="serp-item__title"], [data-qa="vacancy-serp__vacancy-title"]';
const COMPANY_SELECTOR =
  '[data-qa="vacancy-serp__vacancy-employer"], [data-qa="vacancy-serp__vacancy-employer-text"]';
const SALARY_SELECTOR =
  '[data-qa="vacancy-serp__vacancy-compensation"], [data-qa="vacancy-serp__vacancy-salary"]';
const LETTER_SELECTOR = '[data-qa="vacancy-response-popup-form-letter-input"]';
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
const RESPONSE_BUTTON_SELECTOR = [
  '[data-qa="vacancy-response-link-top"]',
  '[data-qa="vacancy-response-link"]',
].join(', ');
const RESPONSE_SUBMIT_SELECTOR = [
  '[data-qa="vacancy-response-submit-popup"]',
  '[data-qa="vacancy-response-letter-submit"]',
].join(', ');
const RESUME_ITEM_SELECTOR =
  '[data-qa*="resume-select-item"], label:has([data-qa*="resume"])';
const RESUME_ANY_SELECTOR =
  '[data-qa*="resume-select-item"], [data-qa*="resume-select"] label, ' +
  '[data-qa="applicant-resumes-select"] label';
const LOGIN_CODE_INPUT_SELECTOR = [
  'input[data-qa*="code"]',
  'input[name="code"]',
  'input[autocomplete="one-time-code"]',
  'input[inputmode="numeric"]',
].join(', ');
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

function normalizePersistedQueue(value: unknown): HhQueueItem[] {
  if (!Array.isArray(value)) return [];
  const result: HhQueueItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const url = normalizeHhVacancyUrl(String(item.url ?? ''));
    const id = url.match(/\/vacancy\/(\d+)$/)?.[1] ?? '';
    const title = String(item.title ?? '').trim().slice(0, 300);
    if (!id || !title) continue;
    const rawStatus = String(item.status ?? 'new') as HhQueueStatus;
    const addedAt = String(item.addedAt ?? '');
    result.push({
      id,
      title,
      company: String(item.company ?? '').trim().slice(0, 300),
      salary: String(item.salary ?? '').trim().slice(0, 120),
      url,
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
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly profileDir: string;
  private readonly statePath: string;
  private readonly emitState: EmitState;
  private state: HhAssistantState;
  private stopApplyRequested = false;
  private applyInFlight = false;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private scheduleRunning = false;

  constructor(userDataDir: string, emitState: EmitState) {
    this.profileDir = path.join(userDataDir, 'hh-browser-profile');
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

  private async launchInstalledBrowser(): Promise<BrowserContext> {
    fs.mkdirSync(this.profileDir, { recursive: true });
    const errors: string[] = [];
    for (const channel of ['msedge', 'chrome'] as const) {
      try {
        return await chromium.launchPersistentContext(this.profileDir, {
          channel,
          headless: false,
          viewport: null,
          locale: 'ru-RU',
          args: ['--start-maximized'],
        });
      } catch (error) {
        errors.push(`${channel}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(
      `Не удалось открыть Edge или Chrome. Установите один из браузеров. ${errors.join(' | ')}`,
    );
  }

  private async ensureBrowser(): Promise<Page> {
    if (this.context && this.page && !this.page.isClosed()) return this.page;
    if (this.context) {
      const existingContext = this.context;
      try {
        this.page =
          existingContext.pages().find((candidate) => !candidate.isClosed()) ??
          (await existingContext.newPage());
        return this.page;
      } catch {
        if (this.context === existingContext) this.context = null;
        this.page = null;
      }
    }
    const context = await this.launchInstalledBrowser();
    this.context = context;
    context.once('close', () => {
      if (this.context !== context) return;
      this.context = null;
      this.page = null;
      this.update({
        phase: 'idle',
        browserOpen: false,
        currentVacancyId: null,
        message: 'Окно HH закрыто.',
      });
    });
    this.page = context.pages()[0] ?? (await context.newPage());
    this.update({ browserOpen: true, phase: 'browser_open' });
    return this.page;
  }

  async openBrowser(): Promise<HhAssistantState> {
    try {
      const page = await this.ensureBrowser();
      if (!isHhPage(page.url())) {
        await page.goto('https://hh.ru/', { waitUntil: 'domcontentloaded' });
      }
      await page.bringToFront();
      const loginRequired = await this.isLoginRequired(page);
      this.update({
        phase: 'browser_open',
        browserOpen: true,
        loginRequired,
        message: loginRequired
          ? 'Войдите в HH в открытом окне. SkillCue сохранит сессию локально.'
          : 'HH открыт и готов к работе.',
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
      await page.goto('https://hh.ru/account/login', {
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
      const page = await this.ensureBrowser();
      await page.goto('https://hh.ru/account/login', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });

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
        if (await applicantType.isVisible().catch(() => false)) {
          await applicantType.check({ force: true }).catch(() => undefined);
          await page.locator('button[data-qa="submit-button"], button[type="submit"]').first().click();
          await page
            .locator('input[data-qa^="credential-type-email"]')
            .first()
            .waitFor({ state: 'visible', timeout: 10_000 });
        }
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
      const codeInput = page.locator(LOGIN_CODE_INPUT_SELECTOR).first();
      await codeInput.waitFor({ state: 'visible', timeout: 10_000 });
      this.update({
        browserOpen: true,
        loginRequired: true,
        message: 'Код отправлен на почту.',
      });
      return { ok: true, message: 'Код отправлен на почту.' };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Не удалось отправить код.',
      };
    }
  }

  async confirmLoginCode(code: string): Promise<{ ok: boolean; message: string }> {
    try {
      const page = await this.ensureBrowser();
      const normalized = code.replace(/\s/g, '');
      if (!normalized) return { ok: false, message: 'Введите код из письма.' };
      const codeInputs = page.locator(LOGIN_CODE_INPUT_SELECTOR);
      const codeInput = codeInputs.first();
      await codeInput.waitFor({ state: 'visible', timeout: 10_000 });
      const visibleInputs = Math.min(await codeInputs.count(), normalized.length);
      if (visibleInputs > 1) {
        for (let index = 0; index < visibleInputs; index += 1) {
          await codeInputs.nth(index).fill(normalized[index] ?? '');
        }
      } else {
        await codeInput.fill(normalized);
      }
      const submit = page.locator('button[data-qa="account-login-submit"], button[type="submit"], button:has-text("Войти"), button:has-text("Подтвердить")').first();
      if (await submit.isVisible().catch(() => false)) await submit.click();
      else await codeInput.press('Enter');
      const applicantMenu = page.locator(APPLICANT_MENU_SELECTOR).first();
      const authenticated = await applicantMenu
        .waitFor({ state: 'visible', timeout: 12_000 })
        .then(() => true)
        .catch(() => false);
      if (!authenticated) {
        const errorText = await page
          .locator('[data-qa*="error"], [role="alert"], [class*="error"]')
          .first()
          .innerText()
          .catch(() => '');
        this.update({ loginRequired: true, message: errorText || 'Код не подошёл или истёк. Запросите новый.' });
        return { ok: false, message: errorText || 'Код не подошёл или истёк. Запросите новый.' };
      }
      this.update({ phase: 'ready', browserOpen: true, loginRequired: false, message: 'HH подключён.' });
      return { ok: true, message: 'HH подключён.' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Не удалось подтвердить код.' };
    }
  }

  private async isLoginRequired(page: Page): Promise<boolean> {
    const loginLink = page.locator(
      '[data-qa="login"], a[href*="/account/login"], a[href*="/account/signup"]',
    );
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
      (await hasVisible(page, RESPONSE_QUESTION_SELECTOR)) ||
      (await hasVisible(page, RESPONSE_TEST_SELECTOR))
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

  async scan(): Promise<HhAssistantState> {
    if (!this.state.config.query) {
      this.update({
        phase: 'error',
        message: 'Укажите должность или специальность для поиска.',
      });
      return this.getState();
    }

    try {
      const page = await this.ensureBrowser();
      this.update({
        phase: 'scanning',
        browserOpen: true,
        message: 'Собираю вакансии из видимых страниц поиска…',
      });
      const collected = new Map<string, HhVacancy>();
      for (let pageIndex = 0; pageIndex < this.state.config.maxPages; pageIndex += 1) {
        await page.goto(buildHhSearchUrl(this.state.config, pageIndex), {
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
        const loginRequired = await this.isLoginRequired(page);
        if (loginRequired) {
          this.update({
            phase: 'manual_required',
            browserOpen: true,
            loginRequired: true,
            message: 'Сначала войдите в HH в открытом браузере.',
          });
          return this.getState();
        }
        await page
          .locator(CARD_SELECTOR)
          .first()
          .waitFor({ timeout: 10_000 })
          .catch(() => undefined);
        const pageVacancies = await this.scrapeCurrentPage(page);
        if (pageVacancies.length === 0) break;
        for (const vacancy of pageVacancies) {
          if (shouldExcludeVacancy(vacancy, this.state.config)) continue;
          if (!collected.has(vacancy.id)) collected.set(vacancy.id, vacancy);
          if (collected.size >= this.state.config.maxQueueSize) break;
        }
        if (collected.size >= this.state.config.maxQueueSize) break;
      }

      const previous = new Map(this.state.queue.map((item) => [item.id, item]));
      const queue: HhQueueItem[] = [];
      for (const vacancy of collected.values()) {
        const old = previous.get(vacancy.id);
        queue.push({
          ...vacancy,
          status: old?.status ?? 'new',
          reason: old?.reason,
          addedAt: old?.addedAt ?? nowIso(),
        });
      }
      const foundCount = queue.length;
      const queuedIds = new Set(queue.map((item) => item.id));
      for (const item of this.state.queue) {
        if (
          (item.status === 'sent' || item.status === 'skipped') &&
          !queuedIds.has(item.id)
        ) {
          queue.push(item);
          queuedIds.add(item.id);
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
    const vacancy = this.state.queue.find((item) => item.id === vacancyId);
    if (!vacancy) {
      this.update({ phase: 'error', message: 'Вакансия не найдена в очереди.' });
      return this.getState();
    }
    try {
      const page = await this.ensureBrowser();
      await page.goto(vacancy.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.bringToFront();
      const blocker = await this.detectManualBlocker(page);
      this.patchQueue(vacancyId, { status: 'opened' });
      this.update({
        phase: blocker ? 'manual_required' : 'ready',
        currentVacancyId: vacancyId,
        browserOpen: true,
        message:
          blocker ??
          'Вакансия открыта. Нажмите «Откликнуться» на HH, затем вернитесь в SkillCue и заполните письмо.',
      });
    } catch (error) {
      this.fail(error);
    }
    return this.getState();
  }

  async fillCoverLetter(vacancyId: string): Promise<HhAssistantState> {
    const vacancy = this.state.queue.find((item) => item.id === vacancyId);
    if (!vacancy) {
      this.update({ phase: 'error', message: 'Вакансия не найдена в очереди.' });
      return this.getState();
    }
    try {
      const page = await this.ensureBrowser();
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
      this.patchQueue(vacancyId, { status: 'prepared' });
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
      resumeTitleContains: this.state.config.resumeTitleContains.trim(),
      resumeSelected: false,
      letterFilled: false,
    };
  }

  private async detectApplySituation(page: Page): Promise<HhApplySituation> {
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
      (await hasVisible(page, RESPONSE_QUESTION_SELECTOR)) ||
      (await hasVisible(page, RESPONSE_TEST_SELECTOR))
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
    if (await hasVisible(page, RESUME_ANY_SELECTOR)) {
      return 'resume_select';
    }
    const letter = page.locator(LETTER_SELECTOR).first();
    if ((await letter.count()) > 0 && (await letter.isVisible().catch(() => false))) {
      return 'letter_form';
    }
    if (await hasVisible(page, RESPONSE_SUBMIT_SELECTOR)) {
      return 'confirm';
    }
    if (await hasVisible(page, RESPONSE_BUTTON_SELECTOR)) {
      return 'response_button';
    }
    return 'unknown';
  }

  private async selectPreferredResume(page: Page, contains: string): Promise<void> {
    if (!contains) return;
    const items = page.locator(RESUME_ITEM_SELECTOR);
    const count = Math.min(await items.count(), 10);
    const needle = contains.toLocaleLowerCase('ru');
    for (let index = 0; index < count; index += 1) {
      const item = items.nth(index);
      const text = (await item.innerText().catch(() => '')).toLocaleLowerCase('ru');
      if (text.includes(needle)) {
        await item.click().catch(() => undefined);
        return;
      }
    }
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
      const situation = await this.detectApplySituation(page);
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
          await this.selectPreferredResume(page, this.state.config.resumeTitleContains);
          baseCtx.resumeSelected = true;
          break;
        case 'fill_letter': {
          const textarea = page.locator(LETTER_SELECTOR).first();
          await textarea
            .fill(renderCoverLetter(config.coverLetterTemplate, vacancy))
            .catch(() => undefined);
          baseCtx.letterFilled = true;
          break;
        }
        case 'click_confirm':
          await this.clickFirstVisible(page, RESPONSE_SUBMIT_SELECTOR);
          await page.waitForTimeout(jitterMs(1));
          break;
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
      (item) => item.status === 'new' || item.status === 'opened' || item.status === 'prepared',
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
    const vacancy = this.state.queue.find((item) => item.id === vacancyId);
    if (!vacancy) {
      this.update({ phase: 'error', message: 'Вакансия не найдена в очереди.' });
      return this.getState();
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
      item.id === vacancyId ? { ...item, ...patch } : item,
    );
    this.persist();
  }

  async close(): Promise<void> {
    this.stopApplyRequested = true;
    this.clearScheduleTimer();
    const context = this.context;
    this.context = null;
    this.page = null;
    if (context) await context.close().catch(() => undefined);
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
