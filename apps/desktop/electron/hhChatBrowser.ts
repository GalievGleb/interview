import fs from 'fs';
import path from 'path';
import type { Frame, Page } from 'playwright-core';
import {
  analyzeInterviewMessage,
  chooseThreadSlot,
  findNextInterviewSlots,
  formatInterviewSlotRu,
  isInterviewSlotAvailable,
  type InterviewCalendarStore,
  type InterviewType,
} from './interviewCalendar';

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
    '- Время собеседований согласует календарь SkillCue. Сам не придумывай даты и время.',
    '- Если просят тестовое — согласись и уточни сроки.',
    '- Максимум 3-4 предложения.',
    '- Не придумывай опыт, условия, даты, зарплату или контакты, которых нет в сообщении.',
    '- Не используй шаблонные фразы вроде «Буду ждать обратной связи».',
    '',
    'Контекст:',
    'Вакансия: {vacancy}',
    'Компания: {company}',
    '',
    'Последнее сообщение рекрутера:',
    '{message}',
  ].join('\n'),
  onlyDiscussions: true,
  minMessageLength: 2,
  ignoredKeywords: 'отказ, не готовы, закрыли, другой кандидат, рассматриваем других',
};

export const HH_NEGOTIATIONS_URL = 'https://hh.ru/applicant/negotiations';

const NEGOTIATION_ITEM_SELECTOR = '[data-qa="negotiations-item"]';
const OPEN_CHAT_SELECTOR = '[data-qa="open_chat"]';
const NEGOTIATION_VACANCY_SELECTOR = '[data-qa="negotiations-item-vacancy"]';
const NEGOTIATION_COMPANY_SELECTOR = '[data-qa="negotiations-item-company"]';
const DISCUSSION_STATUS_SELECTOR = '[data-qa*="negotiations-item-interview"]';
const UNREAD_STATUS_SELECTOR = [
  '[data-qa*="new-message"]',
  '[data-qa*="unread"]',
  '[class*="unread"]',
].join(', ');

const CHAT_FRAME_URL_PART = 'chatik.hh.ru/chat/';
const CHAT_MESSAGE_SELECTOR = '[data-qa^="chatik-chat-message-"]';
const CHAT_INPUT_SELECTOR = '[data-qa="chatik-new-message-text"]';
const CHAT_SEND_SELECTOR = '[data-qa="chatik-do-send-message"]';
const CHAT_VACANCY_SELECTOR = '[data-qa="chatik-header-vacancy-link-text"]';
const OUTGOING_SELECTOR = '[class*="message_my"], [class*="chat-bubble_outgoing"], [class*="outgoing"]';

interface PersistedChatState {
  config: HhChatConfig;
  seenMessageIds: string[];
  repliesToday: number;
  replyDate: string;
}

interface NegotiationSummary {
  index: number;
  key: string;
  vacancyTitle: string;
  companyName: string;
  isDiscussion: boolean;
  hasUnread: boolean;
}

interface ChatMessage {
  id: string;
  text: string;
  isMine: boolean;
}

function chatStatePath(userDataDir: string): string {
  return path.join(userDataDir, 'hh-chat-browser.json');
}

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function isOutgoingChatClassName(value: string): boolean {
  return /(?:message_my|chat-bubble_outgoing|(?:^|[_-])outgoing(?:[_-]|$))/i.test(value);
}

