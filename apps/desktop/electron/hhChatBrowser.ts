import fs from 'fs';
import path from 'path';
import type { Page } from 'playwright-core';

// ─── Типы ───────────────────────────────────────────────────────────────────

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

export const DEFAULT_CHAT_CONFIG: HhChatConfig = {
  enabled: false,
  pollIntervalSec: 60,
  dailyReplyLimit: 20,
  replyDelaySec: 15,
  replyPrompt: [
    'Ты — соискатель на hh.ru. Напиши вежливый ответ рекрутеру на русском языке.',
    'Правила:',
    '- Отвечай от первого лица (я, мне).',
    '- Будь заинтересован, но не навязчив.',
    '- Если просят уточнить детали — дай конкретный ответ.',
    '- Если приглашают на собеседование — предложи время.',
    '- Если просят тестовое — согласись и уточни сроки.',
    '- Если это отказ — поблагодари и спроси про другие вакансии.',
    '- Максимум 3-4 предложения.',
    '- Не используй шаблонные фразы вроде «Буду ждать обратной связи».',
    '',
    'Контекст:',
    'Вакансия: {vacancy}',
    'Компания: {company}',
    '',
    'Сообщение рекрутера:',
    '{message}',
  ].join('\n'),
  onlyDiscussions: true,
  minMessageLength: 15,
  ignoredKeywords: 'отказ, не готовы, закрыли, другой кандидат, рассматриваем других',
};

// ─── Селекторы HH (страница переговоров) ────────────────────────────────────

const NEGOTIATIONS_URL = 'https://hh.ru/negotiations';

const NEGOTIATION_ITEM_SELECTOR = [
  '[data-qa="negotiation-item"]',
  '[data-qa="negotiations-item"]',
  '.negotiations-item',
].join(', ');

const NEGOTIATION_LINK_SELECTOR = 'a[href*="/negotiation/"]';

const UNREAD_INDICATOR_SELECTOR = [
  '[data-qa="negotiation-item-new-messages"]',
  '.negotiations-item--new',
  '.bloko-icon_dot',
  '[class*="unread"]',
  '[class*="has-updates"]',
].join(', ');

const CHAT_MESSAGES_SELECTOR = [
  '[data-qa="chat-message"]',
  '[data-qa="negotiation-message"]',
  '.chat-message',
  '.messages-item',
].join(', ');

const CHAT_INPUT_SELECTOR = [
  '[data-qa="chat-message-input"]',
  '[data-qa="negotiation-message-input"]',
  'textarea[placeholder*="сообщение" i]',
  'textarea[placeholder*="напишите" i]',
  '.chat-input textarea',
  '[role="textbox"]',
].join(', ');

const CHAT_SEND_SELECTOR = [
  '[data-qa="chat-message-send"]',
  '[data-qa="negotiation-message-send"]',
  'button[type="submit"]',
  'button:has(svg)',
].join(', ');

const NEGOTIATION_VACANCY_SELECTOR = [
  '[data-qa="negotiation-vacancy-title"]',
  '.negotiation-vacancy-name',
  'a[href*="/vacancy/"]',
].join(', ');

const NEGOTIATION_COMPANY_SELECTOR = [
  '[data-qa="negotiation-company-name"]',
  '.negotiation-company-name',
  '[data-qa="employer-name"]',
].join(', ');

// ─── Хранилище ──────────────────────────────────────────────────────────────

interface PersistedChatState {
  config: HhChatConfig;
  seenMessageIds: string[];
  repliesToday: number;
  replyDate: string;
}

function chatStatePath(userDataDir: string): string {
  return path.join(userDataDir, 'hh-chat-browser.json');
}

// ─── Callback для получения страницы браузера ───────────────────────────────

export type GetPageFn = () => Promise<Page | null>;

// ─── Сервис ─────────────────────────────────────────────────────────────────

export class HhChatBrowser {
  private readonly getPage: GetPageFn;
  private readonly llmCall: (prompt: string) => Promise<string>;
  private config: HhChatConfig;
  private seenMessageIds: Set<string> = new Set();
  private repliesToday = 0;
  private replyDate = '';
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private lastPollAt: string | null = null;
  private error: string | null = null;
  private readonly userDataDir: string;

  constructor(
    userDataDir: string,
    getPage: GetPageFn,
    llmCall: (prompt: string) => Promise<string>,
  ) {
    this.userDataDir = userDataDir;
    this.getPage = getPage;
    this.llmCall = llmCall;

    const persisted = this.load();
    this.config = { ...DEFAULT_CHAT_CONFIG, ...persisted?.config };

    const today = this.todayKey();
    if (persisted?.replyDate === today) {
      this.repliesToday = persisted.repliesToday ?? 0;
      this.replyDate = today;
    }
    if (persisted?.seenMessageIds) {
      this.seenMessageIds = new Set(persisted.seenMessageIds.slice(-500));
    }
  }

