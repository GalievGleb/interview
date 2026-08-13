import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CHAT_CONFIG,
  HH_NEGOTIATIONS_URL,
  HhChatBrowser,
  buildGroundedRecruiterReply,
  chatDecisionQuestion,
  detectChatDecisionKind,
  extractCandidateCoreStack,
  extractChatUserInputQuestion,
  findLatestUnansweredRecruiterQuestionnaire,
  formatChatPollError,
  isBotRecruiterLabel,
  isCompleteRecruiterQuestionnaireReply,
  isHhPlatformAssistantMessage,
  isOutgoingChatClassName,
  isRecruiterQuestionnaire,
  isRejectedNegotiationStatus,
  isTerminalChatText,
  normalizeHhNegotiationVacancyUrl,
  prepareRecruiterReply,
  stripTrailingChatTimestamp,
} from './hhChatBrowser';

const source = fs.readFileSync(path.resolve(__dirname, 'hhChatBrowser.ts'), 'utf8');

describe('HhChatBrowser current HH contract', () => {
  it('uses the current applicant negotiations route', () => {
    expect(HH_NEGOTIATIONS_URL).toBe('https://hh.ru/applicant/negotiations');
    expect(source).not.toContain("https://hh.ru/negotiations'");
  });

  it('normalizes vacancy links from negotiations and drops a standalone HH timestamp', () => {
    expect(normalizeHhNegotiationVacancyUrl('/vacancy/136064787?from=negotiations'))
      .toBe('https://hh.ru/vacancy/136064787');
    expect(normalizeHhNegotiationVacancyUrl('https://evil.example/vacancy/136064787')).toBeUndefined();
    expect(stripTrailingChatTimestamp('Буду рад знакомству!\n19:53')).toBe('Буду рад знакомству!');
    expect(stripTrailingChatTimestamp('Созвон в 19:53')).toBe('Созвон в 19:53');
  });

  it('quietly defers a scheduled poll when an invisible HH page is unavailable', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-chat-deferred-'));
    try {
      const getPage = vi.fn(async () => null);
      const chat = new HhChatBrowser(userDataDir, getPage, async () => '');
      const internals = chat as unknown as { pollOnce: (explicit?: boolean) => Promise<void> };
      await internals.pollOnce(false);
      expect(getPage).toHaveBeenCalledWith('background');
      expect(chat.getState().error).toBeNull();
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('uses the current list, Chatik frame, input, and send selectors', () => {
    expect(source).toContain('[data-qa="negotiations-item"]');
    expect(source).toContain('[data-qa="open_chat"]');
    expect(source).toContain("chatik.hh.ru/chat/");
    expect(source).toContain('[data-qa="chatik-new-message-text"]');
    expect(source).toContain('[data-qa="chatik-do-send-message"]');
    expect(source).toContain('timeout: 1_500');
    expect(source).not.toContain('timeout: 8_000');
  });

  it('opens a chat when HH renders an icon instead of vacancy text in the header', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-chat-header-'));
    try {
      const button = {
        count: () => Promise.resolve(1),
        click: vi.fn(async () => undefined),
      };
      const frame = {
        url: () => 'https://chatik.hh.ru/chat/123',
        locator: (selector: string) => {
          if (selector === '[data-qa="chatik-header-vacancy-link-text"]') {
            return { first: () => ({ innerText: () => Promise.resolve('') }) };
          }
          if (selector === 'body') {
            return { innerText: () => Promise.resolve('Вакансия\nQA Automation Engineer / AQA') };
          }
          return { first: () => ({ waitFor: () => Promise.resolve() }) };
        },
      };
      const page = {
        locator: () => ({ nth: () => ({ locator: () => ({ first: () => button }) }) }),
        frames: () => [frame],
      };
      const chat = new HhChatBrowser(userDataDir, async () => null, async () => '');
      const internals = chat as unknown as {
        openNegotiation: (
          currentPage: typeof page,
          negotiation: {
            index: number;
            vacancyTitle: string;
            isRejected: boolean;
          },
        ) => Promise<typeof frame>;
      };

      await expect(internals.openNegotiation(page, {
        index: 0,
        vacancyTitle: 'QA Automation Engineer / AQA',
        isRejected: false,
      })).resolves.toBe(frame);
      expect(button.click).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('recognizes the live HH rejection badge without confusing the applicant decline button', () => {
    expect(
      isRejectedNegotiationStatus(
        'negotiations-tag negotiations-item-discard',
        'Отказ',
      ),
    ).toBe(true);
    expect(isRejectedNegotiationStatus('', 'Отказ QA Lead Компания')).toBe(true);
    expect(isRejectedNegotiationStatus('negotiations-decline', 'Отказаться')).toBe(false);
  });

  it('answers a stack question directly from the verified candidate profile', () => {
    const profile = [
      'CANDIDATE PROFILE:',
      '- Core stack: Python, Pytest, Playwright, API тестирование, UI тестирование, Jenkins, Docker.',
      '',
      'LIKELY GAPS:',
      '- Kafka — no confirmed experience.',
    ].join('\n');

    expect(extractCandidateCoreStack(profile)).toEqual([
      'Python',
      'Pytest',
      'Playwright',
      'API тестирование',
      'UI тестирование',
      'Jenkins',
      'Docker',
    ]);
    expect(
      buildGroundedRecruiterReply(
        'Какой основной стек автоматизации тестирования вы используете?',
        profile,
      ),
    ).toBe(
      'Основной стек автоматизации — Python, Pytest и Playwright. ' +
      'Пишу UI- и API-автотесты, также использую Jenkins и Docker.',
    );
  });

  it('blocks product leakage, irrelevant test tasks, generic vacancy replies and signatures', () => {
    const recruiterMessage = 'Какой основной стек автоматизации тестирования вы используете?';
    const broken = [
      'Здравствуйте! Спасибо за информацию о вакансии QA Automation Engineer.',
      'Если потребуется тестовое задание, уточните сроки.',
      'Давайте согласуем время через календарь SkillCue.',
      'С уважением, Кандидат',
    ].join(' ');
    expect(prepareRecruiterReply(broken, recruiterMessage)).toBeNull();
    expect(
      prepareRecruiterReply(
        'Основной стек — Python, Pytest и Playwright. Пишу UI- и API-автотесты.',
        recruiterMessage,
      ),
    ).toBe('Основной стек — Python, Pytest и Playwright. Пишу UI- и API-автотесты.');
    expect(DEFAULT_CHAT_CONFIG.replyPrompt).not.toMatch(/SkillCue/i);
  });

  it('treats the seven recruiter questions as one questionnaire and ignores Haddy', () => {
    const questionnaire = [
      'Хотели бы уточнить у вас несколько вопросов:',
      '1) Для чего QA использует Charles, Proxyman и Fiddler?',
      '2) Назовите причины ошибки Request Timeout',
      '3) Какие инструменты полезны для снятия логов браузера и мобильных приложений?',
      '4) С какими типами тестирования вы работали?',
      '5) Что позволяет оценить качество тестирования?',
      '6) Использовали ли вы LLM инструменты?',
      '7) Какие у вас зарплатные ожидания?',
    ].join('\n');
    const haddy = [
      'Бот-помощник Хэдди',
      'Ответьте на приглашение, даже если оно вам не интересно.',
      'Так мы сможем рекомендовать вам более подходящие вакансии.',
    ].join(' ');
    const fullReply = Array.from({ length: 7 }, (_, index) => (
      `${index + 1}) Конкретный ответ на пункт работодателя с достаточным пояснением.`
    )).join('\n');

    expect(isRecruiterQuestionnaire(questionnaire)).toBe(true);
    expect(isHhPlatformAssistantMessage(haddy)).toBe(true);
    expect(isCompleteRecruiterQuestionnaireReply(questionnaire, 'Ожидаю 250 000 ₽ на руки.'))
      .toBe(false);
    expect(isCompleteRecruiterQuestionnaireReply(questionnaire, fullReply)).toBe(true);
    expect(findLatestUnansweredRecruiterQuestionnaire([
      { id: 'questionnaire', text: questionnaire, isMine: false },
      { id: 'haddy', text: haddy, isMine: false, isSystem: true },
      { id: 'generic', text: 'Спасибо за приглашение! Буду рад рекомендациям.', isMine: true },
    ])).toMatchObject({ id: 'questionnaire' });
    expect(findLatestUnansweredRecruiterQuestionnaire([
      { id: 'questionnaire', text: questionnaire, isMine: false },
      { id: 'answer', text: fullReply, isMine: true },
    ])).toBeNull();
    expect(findLatestUnansweredRecruiterQuestionnaire([
      { id: 'questionnaire', text: questionnaire, isMine: false },
      { id: 'answer-1', text: '1) Подробно ответил на первые вопросы, описал инструменты и диагностику.', isMine: true },
      { id: 'answer-2', text: 'Остальные пункты отправил вторым сообщением, включая зарплатные ожидания.', isMine: true },
    ])).toBeNull();
    expect(findLatestUnansweredRecruiterQuestionnaire([
      { id: 'questionnaire', text: questionnaire, isMine: false },
      { id: 'follow-up', text: 'Спасибо, ответы получили. Когда готовы созвониться?', isMine: false },
    ])).toBeNull();

    const prepared = prepareRecruiterReply(fullReply, questionnaire);
    expect(prepared).toContain('\n2)');
    expect(prepared).toContain('\n7)');
    expect(prepareRecruiterReply('7) Ожидаю 250 000 ₽ на руки.', questionnaire)).toBeNull();
  });

  it('migrates a persisted unsafe reply prompt instead of keeping it after an update', () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-chat-migration-'));
    try {
      fs.writeFileSync(path.join(userDataDir, 'hh-chat-browser.json'), JSON.stringify({
        config: {
          ...DEFAULT_CHAT_CONFIG,
          replyPrompt: 'Согласуй через календарь SkillCue. Всегда упомяни тестовое задание.',
        },
        seenMessageIds: [],
        repliesToday: 0,
        replyDate: '2026-08-08',
      }), 'utf8');
      const chat = new HhChatBrowser(userDataDir, async () => null, async () => '');

      expect(chat.getConfig().replyPrompt).toBe(DEFAULT_CHAT_CONFIG.replyPrompt);
      expect(fs.readFileSync(path.join(userDataDir, 'hh-chat-browser.json'), 'utf8'))
        .not.toMatch(/SkillCue/);
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('migrates the legacy daily counter to replies that have an inspectable journal record', () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-chat-counter-'));
    const now = new Date();
    const replyDate = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    try {
      fs.writeFileSync(path.join(userDataDir, 'hh-chat-browser.json'), JSON.stringify({
        config: DEFAULT_CHAT_CONFIG,
        seenMessageIds: [],
        repliesToday: 7,
        replyDate,
        replyHistory: [{
          id: 'reply-1',
          negotiationKey: 'vacancy\u0000company',
          messageId: 'vacancy\u0000company:chatik-chat-message-1',
          vacancyTitle: 'Vacancy',
          companyName: 'Company',
          recruiterMessage: 'Question',
          reply: 'Answer',
          source: 'generated',
          status: 'sent',
          sentAt: now.toISOString(),
          recordedAt: now.toISOString(),
        }],
      }), 'utf8');

      const chat = new HhChatBrowser(userDataDir, async () => null, async () => '');

      expect(chat.getState().repliesToday).toBe(1);
      const persisted = JSON.parse(
        fs.readFileSync(path.join(userDataDir, 'hh-chat-browser.json'), 'utf8'),
      ) as { repliesToday: number; replyHistoryVersion: number };
      expect(persisted).toMatchObject({ repliesToday: 1, replyHistoryVersion: 1 });
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('recognizes a chat where HH does not allow a reply and hides raw Playwright timeouts', () => {
    expect(
      isTerminalChatText('Переписка будет доступна после приглашения работодателя'),
    ).toBe(true);
    expect(
      isTerminalChatText('К сожалению, в настоящий момент мы не готовы пригласить Вас на дальнейшее интервью'),
    ).toBe(true);
    expect(isTerminalChatText('Приглашаем вас на интервью завтра в 12:00')).toBe(false);

    const message = formatChatPollError(
      new Error("locator.waitFor: Timeout 8000ms exceeded waiting for [data-qa='chatik-new-message-text']"),
    );
    expect(message).toContain('Диалог временно пропущен');
    expect(message).not.toContain('locator.waitFor');
    expect(message).not.toContain('8000ms');
  });

  it('skips rejected negotiations before opening them and continues after one chat fails', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-chat-'));
    try {
      const rejectedMessageId = 'rejected:chatik-chat-message-1';
      fs.writeFileSync(path.join(userDataDir, 'hh-chat-browser.json'), JSON.stringify({
        config: DEFAULT_CHAT_CONFIG,
        seenMessageIds: [rejectedMessageId],
        repliesToday: 0,
        replyDate: '2000-01-01',
      }), 'utf8');
      const page = {
        isClosed: () => false,
        url: () => HH_NEGOTIATIONS_URL,
        locator: () => ({
          first: () => ({ waitFor: () => Promise.resolve() }),
        }),
      };
      const llmCall = vi.fn(async () => 'Ответ работодателю');
      const chat = new HhChatBrowser(
        userDataDir,
        async () => page as never,
        llmCall,
      );
      const negotiations = [
        {
          index: 0,
          key: 'rejected',
          vacancyTitle: 'Rejected vacancy',
          companyName: 'Rejected company',
          isDiscussion: false,
          hasUnread: true,
          isRejected: true,
        },
        {
          index: 1,
          key: 'broken',
          vacancyTitle: 'Broken chat',
          companyName: 'Company A',
          isDiscussion: false,
          hasUnread: true,
          isRejected: false,
        },
        {
          index: 2,
          key: 'healthy',
          vacancyTitle: 'Healthy chat',
          companyName: 'Company B',
          isDiscussion: false,
          hasUnread: false,
          isRejected: false,
        },
      ];
      const frame = {
        locator: (selector: string) => selector === 'body'
          ? { innerText: () => Promise.resolve('Обычный активный чат') }
          : { first: () => ({ isVisible: () => Promise.resolve(false) }) },
      };
      type Negotiation = (typeof negotiations)[number];
      const internals = chat as unknown as {
        scrapeNegotiations: () => Promise<Negotiation[]>;
        openNegotiation: (page: unknown, negotiation: Negotiation) => Promise<typeof frame>;
        scrapeMessages: (currentFrame: typeof frame) => Promise<Array<{
          id: string;
          text: string;
          isMine: boolean;
        }>>;
        pollOnce: () => Promise<void>;
      };
      vi.spyOn(internals, 'scrapeNegotiations').mockResolvedValue(negotiations);
      const openNegotiation = vi
        .spyOn(internals, 'openNegotiation')
        .mockImplementation(async (_page: unknown, negotiation: { key: string }) => {
          if (negotiation.key === 'broken') throw new Error('one broken chat');
          return frame;
        });
      vi.spyOn(internals, 'scrapeMessages').mockResolvedValue([{
        id: 'chatik-chat-message-1',
        text: 'Расскажите подробнее о вашем опыте',
        isMine: false,
      }]);

      await internals.pollOnce();

      expect(openNegotiation).toHaveBeenCalledTimes(2);
      expect(openNegotiation.mock.calls.map((call) => (call[1] as { key: string }).key))
        .toEqual(['broken', 'healthy']);
      expect(chat.getState().error).toContain('Временно пропущено чатов: 1');
      expect(chat.getState().error).not.toContain('one broken chat');
      expect(llmCall).not.toHaveBeenCalled();
      const persisted = JSON.parse(
        fs.readFileSync(path.join(userDataDir, 'hh-chat-browser.json'), 'utf8'),
      ) as { seenMessageIds: string[] };
      expect(persisted.seenMessageIds).not.toContain(rejectedMessageId);
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('checks chats in small rotating batches so one pass cannot block the whole inbox', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-chat-batches-'));
    try {
      const page = {
        isClosed: () => false,
        url: () => HH_NEGOTIATIONS_URL,
        locator: () => ({ first: () => ({ waitFor: () => Promise.resolve() }) }),
      };
      const frame = {
        locator: () => ({ innerText: () => Promise.resolve('Обычный активный чат') }),
      };
      const negotiations = Array.from({ length: 6 }, (_, index) => ({
        index,
        key: `vacancy-${index}`,
        vacancyTitle: `Vacancy ${index}`,
        companyName: `Company ${index}`,
        isDiscussion: true,
        hasUnread: false,
        isRejected: false,
      }));
      const chat = new HhChatBrowser(userDataDir, async () => page as never, async () => '');
      const internals = chat as unknown as {
        scrapeNegotiations: () => Promise<typeof negotiations>;
        openNegotiation: (_page: unknown, negotiation: typeof negotiations[number]) => Promise<typeof frame>;
        scrapeMessages: () => Promise<Array<{ id: string; text: string; isMine: boolean }>>;
        pollOnce: () => Promise<void>;
      };
      vi.spyOn(internals, 'scrapeNegotiations').mockResolvedValue(negotiations);
      const openNegotiation = vi.spyOn(internals, 'openNegotiation').mockResolvedValue(frame);
      vi.spyOn(internals, 'scrapeMessages').mockResolvedValue([{
        id: 'chatik-chat-message-1',
        text: 'Уже отвечено',
        isMine: true,
      }]);

      await internals.pollOnce();
      expect(openNegotiation.mock.calls.map((call) => call[1].key)).toEqual([
        'vacancy-0', 'vacancy-1', 'vacancy-2', 'vacancy-3',
      ]);
      expect(chat.getState().checkedNegotiations).toBe(4);

      openNegotiation.mockClear();
      await internals.pollOnce();
      expect(openNegotiation.mock.calls.map((call) => call[1].key)).toEqual([
        'vacancy-4', 'vacancy-5', 'vacancy-0', 'vacancy-1',
      ]);
      expect(chat.getState().checkedNegotiations).toBe(4);
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('finds unresolved legacy replies on the next HH negotiation pages', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-chat-pages-'));
    try {
      let currentUrl = HH_NEGOTIATIONS_URL;
      const page = {
        url: () => currentUrl,
        goto: vi.fn(async (url: string) => { currentUrl = url; }),
        locator: () => ({ first: () => ({ waitFor: () => Promise.resolve() }) }),
      };
      const target = {
        index: 3,
        key: 'QA Automation Engineer / AQA\u0000Qualitica',
        vacancyTitle: 'QA Automation Engineer / AQA',
        companyName: 'Qualitica',
        isDiscussion: true,
        hasUnread: false,
        isRejected: false,
      };
      const chat = new HhChatBrowser(userDataDir, async () => null, async () => '');
      const internals = chat as unknown as {
        scrapeNegotiations: () => Promise<typeof target[]>;
        findNegotiationsPage: (
          currentPage: typeof page,
          priorityKeys: Set<string>,
        ) => Promise<typeof target[]>;
      };
      vi.spyOn(internals, 'scrapeNegotiations').mockImplementation(async () =>
        currentUrl.endsWith('?page=1') ? [target] : []);

      const found = await internals.findNegotiationsPage(page, new Set([target.key]));

      expect(found).toEqual([target]);
      expect(page.goto).toHaveBeenCalledWith(
        `${HH_NEGOTIATIONS_URL}?page=1`,
        expect.objectContaining({ waitUntil: 'domcontentloaded' }),
      );
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('recognizes the outgoing classes currently rendered by Chatik', () => {
    expect(isOutgoingChatClassName('message_my abc')).toBe(true);
    expect(isOutgoingChatClassName('chat-bubble_outgoing')).toBe(true);
    expect(isOutgoingChatClassName('chat-bubble_incoming')).toBe(false);
  });

  it('examines the newest real message, ignores HH participant notices, and never replies after an applicant message', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-chat-last-message-'));
    const chat = new HhChatBrowser(userDataDir, async () => null, async () => '');
    const internals = chat as unknown as {
      scrapeLastMessage: (
        frame: Record<string, never>,
        messages: Array<{ id: string; text: string; isMine: boolean; isSystem?: boolean }>,
      ) => Promise<{ id: string; text: string; isMine: boolean; isSystem?: boolean } | null>;
    };
    try {
      await expect(internals.scrapeLastMessage({}, [
        { id: 'question', text: 'Рассматриваете ИП/СМЗ?', isMine: false },
        { id: 'notice', text: 'Пользователь Робот-рекрутер покинул чат', isMine: false, isSystem: true },
      ])).resolves.toMatchObject({ id: 'question' });
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
    expect(source).toContain('if (!messages[index].isSystem) return messages[index]');
    expect(source).toContain('if (!lastMessage || (!unansweredQuestionnaire && lastMessage.isMine)) continue');
  });

  it('repairs the exact missed questionnaire even after Haddy and a generic applicant reply', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-chat-questionnaire-'));
    const negotiationKey = 'Старший инженер-тестировщик\u0000Правительство Москвы';
    const questionnaire = [
      'Хотели бы уточнить у вас несколько вопросов:',
      '1) Для чего в роли QA используются такие инструменты как Charles, Proxyman, Fiddler? Что такое Map Local, Breakpoint и Rewrite?',
      '2) Назовите все возможные причины ошибки Request Timeout',
      '3) Какие инструменты полезны для снятия логов браузера и мобильных приложений на iOS и Android?',
      '4) С какими типами тестирования вы работали на практике?',
      '5) Что позволяет вам оценить качество тестирования?',
      '6) Использовали ли вы в работе LLM инструменты? Если да, то какие и для каких целей?',
      '7) Какие у вас зарплатные ожидания?',
    ].join('\n');
    const generated = [
      '1) Использую прокси для анализа и модификации HTTP/HTTPS-трафика.',
      '2) Проверяю клиент, сеть, прокси и время обработки на сервере.',
      '3) Для браузера использую DevTools, для Android — adb logcat, для iOS — Xcode и Console.',
      '4) Работал с функциональным, регрессионным, smoke, интеграционным, API, UI и e2e-тестированием.',
      '5) Оцениваю качество по рискам, покрытию, дефектам и стабильности прогонов.',
      '6) Использую ChatGPT и Codex для анализа логов и черновиков тестов с обязательной проверкой результата.',
      '7) Ожидаю 250 000 ₽ на руки.',
    ].join('\n');
    try {
      const page = {
        isClosed: () => false,
        url: () => HH_NEGOTIATIONS_URL,
        locator: () => ({ first: () => ({ waitFor: () => Promise.resolve() }) }),
      };
      const frame = {
        locator: (selector: string) => selector === 'body'
          ? { innerText: () => Promise.resolve('Обычный активный чат') }
          : { first: () => ({ isVisible: () => Promise.resolve(true) }) },
      };
      const negotiation = {
        index: 0,
        key: negotiationKey,
        vacancyTitle: 'Старший инженер-тестировщик',
        companyName: 'Правительство Москвы',
        isDiscussion: true,
        hasUnread: false,
        isRejected: false,
      };
      const llmCall = vi.fn(async () => generated);
      const getCandidateProfile = vi.fn(async () => (
        'Старший QA Automation Engineer, 4 года. Python, Pytest, Playwright, Charles Proxy. 250 000 ₽ на руки.'
      ));
      const chat = new HhChatBrowser(
        userDataDir,
        async () => page as never,
        llmCall,
        undefined,
        undefined,
        getCandidateProfile,
      );
      chat.saveConfig({ replyDelaySec: 0 });
      const internals = chat as unknown as {
        scrapeNegotiations: () => Promise<typeof negotiation[]>;
        openNegotiation: () => Promise<typeof frame>;
        scrapeMessages: () => Promise<Array<{
          id: string;
          text: string;
          isMine: boolean;
          isSystem?: boolean;
        }>>;
        sendChatMessage: (currentFrame: typeof frame, answer: string) => Promise<void>;
        pollOnce: (explicit?: boolean) => Promise<void>;
      };
      vi.spyOn(internals, 'scrapeNegotiations').mockResolvedValue([negotiation]);
      vi.spyOn(internals, 'openNegotiation').mockResolvedValue(frame);
      vi.spyOn(internals, 'scrapeMessages').mockResolvedValue([
        { id: 'chatik-chat-message-questionnaire', text: questionnaire, isMine: false },
        {
          id: 'chatik-chat-message-haddy',
          text: 'Бот-помощник Хэдди. Ответьте на приглашение — так мы сможем рекомендовать вам более подходящие вакансии.',
          isMine: false,
          isSystem: true,
        },
        { id: 'chatik-chat-message-generic', text: 'Спасибо за приглашение! Буду рад рекомендациям.', isMine: true },
      ]);
      const sendChatMessage = vi.spyOn(internals, 'sendChatMessage').mockResolvedValue();

      await internals.pollOnce(true);

      expect(llmCall).toHaveBeenCalledOnce();
      expect(llmCall.mock.calls[0][0]).toContain('Ответь на КАЖДЫЙ пункт');
      expect(llmCall.mock.calls[0][0]).toContain('250 000 ₽ на руки');
      expect(sendChatMessage).toHaveBeenCalledWith(frame, generated);
      expect(chat.getState().replyHistory[0]).toMatchObject({
        recruiterMessage: questionnaire,
        reply: generated,
        source: 'generated',
      });
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('counts a reply only after HH renders a new matching outgoing message', () => {
    const sendAt = source.indexOf('private async sendChatMessage');
    const pollAt = source.indexOf('private async pollOnce');
    const pollSource = source.slice(pollAt, sendAt);
    const sendCallAt = pollSource.indexOf('await this.sendChatMessage(frame, reply)');
    const replyCountAt = pollSource.indexOf('this.recordReply({', sendCallAt);
    const sendSource = source.slice(sendAt);
    expect(sendSource).toContain('!beforeIds.has(item.id)');
    expect(sendSource).toContain('HH не подтвердил отправку ответа работодателю');
    expect(sendCallAt).toBeGreaterThan(-1);
    expect(replyCountAt).toBeGreaterThan(sendCallAt);
    expect(source).toContain('const CHAT_BATCH_SIZE = 4');
    expect(source).toContain('const CHAT_RECOVERY_PAGE_LIMIT = 3');
    expect(source).toContain('.slice(0, CHAT_BATCH_SIZE)');
    expect(source).toContain('this.pollCursor');
    expect(source).toContain('this.settleWithin(this.llmCall(prompt), 20_000');
  });

  it('asks the user about unknown employment conditions and recognizes robot recruiters', () => {
    expect(detectChatDecisionKind('Готовы работать как ИП или самозанятый?')).toBe('contract');
    expect(detectChatDecisionKind('Какие у вас зарплатные ожидания?')).toBe('salary');
    expect(detectChatDecisionKind('Напишите желаемый уровень заработной платы (минимум и комфорт)')).toBe('salary');
    expect(detectChatDecisionKind('Напишите желаемый уровень заработной планы (минимум и комфорт)')).toBe('salary');
    expect(detectChatDecisionKind('Ваш опыт в автотестировании более 1 года?')).toBe('experience');
    expect(detectChatDecisionKind('Расскажите о вашем опыте с Playwright')).toBeNull();
    expect(chatDecisionQuestion('contract')).toContain('ИП');
    expect(isBotRecruiterLabel('Сообщение от робота-рекрутера')).toBe(true);
    expect(extractChatUserInputQuestion('NEEDS_USER_INPUT: Работали ли вы с Kafka?'))
      .toBe('Работали ли вы с Kafka?');
    expect(extractChatUserInputQuestion('Да, работал с Kafka.')).toBeNull();
    expect(source).toContain('confirmedFacts.find((item) => item.kind === decisionKind)');
    expect(source).toContain('pendingDecisions.push({');
    expect(source).toContain('notifiedInterviewMessageIds');
    expect(source).toContain("kind: 'candidate_fact'");
  });

  it('clicks an HH yes/no quick reply and verifies the outgoing answer', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-chat-quick-reply-'));
    try {
      const yesButton = {
        isVisible: () => Promise.resolve(true),
        innerText: () => Promise.resolve('Да'),
        click: vi.fn(async () => undefined),
      };
      const noButton = {
        isVisible: () => Promise.resolve(true),
        innerText: () => Promise.resolve('Нет'),
        click: vi.fn(async () => undefined),
      };
      const frame = {
        locator: (selector: string) => {
          if (selector !== 'button') throw new Error(`Unexpected selector: ${selector}`);
          return {
            count: () => Promise.resolve(2),
            nth: (index: number) => index === 0 ? yesButton : noButton,
          };
        },
      };
      const chat = new HhChatBrowser(userDataDir, async () => null, async () => '');
      const internals = chat as unknown as {
        scrapeMessages: () => Promise<Array<{ id: string; text: string; isMine: boolean }>>;
        sendChatAnswer: (currentFrame: typeof frame, answer: string) => Promise<void>;
      };
      vi.spyOn(internals, 'scrapeMessages')
        .mockResolvedValueOnce([])
        .mockResolvedValue([{ id: 'chatik-chat-message-yes', text: 'Да', isMine: true }]);

      await internals.sendChatAnswer(frame, 'Да');

      expect(yesButton.click).toHaveBeenCalledOnce();
      expect(noButton.click).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('recognizes a recruiter handoff to Telegram as a high-priority notification', async () => {
    const { isTelegramHandoffMessage } = await import('./hhChatBrowser');

    expect(isTelegramHandoffMessage('Продолжим в Telegram, напишите мне @maria_hr')).toBe(true);
    expect(isTelegramHandoffMessage('Ссылка на чат: https://t.me/maria_hr')).toBe(true);
    expect(isTelegramHandoffMessage('У нас есть корпоративный Telegram-канал')).toBe(false);
  });

  it('stores the exact recruiter message and confirmed answer after HH accepts it', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-chat-history-'));
    const negotiationKey = 'QA Automation Engineer\u0000Garpix';
    const messageId = `${negotiationKey}:chatik-chat-message-42`;
    try {
      fs.writeFileSync(path.join(userDataDir, 'hh-chat-browser.json'), JSON.stringify({
        config: { ...DEFAULT_CHAT_CONFIG, replyDelaySec: 0 },
        seenMessageIds: [],
        repliesToday: 0,
        replyDate: '2000-01-01',
        pendingDecisions: [{
          id: 'decision-1',
          negotiationKey,
          messageId,
          vacancyTitle: 'QA Automation Engineer',
          companyName: 'Garpix',
          recruiterMessage: 'Рассматриваете ли оформление по ИП/СМЗ на испытательный срок?',
          question: chatDecisionQuestion('contract'),
          kind: 'contract',
          createdAt: new Date().toISOString(),
        }],
      }), 'utf8');
      const page = { isClosed: () => false, url: () => HH_NEGOTIATIONS_URL };
      const chat = new HhChatBrowser(userDataDir, async () => page as never, async () => '');
      const internals = chat as unknown as {
        scrapeNegotiations: () => Promise<Array<{
          index: number;
          key: string;
          vacancyTitle: string;
          companyName: string;
          isDiscussion: boolean;
          hasUnread: boolean;
          isRejected: boolean;
        }>>;
        openNegotiation: () => Promise<Record<string, never>>;
        sendChatMessage: () => Promise<void>;
      };
      vi.spyOn(internals, 'scrapeNegotiations').mockResolvedValue([{
        index: 0,
        key: negotiationKey,
        vacancyTitle: 'QA Automation Engineer',
        companyName: 'Garpix',
        isDiscussion: true,
        hasUnread: true,
        isRejected: false,
      }]);
      vi.spyOn(internals, 'openNegotiation').mockResolvedValue({});
      const sendChatMessage = vi.spyOn(internals, 'sendChatMessage').mockResolvedValue();
      const answer = 'Да, рассматриваю оформление по ИП или как самозанятый на испытательный срок.';

      const state = await chat.answerDecision('decision-1', answer, true);

      expect(sendChatMessage).toHaveBeenCalledWith({}, answer);
      expect(state.repliesToday).toBe(1);
      expect(state.replyHistory).toHaveLength(1);
      expect(state.replyHistory[0]).toMatchObject({
        messageId,
        recruiterMessage: 'Рассматриваете ли оформление по ИП/СМЗ на испытательный срок?',
        reply: answer,
        source: 'user_confirmed',
        status: 'sent',
      });
      expect(state.replyHistory[0].sentAt).toEqual(expect.any(String));

      const restored = new HhChatBrowser(userDataDir, async () => null, async () => '');
      expect(restored.getState().replyHistory[0]).toMatchObject({ messageId, reply: answer });
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('retries a legacy seen recruiter question when no outgoing answer exists', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-chat-retry-'));
    const negotiationKey = 'TeamLead/Руководитель разработки\u0000Гарпикс';
    const messageId = `${negotiationKey}:chatik-chat-message-15035509748`;
    try {
      fs.writeFileSync(path.join(userDataDir, 'hh-chat-browser.json'), JSON.stringify({
        config: { ...DEFAULT_CHAT_CONFIG, replyDelaySec: 0 },
        seenMessageIds: [messageId],
        repliesToday: 0,
        replyDate: '2000-01-01',
      }), 'utf8');
      const page = {
        isClosed: () => false,
        url: () => HH_NEGOTIATIONS_URL,
        locator: () => ({ first: () => ({ waitFor: () => Promise.resolve() }) }),
      };
      const frame = {
        locator: (selector: string) => selector === 'body'
          ? { innerText: () => Promise.resolve('Обычный активный чат') }
          : { first: () => ({ isVisible: () => Promise.resolve(true) }) },
      };
      const negotiation = {
        index: 0,
        key: negotiationKey,
        vacancyTitle: 'TeamLead/Руководитель разработки',
        companyName: 'Гарпикс',
        isDiscussion: false,
        hasUnread: true,
        isRejected: false,
      };
      const chat = new HhChatBrowser(userDataDir, async () => page as never, async () => '');
      const internals = chat as unknown as {
        scrapeNegotiations: () => Promise<typeof negotiation[]>;
        openNegotiation: () => Promise<typeof frame>;
        scrapeMessages: () => Promise<Array<{ id: string; text: string; isMine: boolean }>>;
        pollOnce: () => Promise<void>;
      };
      vi.spyOn(internals, 'scrapeNegotiations').mockResolvedValue([negotiation]);
      vi.spyOn(internals, 'openNegotiation').mockResolvedValue(frame);
      vi.spyOn(internals, 'scrapeMessages').mockResolvedValue([{
        id: 'chatik-chat-message-15035509748',
        text: 'Рассматриваете ли оформление по ИП/СМЗ на испытательный срок?',
        isMine: false,
      }]);

      await internals.pollOnce();

      expect(chat.getState().pendingDecisions).toHaveLength(1);
      expect(chat.getState().pendingDecisions[0]).toMatchObject({
        messageId,
        kind: 'contract',
        companyName: 'Гарпикс',
      });
      const persisted = JSON.parse(fs.readFileSync(path.join(userDataDir, 'hh-chat-browser.json'), 'utf8')) as {
        seenMessageIds: string[];
      };
      expect(persisted.seenMessageIds).not.toContain(messageId);
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('answers a salary question from the selected HH resume and clears an old pending decision', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-chat-resume-salary-'));
    const negotiationKey = 'QA Automation Engineer\u0000Айдеко';
    const messageId = `${negotiationKey}:chatik-chat-message-240`;
    try {
      fs.writeFileSync(path.join(userDataDir, 'hh-chat-browser.json'), JSON.stringify({
        config: { ...DEFAULT_CHAT_CONFIG, replyDelaySec: 0 },
        seenMessageIds: [],
        repliesToday: 0,
        replyDate: '2000-01-01',
        pendingDecisions: [{
          id: 'salary-decision',
          negotiationKey,
          messageId,
          vacancyTitle: 'QA Automation Engineer',
          companyName: 'Айдеко',
          recruiterMessage: 'Напишите желаемый уровень заработной платы (минимум и комфорт)',
          question: chatDecisionQuestion('salary'),
          kind: 'salary',
          createdAt: new Date().toISOString(),
        }],
      }), 'utf8');
      const page = {
        isClosed: () => false,
        url: () => HH_NEGOTIATIONS_URL,
        locator: () => ({ first: () => ({ waitFor: () => Promise.resolve() }) }),
      };
      const frame = {
        locator: (selector: string) => selector === 'body'
          ? { innerText: () => Promise.resolve('Обычный активный чат') }
          : { first: () => ({ isVisible: () => Promise.resolve(true) }) },
      };
      const negotiation = {
        index: 0,
        key: negotiationKey,
        vacancyTitle: 'QA Automation Engineer',
        companyName: 'Айдеко',
        isDiscussion: false,
        hasUnread: true,
        isRejected: false,
      };
      const getCandidateProfile = vi.fn(async () => (
        'QA Automation Engineer · 240 000 ₽ на руки · удалённо\nPython, Pytest, Docker'
      ));
      const chat = new HhChatBrowser(
        userDataDir,
        async () => page as never,
        async () => '',
        undefined,
        undefined,
        getCandidateProfile,
      );
      const internals = chat as unknown as {
        scrapeNegotiations: () => Promise<typeof negotiation[]>;
        openNegotiation: () => Promise<typeof frame>;
        scrapeMessages: () => Promise<Array<{ id: string; text: string; isMine: boolean }>>;
        sendChatMessage: (currentFrame: typeof frame, answer: string) => Promise<void>;
        pollOnce: () => Promise<void>;
      };
      vi.spyOn(internals, 'scrapeNegotiations').mockResolvedValue([negotiation]);
      vi.spyOn(internals, 'openNegotiation').mockResolvedValue(frame);
      vi.spyOn(internals, 'scrapeMessages').mockResolvedValue([{
        id: 'chatik-chat-message-240',
        text: 'Напишите желаемый уровень заработной платы (минимум и комфорт)',
        isMine: false,
      }]);
      const sendChatMessage = vi.spyOn(internals, 'sendChatMessage').mockResolvedValue();

      await internals.pollOnce();

      expect(getCandidateProfile).toHaveBeenCalledWith('QA Automation Engineer');
      expect(sendChatMessage).toHaveBeenCalledWith(
        frame,
        'Минимум — 240 000 ₽ на руки; комфортный уровень готов обсудить с учётом задач и общего компенсационного пакета.',
      );
      expect(chat.getState().pendingDecisions).toHaveLength(0);
      expect(chat.getState().replyHistory[0]).toMatchObject({
        messageId,
        source: 'resume_fact',
      });
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('restores an older exact answer from HH without incrementing today counter', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-chat-recover-'));
    const negotiationKey = 'QA Automation Engineer\u0000Qualitica';
    const messageId = `${negotiationKey}:chatik-chat-message-12`;
    const today = new Date();
    const replyDate = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-');
    try {
      fs.writeFileSync(path.join(userDataDir, 'hh-chat-browser.json'), JSON.stringify({
        config: { ...DEFAULT_CHAT_CONFIG, replyDelaySec: 0 },
        seenMessageIds: [messageId],
        repliesToday: 2,
        replyDate,
        replyHistoryVersion: 1,
      }), 'utf8');
      const page = {
        isClosed: () => false,
        url: () => HH_NEGOTIATIONS_URL,
        locator: () => ({ first: () => ({ waitFor: () => Promise.resolve() }) }),
      };
      const frame = { locator: () => ({ innerText: () => Promise.resolve('Обычный активный чат') }) };
      const negotiation = {
        index: 0,
        key: negotiationKey,
        vacancyTitle: 'QA Automation Engineer',
        companyName: 'Qualitica',
        isDiscussion: true,
        hasUnread: false,
        isRejected: false,
      };
      const chat = new HhChatBrowser(userDataDir, async () => page as never, async () => '');
      const internals = chat as unknown as {
        scrapeNegotiations: () => Promise<typeof negotiation[]>;
        openNegotiation: () => Promise<typeof frame>;
        scrapeMessages: () => Promise<Array<{ id: string; text: string; isMine: boolean; isSystem?: boolean }>>;
        pollOnce: () => Promise<void>;
      };
      vi.spyOn(internals, 'scrapeNegotiations').mockResolvedValue([negotiation]);
      vi.spyOn(internals, 'openNegotiation').mockResolvedValue(frame);
      vi.spyOn(internals, 'scrapeMessages').mockResolvedValue([
        { id: 'chatik-chat-message-10', text: 'Какой основной стек автоматизации тестирования вы используете?', isMine: false },
        { id: 'chatik-chat-message-12', text: 'Пользователь Робот-рекрутер покинул чат', isMine: false, isSystem: true },
        { id: 'chatik-chat-message-13', text: 'Основной стек — Python, Pytest и Playwright.', isMine: true },
      ]);

      await internals.pollOnce();

      const state = chat.getState();
      expect(state.repliesToday).toBe(2);
      expect(state.replyHistory).toEqual([expect.objectContaining({
        messageId,
        recruiterMessage: 'Какой основной стек автоматизации тестирования вы используете?',
        reply: 'Основной стек — Python, Pytest и Playwright.',
        source: 'recovered',
        sentAt: null,
      })]);
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