export type GetPageFn = () => Promise<Page | null>;

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
  private activeNegotiations = 0;
  private unreadMessages = 0;
  private readonly userDataDir: string;

  constructor(
    userDataDir: string,
    getPage: GetPageFn,
    llmCall: (prompt: string) => Promise<string>,
    private readonly interviewCalendar?: InterviewCalendarStore,
  ) {
    this.userDataDir = userDataDir;
    this.getPage = getPage;
    this.llmCall = llmCall;

    const persisted = this.load();
    this.config = { ...DEFAULT_CHAT_CONFIG, ...persisted?.config };
    this.replyDate = this.todayKey();
    if (persisted?.replyDate === this.replyDate) {
      this.repliesToday = persisted.repliesToday ?? 0;
    }
    if (persisted?.seenMessageIds) {
      this.seenMessageIds = new Set(persisted.seenMessageIds.slice(-500));
    }
  }

  getState(): HhChatState {
    this.rollDailyCounter();
    return {
      enabled: this.config.enabled,
      polling: this.polling,
      lastPollAt: this.lastPollAt,
      repliesToday: this.repliesToday,
      activeNegotiations: this.activeNegotiations,
      unreadMessages: this.unreadMessages,
      config: { ...this.config },
      error: this.error,
    };
  }

  getConfig(): HhChatConfig {
    return { ...this.config };
  }

  saveConfig(partial: Partial<HhChatConfig>): HhChatConfig {
    const wasEnabled = this.config.enabled;
    this.config = {
      ...this.config,
      ...partial,
      pollIntervalSec: Math.max(30, Math.round(partial.pollIntervalSec ?? this.config.pollIntervalSec)),
      dailyReplyLimit: Math.max(1, Math.round(partial.dailyReplyLimit ?? this.config.dailyReplyLimit)),
      replyDelaySec: Math.max(0, Math.round(partial.replyDelaySec ?? this.config.replyDelaySec)),
      minMessageLength: Math.max(1, Math.round(partial.minMessageLength ?? this.config.minMessageLength)),
    };
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

  private scheduleNext(): void {
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.pollOnce().finally(() => {
        if (this.config.enabled) this.scheduleNext();
      });
    }, this.config.pollIntervalSec * 1000);
  }

  private async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.error = null;
    this.unreadMessages = 0;
    this.rollDailyCounter();

    try {
      const page = await this.getPage();
      if (!page || page.isClosed()) {
        throw new Error('Браузер HH не открыт. Сначала подключите HH в разделе автооткликов.');
      }

      if (!this.isNegotiationsPage(page.url())) {
        await page.goto(HH_NEGOTIATIONS_URL, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
      }
      if (page.url().includes('/account/login')) {
        throw new Error('Сессия HH истекла. Повторно подключите аккаунт HH.');
      }

      await page
        .locator(NEGOTIATION_ITEM_SELECTOR)
        .first()
        .waitFor({ state: 'attached', timeout: 10_000 })
        .catch(() => undefined);

      const negotiations = await this.scrapeNegotiations(page);
      const eligible = negotiations.filter((item) => !this.config.onlyDiscussions || item.isDiscussion);
      this.activeNegotiations = eligible.length;
      const ordered = [...eligible].sort((left, right) => Number(right.hasUnread) - Number(left.hasUnread));
      let shouldPersist = false;

      for (const negotiation of ordered) {
        const frame = await this.openNegotiation(page, negotiation);
        const lastMessage = await this.scrapeLastMessage(frame);
        if (!lastMessage || lastMessage.isMine) continue;

        this.unreadMessages += 1;
        const messageId = `${negotiation.key}:${lastMessage.id}`;
        if (this.seenMessageIds.has(messageId)) continue;
        if (lastMessage.text.length < this.config.minMessageLength) continue;
        const scheduling = this.handleSchedulingMessage(
          negotiation,
          lastMessage.text,
          this.repliesToday < this.config.dailyReplyLimit,
        );
        if (scheduling.handled) {
          if (!scheduling.reply) {
            if (scheduling.consume) {
              this.seenMessageIds.add(messageId);
              shouldPersist = true;
            }
            continue;
          }
          await this.delay(this.config.replyDelaySec * 1000);
          await this.sendChatMessage(frame, scheduling.reply);
          this.seenMessageIds.add(messageId);
          this.recordReply();
          shouldPersist = true;
          continue;
        }
        if (this.shouldIgnore(lastMessage.text)) {
          this.seenMessageIds.add(messageId);
          shouldPersist = true;
          continue;
        }
        if (this.repliesToday >= this.config.dailyReplyLimit) continue;

        const reply = compactText(await this.llmCall(
          this.config.replyPrompt
            .replaceAll('{vacancy}', negotiation.vacancyTitle)
            .replaceAll('{company}', negotiation.companyName)
            .replaceAll('{message}', lastMessage.text),
        )).slice(0, 3_000);
        if (!reply) continue;

        await this.delay(this.config.replyDelaySec * 1000);
        await this.sendChatMessage(frame, reply);

        this.seenMessageIds.add(messageId);
        this.repliesToday += 1;
        shouldPersist = true;
      }

      this.lastPollAt = new Date().toISOString();
      if (shouldPersist) this.persist();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      console.warn('[hh-chat-browser] poll error:', this.error);
    } finally {
      this.polling = false;
    }
  }

  private handleSchedulingMessage(
    negotiation: NegotiationSummary,
    message: string,
    canReply: boolean,
  ): { handled: boolean; reply?: string; consume?: boolean } {
    if (!this.interviewCalendar) return { handled: false };
    const now = new Date();
    const analysis = analyzeInterviewMessage(message, now);
    const previous = this.interviewCalendar.getThread(negotiation.key);
    if (!analysis.isSchedulingMessage) return { handled: false };

    const type: InterviewType =
      analysis.type !== 'other' ? analysis.type : previous?.type ?? 'other';
    const threadBase = {
      negotiationKey: negotiation.key,
      vacancyTitle: negotiation.vacancyTitle,
      companyName: negotiation.companyName,
      type,
      recruiterMessage: message,
    };

    if (analysis.isCancellation) {
      this.interviewCalendar.cancelNegotiation(negotiation.key);
      this.interviewCalendar.upsertThread({
        ...threadBase,
        stage: 'cancelled',
        offeredSlots: [],
        reason: 'Работодатель отменил встречу. Событие сохранено в истории как отменённое.',
      });
      return canReply
        ? { handled: true, reply: 'Спасибо, понял. Если появится новая дата, буду рад согласовать её.' }
        : { handled: true, consume: true };
    }

    const settings = this.interviewCalendar.getSettings();
    const calendarState = this.interviewCalendar.getState();
    const existingEventId = calendarState.events.find(
      (event) => event.negotiationKey === negotiation.key && event.status !== 'cancelled',
    )?.id;
    let selected = analysis.slots[0] ?? null;
    if (analysis.isConfirmation && previous) {
      selected = analysis.slots[0] ??
        chooseThreadSlot(message, previous.offeredSlots) ??
        (previous.selectedStartAt ? new Date(previous.selectedStartAt) : null);
    }

    if (
      analysis.isConfirmation &&
      selected &&
      (previous?.selectedStartAt === selected.toISOString() ||
        isInterviewSlotAvailable(selected, settings, calendarState.events, settings.defaultDurationMin, now, existingEventId))
    ) {
      this.interviewCalendar.scheduleFromNegotiation({
        ...threadBase,
        start: selected,
        status: 'confirmed',
        meetingUrl: analysis.meetingUrl,
        notes: message,
      });
      this.interviewCalendar.upsertThread({
        ...threadBase,
        stage: 'confirmed',
        offeredSlots: previous?.offeredSlots ?? [selected.toISOString()],
        selectedStartAt: selected.toISOString(),
      });
      return canReply ? {
        handled: true,
        reply: `Спасибо, подтверждаю. Буду на связи ${formatInterviewSlotRu(selected)}.`,
      } : { handled: true, consume: true };
    }

    if (!settings.availabilityConfigured || settings.availability.length === 0) {
      this.interviewCalendar.upsertThread({
        ...threadBase,
        stage: 'needs_availability',
        offeredSlots: analysis.slots.map((slot) => slot.toISOString()),
        reason: 'Заполните удобное время в календаре — до этого бот не будет предлагать даты от вашего имени.',
      });
      // Не помечаем сообщение обработанным: после сохранения доступности
      // следующий опрос сам вернётся к нему и продолжит согласование.
      return { handled: true };
    }

    if (analysis.isConfirmation && !selected) {
      this.interviewCalendar.upsertThread({
        ...threadBase,
        stage: 'needs_attention',
        offeredSlots: previous?.offeredSlots ?? [],
        reason: 'Работодатель подтвердил встречу без понятной даты или времени. Бот запросил уточнение.',
      });
      return canReply ? {
        handled: true,
        reply: 'Спасибо! Уточните, пожалуйста, дату и время созвона, чтобы я точно добавил встречу в календарь.',
      } : { handled: true };
    }

    if (!canReply) {
      this.interviewCalendar.upsertThread({
        ...threadBase,
        stage: 'needs_attention',
        offeredSlots: analysis.slots.map((slot) => slot.toISOString()),
        reason: 'Достигнут дневной лимит автоответов. Сообщение останется необработанным до следующего запуска.',
      });
      return { handled: true };
    }

    const availableRecruiterSlot = analysis.slots.find((slot) =>
      isInterviewSlotAvailable(
        slot,
        settings,
        calendarState.events,
        settings.defaultDurationMin,
        now,
        existingEventId,
      ),
    );
    if (availableRecruiterSlot) {
      this.interviewCalendar.scheduleFromNegotiation({
        ...threadBase,
        start: availableRecruiterSlot,
        status: 'proposed',
        meetingUrl: analysis.meetingUrl,
        notes: message,
      });
      this.interviewCalendar.upsertThread({
        ...threadBase,
        stage: 'awaiting_confirmation',
        offeredSlots: analysis.slots.map((slot) => slot.toISOString()),
        selectedStartAt: availableRecruiterSlot.toISOString(),
        reason: 'Время подходит. Бот принял слот и ждёт подтверждения работодателя.',
      });
      return {
        handled: true,
        reply: `Спасибо! Мне подходит ${formatInterviewSlotRu(availableRecruiterSlot)}. Подтверждаю созвон.`,
      };
    }

    const alternatives = findNextInterviewSlots(settings, calendarState.events, now, 3);
    if (alternatives.length === 0) {
      this.interviewCalendar.upsertThread({
        ...threadBase,
        stage: 'needs_attention',
        offeredSlots: analysis.slots.map((slot) => slot.toISOString()),
        reason: 'В ближайшие четыре недели нет свободного интервала. Освободите время или ответьте HR вручную.',
      });
      return { handled: true };
    }

    const offeredSlots = alternatives.map((slot) => slot.toISOString());
    const proposedByRecruiter = analysis.slots.length > 0;
    this.interviewCalendar.upsertThread({
      ...threadBase,
      stage: 'awaiting_recruiter',
      offeredSlots,
      reason: proposedByRecruiter
        ? 'Варианты HR не совпали с вашей доступностью. Бот предложил ближайшие свободные слоты.'
        : 'Бот предложил работодателю ближайшие свободные слоты.',
    });
    const options = alternatives.map((slot) => formatInterviewSlotRu(slot)).join('; ');
    return {
      handled: true,
      reply: proposedByRecruiter
        ? `К сожалению, предложенное время не подойдёт. Могу созвониться: ${options}. Подойдёт ли один из вариантов?`
        : `Спасибо за приглашение! Мне удобно: ${options}. Подойдёт ли один из вариантов?`,
    };
  }

  private isNegotiationsPage(rawUrl: string): boolean {
    try {
      const url = new URL(rawUrl);
      return url.hostname.endsWith('hh.ru') && url.pathname === '/applicant/negotiations';
    } catch {
      return false;
    }
  }

  private async scrapeNegotiations(page: Page): Promise<NegotiationSummary[]> {
    const result: NegotiationSummary[] = [];
    const items = page.locator(NEGOTIATION_ITEM_SELECTOR);
    const count = Math.min(await items.count(), 40);

    for (let index = 0; index < count; index += 1) {
      const item = items.nth(index);
      if (!(await item.isVisible().catch(() => false))) continue;
      const vacancyTitle = compactText(
        await item.locator(NEGOTIATION_VACANCY_SELECTOR).first().innerText().catch(() => ''),
      );
      const companyName = compactText(
        await item.locator(NEGOTIATION_COMPANY_SELECTOR).first().innerText().catch(() => ''),
      );
      const openChat = item.locator(OPEN_CHAT_SELECTOR).first();
      if ((await openChat.count().catch(() => 0)) === 0) continue;
      const isDiscussion = (await item.locator(DISCUSSION_STATUS_SELECTOR).count().catch(() => 0)) > 0;
      const hasUnread = (await item.locator(UNREAD_STATUS_SELECTOR).count().catch(() => 0)) > 0;
      result.push({
        index,
        key: `${vacancyTitle}\u0000${companyName}`,
        vacancyTitle,
        companyName,
        isDiscussion,
        hasUnread,
      });
    }
    return result;
  }

  private async openNegotiation(page: Page, negotiation: NegotiationSummary): Promise<Frame> {
    const item = page.locator(NEGOTIATION_ITEM_SELECTOR).nth(negotiation.index);
    const button = item.locator(OPEN_CHAT_SELECTOR).first();
    if ((await button.count().catch(() => 0)) === 0) {
      throw new Error('HH изменил кнопку открытия чата.');
    }
    await button.click();

    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const frames = page.frames().filter((frame) => frame.url().includes(CHAT_FRAME_URL_PART));
      for (const frame of frames.reverse()) {
        const header = compactText(
          await frame.locator(CHAT_VACANCY_SELECTOR).first().innerText().catch(() => ''),
        );
        if (
          !negotiation.vacancyTitle ||
          !header ||
          header.toLocaleLowerCase('ru').includes(negotiation.vacancyTitle.toLocaleLowerCase('ru')) ||
          negotiation.vacancyTitle.toLocaleLowerCase('ru').includes(header.toLocaleLowerCase('ru'))
        ) {
          await frame
            .locator(CHAT_MESSAGE_SELECTOR)
            .first()
            .waitFor({ state: 'attached', timeout: 5_000 })
            .catch(() => undefined);
          return frame;
        }
      }
      await this.delay(150);
    }
    throw new Error('HH не открыл чат с работодателем.');
  }

  private async scrapeMessages(frame: Frame): Promise<ChatMessage[]> {
    const messages = frame.locator(CHAT_MESSAGE_SELECTOR);
    const count = Math.min(await messages.count(), 150);
    const result: ChatMessage[] = [];
    for (let index = 0; index < count; index += 1) {
      const message = messages.nth(index);
      const dataQa = (await message.getAttribute('data-qa').catch(() => '')) ?? '';
      if (!/^chatik-chat-message-\d+$/.test(dataQa)) continue;
      if (!(await message.isVisible().catch(() => false))) continue;
      const textNode = message.locator(`[data-qa="${dataQa}-text"]`).first();
      const text = compactText(
        (await textNode.count().catch(() => 0)) > 0
          ? await textNode.innerText().catch(() => '')
          : await message.innerText().catch(() => ''),
      );
      if (!text) continue;
      const ownClass = await message
        .evaluate((element) => {
          const classNames = [
            typeof element.className === 'string' ? element.className : '',
            ...Array.from(element.querySelectorAll('[class]'), (child) =>
              typeof child.className === 'string' ? child.className : ''),
          ];
          return classNames.join(' ');
        })
        .catch(() => '');
      const hasOutgoingDescendant =
        (await message.locator(OUTGOING_SELECTOR).count().catch(() => 0)) > 0;
      result.push({
        id: dataQa,
        text,
        isMine: hasOutgoingDescendant || isOutgoingChatClassName(ownClass),
      });
    }
    return result;
  }

  private async scrapeLastMessage(frame: Frame): Promise<ChatMessage | null> {
    const messages = await this.scrapeMessages(frame);
    return messages.at(-1) ?? null;
  }

  private async sendChatMessage(frame: Frame, text: string): Promise<void> {
    const input = frame.locator(CHAT_INPUT_SELECTOR).first();
    await input.waitFor({ state: 'visible', timeout: 8_000 });
    const beforeIds = new Set((await this.scrapeMessages(frame)).filter((item) => item.isMine).map((item) => item.id));

    await input.fill(text);
    if (compactText(await input.inputValue()) !== compactText(text)) {
      throw new Error('HH не принял текст ответа в поле чата.');
    }

    const sendButton = frame.locator(CHAT_SEND_SELECTOR).first();
    await sendButton.waitFor({ state: 'visible', timeout: 5_000 });
    await sendButton.click();

    const expected = compactText(text);
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const outgoing = (await this.scrapeMessages(frame)).filter(
        (item) => item.isMine && !beforeIds.has(item.id),
      );
      if (outgoing.some((item) => compactText(item.text).includes(expected))) return;
      await this.delay(200);
    }
    throw new Error('HH не подтвердил отправку ответа работодателю.');
  }

  private shouldIgnore(text: string): boolean {
    const lower = text.toLocaleLowerCase('ru');
    return this.config.ignoredKeywords.split(',').some((keyword) => {
      const normalized = keyword.trim().toLocaleLowerCase('ru');
      return Boolean(normalized && lower.includes(normalized));
    });
  }

  private rollDailyCounter(): void {
    const today = this.todayKey();
    if (this.replyDate === today) return;
    this.replyDate = today;
    this.repliesToday = 0;
  }

  private recordReply(): void {
    this.repliesToday += 1;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private todayKey(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private load(): PersistedChatState | null {
    try {
      return JSON.parse(fs.readFileSync(chatStatePath(this.userDataDir), 'utf8')) as PersistedChatState;
    } catch {
      return null;
    }
  }

  private persist(): void {
    try {
      this.rollDailyCounter();
      fs.mkdirSync(path.dirname(chatStatePath(this.userDataDir)), { recursive: true });
      fs.writeFileSync(
        chatStatePath(this.userDataDir),
        JSON.stringify(
          {
            config: this.config,
            seenMessageIds: [...this.seenMessageIds].slice(-500),
            repliesToday: this.repliesToday,
            replyDate: this.replyDate,
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