  // ─── Публичные методы ──────────────────────────────────────────────────

  getState(): HhChatState {
    return {
      enabled: this.config.enabled,
      polling: this.polling,
      lastPollAt: this.lastPollAt,
      repliesToday: this.repliesToday,
      activeNegotiations: 0,
      unreadMessages: 0,
      config: { ...this.config },
      error: this.error,
    };
  }

  getConfig(): HhChatConfig {
    return { ...this.config };
  }

  saveConfig(partial: Partial<HhChatConfig>): HhChatConfig {
    const wasEnabled = this.config.enabled;
    this.config = { ...this.config, ...partial };
    this.persist();

    if (!wasEnabled && this.config.enabled) {
      this.startPolling();
    } else if (wasEnabled && !this.config.enabled) {
      this.stopPolling();
    }

    return this.getConfig();
  }

  setEnabled(enabled: boolean): HhChatState {
    this.saveConfig({ enabled });
    return this.getState();
  }

  async pollNow(): Promise<HhChatState> {
    await this.pollOnce();
    return this.getState();
  }

  startPolling(): void {
    if (this.pollTimer) return;
    this.scheduleNext();
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.polling = false;
  }

  dispose(): void {
    this.stopPolling();
  }

  // ─── Приватные методы ─────────────────────────────────────────────────

  private scheduleNext(): void {
    this.pollTimer = setTimeout(() => {
      void this.pollOnce().finally(() => {
        if (this.config.enabled) this.scheduleNext();
      });
    }, this.config.pollIntervalSec * 1000);
  }

  private async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.error = null;

    try {
      const page = await this.getPage();
      if (!page || page.isClosed()) {
        this.error = 'Браузер HH не открыт. Откройте браузер через «Открыть HH».';
        return;
      }

      // Переходим на страницу переговоров
      const currentUrl = page.url();
      if (!currentUrl.includes('/negotiations')) {
        await page.goto(NEGOTIATIONS_URL, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
      }

      // Ждём загрузки списка
      await page
        .locator(NEGOTIATION_ITEM_SELECTOR)
        .first()
        .waitFor({ timeout: 10_000 })
        .catch(() => undefined);

      // Ищем переговоры с непрочитанными сообщениями
      const negotiations = await this.scrapeNegotiations(page);
      let replied = 0;

      for (const neg of negotiations) {
        if (this.repliesToday >= this.config.dailyReplyLimit) break;
        if (!neg.hasUnread) continue;

        // Переходим в чат
        await this.openNegotiation(page, neg.url);

        // Читаем последнее сообщение от рекрутера
        const lastMessage = await this.scrapeLastRecruiterMessage(page);
        if (!lastMessage) continue;

        const messageId = `${neg.id}:${lastMessage.text.slice(0, 60)}`;
        if (this.seenMessageIds.has(messageId)) continue;
        if (this.shouldIgnore(lastMessage.text)) continue;

        // Генерируем ответ
        const reply = await this.llmCall(
          this.config.replyPrompt
            .replaceAll('{vacancy}', neg.vacancyTitle)
            .replaceAll('{company}', neg.companyName)
            .replaceAll('{message}', lastMessage.text),
        );

        if (!reply) continue;

        // Задержка (имитация человека)
        await this.delay(this.config.replyDelaySec * 1000);

        // Отправляем ответ
        await this.sendChatMessage(page, reply);

        this.seenMessageIds.add(messageId);
        this.repliesToday += 1;
        replied += 1;
      }

      this.lastPollAt = new Date().toISOString();
      if (replied > 0) {
        this.persist();
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      console.warn('[hh-chat-browser] poll error:', this.error);
    } finally {
      this.polling = false;
    }
  }

  /** Скрапим список переговоров с текущей страницы. */
  private async scrapeNegotiations(
    page: Page,
  ): Promise<
    Array<{
      id: string;
      url: string;
      vacancyTitle: string;
      companyName: string;
      hasUnread: boolean;
    }>
  > {
    const result: Array<{
      id: string;
      url: string;
      vacancyTitle: string;
      companyName: string;
      hasUnread: boolean;
    }> = [];

    const items = page.locator(NEGOTIATION_ITEM_SELECTOR);
    const count = Math.min(await items.count(), 20);

    for (let i = 0; i < count; i++) {
      const item = items.nth(i);
      if (!(await item.isVisible().catch(() => false))) continue;

      // Ссылка на переговоры
      const link = item.locator(NEGOTIATION_LINK_SELECTOR).first();
      const href = (await link.getAttribute('href').catch(() => null)) ?? '';
      const url = href.startsWith('http') ? href : `https://hh.ru${href}`;
      const idMatch = href.match(/(\d+)/);
      const id = idMatch?.[1] ?? '';

      if (!id || !url) continue;

      // Название вакансии
      const vacancyTitle = (
        await item
          .locator(NEGOTIATION_VACANCY_SELECTOR)
          .first()
          .innerText()
          .catch(() => '')
      ).trim();

      // Компания
      const companyName = (
        await item
          .locator(NEGOTIATION_COMPANY_SELECTOR)
          .first()
          .innerText()
          .catch(() => '')
      ).trim();

      // Непрочитанные
      const hasUnread = await item
        .locator(UNREAD_INDICATOR_SELECTOR)
        .first()
        .isVisible()
        .catch(() => false);

      result.push({ id, url, vacancyTitle, companyName, hasUnread });
    }

    return result;
  }

  /** Перейти в конкретный чат. */
  private async openNegotiation(page: Page, url: string): Promise<void> {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Ждём загрузки сообщений
    await page
      .locator(CHAT_MESSAGES_SELECTOR)
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(() => undefined);
  }

  /** Найти последнее сообщение от рекрутера. */
  private async scrapeLastRecruiterMessage(
    page: Page,
  ): Promise<{ text: string } | null> {
    const messages = page.locator(CHAT_MESSAGES_SELECTOR);
    const count = Math.min(await messages.count(), 50);

    // Идём с конца
    for (let i = count - 1; i >= 0; i--) {
      const msg = messages.nth(i);
      if (!(await msg.isVisible().catch(() => false))) continue;

      // Определяем автора: сообщения соискателя обычно справа/другой класс
      const isMine = await msg
        .locator('[class*="my"], [class*="own"], [class*="applicant"], [class*="self"], [data-qa*="my-message"]')
        .first()
        .isVisible()
        .catch(() => false);

      if (isMine) continue;

      const text = (await msg.innerText().catch(() => '')).trim();
      if (text.length >= this.config.minMessageLength) {
        return { text };
      }
    }

    return null;
  }

  /** Отправить сообщение в чат. */
  private async sendChatMessage(page: Page, text: string): Promise<void> {
    // Находим поле ввода
    const input = page.locator(CHAT_INPUT_SELECTOR).first();
    const inputCount = await input.count();
    if (inputCount === 0) {
      console.warn('[hh-chat-browser] Не найдено поле ввода чата');
      return;
    }

    await input.click().catch(() => undefined);
    await input.fill('').catch(() => undefined); // очищаем
    await input.type(text, { delay: 30 }).catch(() => {
      // fallback: fill
      void input.fill(text);
    });

    await this.delay(500);

    // Находим кнопку отправки
    const sendBtn = page.locator(CHAT_SEND_SELECTOR).first();
    if ((await sendBtn.count()) > 0) {
      await sendBtn.click().catch(() => undefined);
    } else {
      // Пробуем Enter
      await page.keyboard.press('Enter');
    }

    await this.delay(1000);
  }

  private shouldIgnore(text: string): boolean {
    const lower = text.toLocaleLowerCase('ru');
    return this.config.ignoredKeywords
      .split(',')
      .some((kw) => {
        const trimmed = kw.trim().toLocaleLowerCase('ru');
        return trimmed && lower.includes(trimmed);
      });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private todayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private load(): PersistedChatState | null {
    try {
      const raw = fs.readFileSync(chatStatePath(this.userDataDir), 'utf8');
      return JSON.parse(raw) as PersistedChatState;
    } catch {
      return null;
    }
  }

  private persist(): void {
    try {
      const today = this.todayKey();
      fs.mkdirSync(path.dirname(chatStatePath(this.userDataDir)), { recursive: true });
      fs.writeFileSync(
        chatStatePath(this.userDataDir),
        JSON.stringify(
          {
            config: this.config,
            seenMessageIds: [...this.seenMessageIds].slice(-500),
            repliesToday: this.replyDate === today ? this.repliesToday : 0,
            replyDate: today,
          } satisfies PersistedChatState,
          null,
          2,
        ),
        'utf8',
      );
    } catch (error) {
      console.warn('[hh-chat-browser] persist failed:', error);
    }
  }
}