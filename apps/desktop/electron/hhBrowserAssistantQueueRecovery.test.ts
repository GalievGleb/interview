import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import {
  HhBrowserAssistant,
  isFatalHhQueueError,
  normalizePersistedQueue,
  retryTransientHhVerification,
  type HhQueueItem,
} from './hhBrowserAssistant';

const directories: string[] = [];
const description = 'Разработка и тестирование продукта на Python и TypeScript, работа с API, базами данных и CI/CD. '.repeat(4);

function pending(id: string, override: Partial<HhQueueItem> = {}): HhQueueItem {
  return {
    key: `hh:${id}`,
    id,
    platform: 'hh',
    title: `QA Engineer ${id}`,
    company: 'Mriya Resort',
    salary: '',
    url: `https://hh.ru/vacancy/${id}`,
    description,
    status: 'needs_input',
    reason: 'Нужно ответить на 8 вопроса работодателя.',
    addedAt: '2026-08-15T01:00:00.000Z',
    autoRetryBlockedUntil: 'manual',
    pendingQuestions: [
      { id: `q-${id}-1`, prompt: 'Когда готовы выйти?', kind: 'text', options: [], required: true },
      { id: `q-${id}-2`, prompt: 'Где вы живёте?', kind: 'text', options: [], required: true },
    ],
    ...override,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('HH persisted queue recovery', () => {
  it('rebuilds a stale screening reason from the live count with correct Russian plural', () => {
    const [item] = normalizePersistedQueue([pending('1')]);

    expect(item?.status).toBe('needs_input');
    expect(item?.pendingQuestions).toHaveLength(2);
    expect(item?.reason).toBe(
      'Нужно ответить на 2 вопроса работодателя. Остальные вакансии продолжат обрабатываться.',
    );
  });

  it('leaves an unknown legacy personal fact blank instead of backfilling filler text', () => {
    const [item] = normalizePersistedQueue([pending('1', {
      pendingQuestions: [{
        id: 'legacy-city',
        prompt: 'В каком городе вы сейчас проживаете?',
        kind: 'text',
        options: [],
        required: true,
      }],
    })]);

    expect(item?.pendingQuestions?.[0]?.suggestedAnswer).toBeUndefined();
    expect(item?.pendingQuestions?.[0]?.assistantReason).toContain('неподтверждённый');
  });

  it('scrubs a guessed legacy city so the selected resume can rehydrate it', () => {
    const [item] = normalizePersistedQueue([pending('1', {
      pendingQuestions: [{
        id: 'legacy-guessed-city',
        prompt: 'Где вы сейчас живёте?',
        kind: 'text',
        options: [],
        required: true,
        suggestedAnswer: 'Москва',
      }],
    })]);

    expect(item?.pendingQuestions?.[0]?.suggestedAnswer).not.toBe('Москва');
    expect(item?.pendingQuestions?.[0]?.suggestedAnswer).toBeUndefined();
  });

  it('scrubs an unproven legacy legal-status option instead of restoring the guessed answer', () => {
    const [item] = normalizePersistedQueue([pending('1', {
      pendingQuestions: [{
        id: 'legacy-official-work',
        prompt: 'Твой опыт работы за последние 3 года — официальный (по ТК РФ)?',
        kind: 'single',
        options: ['Да', 'Нет (ИП/ГПХ/другое)'],
        required: true,
        suggestedOptions: ['Нет (ИП/ГПХ/другое)'],
      }],
    })]);

    expect(item?.pendingQuestions?.[0]?.suggestedOptions).toBeUndefined();
    expect(item?.pendingQuestions?.[0]?.suggestedAnswer).toContain('не будет угадывать');
    expect(item?.pendingQuestions?.[0]?.assistantReason).toContain('неподтверждённый');
  });

  it('scrubs every legacy closed-choice preselection without provenance', () => {
    const [item] = normalizePersistedQueue([pending('1', {
      pendingQuestions: [{
        id: 'legacy-office-commitment',
        prompt: 'Какой формат посещения офиса вам подходит?',
        kind: 'single',
        options: ['Каждый день', 'Гибрид', 'Только удалённо'],
        required: true,
        suggestedOptions: ['Каждый день'],
      }],
    })]);

    expect(item?.pendingQuestions?.[0]?.suggestedOptions).toBeUndefined();
    expect(item?.pendingQuestions?.[0]?.suggestedAnswer).toContain('не будет угадывать');
  });

  it('scrubs an unproven legacy personal-history text suggestion', () => {
    const [item] = normalizePersistedQueue([pending('1', {
      pendingQuestions: [{
        id: 'legacy-games',
        prompt: 'Нравятся ли вам игры жанра RTS? В какие игры этого жанра вы играли?',
        kind: 'text',
        options: [],
        required: true,
        suggestedAnswer: 'Да, играл в StarCraft II и Age of Empires II.',
      }],
    })]);

    const question = item?.pendingQuestions?.[0];
    expect(question?.suggestedAnswer).toBeTruthy();
    expect(question?.suggestedAnswer).not.toMatch(/StarCraft|Age of Empires/);
    expect(question?.assistantReason).toContain('неподтверждённый');
  });

  it('keeps one owner for exact employer-description duplicates and preserves a different description', () => {
    const stored = [
      pending('1'),
      pending('2'),
      pending('3'),
      pending('4'),
      pending('5'),
      pending('6', { description: `${description} У этой позиции отдельная команда и другой набор обязанностей.` }),
    ];

    const restored = normalizePersistedQueue(stored);

    expect(restored.filter((item) => item.status === 'needs_input').map((item) => item.id)).toEqual(['1', '6']);
    expect(restored.filter((item) => item.status === 'skipped').map((item) => item.id)).toEqual(['2', '3', '4', '5']);
    expect(restored.slice(1, 5).every((item) => !item.pendingQuestions && !item.autoRetryBlockedUntil)).toBe(true);
  });

  it('drops stale questions and retry gates from restored terminal items', () => {
    const [item] = normalizePersistedQueue([pending('1', {
      status: 'already_applied',
      screeningAnswers: [{ questionId: 'q', question: 'Где вы живёте?', answer: 'Казань', selectedOptions: [] }],
    })]);

    expect(item).toMatchObject({ status: 'already_applied' });
    expect(item?.pendingQuestions).toBeUndefined();
    expect(item?.screeningAnswers).toBeUndefined();
    expect(item?.autoRetryBlockedUntil).toBeUndefined();
  });

  it('preserves screening data when a legacy skipped item is recovered to opened', () => {
    const storedAnswer = {
      questionId: 'q-1-1',
      question: 'Когда готовы выйти?',
      answer: 'Через две недели',
      selectedOptions: [],
    };
    const [item] = normalizePersistedQueue([pending('1', {
      status: 'skipped',
      reason: 'Не удалось распознать состояние страницы HH.',
      screeningAnswers: [storedAnswer],
    })]);

    expect(item).toMatchObject({ status: 'opened' });
    expect(item?.pendingQuestions).toHaveLength(2);
    expect(item?.screeningAnswers).toEqual([storedAnswer]);
  });

  it.each([
    ['1C', 'Тестировщик-автоматизатор 1С'],
    ['Swift', 'iOS QA Automation Swift'],
  ])('removes persisted %s questions when the selected resume title is explicitly Python', (_stack, title) => {
    const [item] = normalizePersistedQueue([pending('1', {
      title,
      selectedResumeTitle: 'QA Automation Engineer Python',
    })]);

    expect(item).toMatchObject({
      status: 'skipped',
      coverLetterPending: false,
    });
    expect(item?.reason).toContain('стек вакансии');
    expect(item?.pendingQuestions).toBeUndefined();
    expect(item?.screeningAnswers).toBeUndefined();
    expect(item?.autoRetryBlockedUntil).toBeUndefined();
  });

  it('does not migrate a generic title from description-only stack mentions', () => {
    const [item] = normalizePersistedQueue([pending('1', {
      title: 'QA Automation Engineer',
      description: `${description} Backend продукта написан на Java.`,
      selectedResumeTitle: 'QA Automation Engineer Python',
    })]);

    expect(item?.status).toBe('needs_input');
    expect(item?.pendingQuestions).toHaveLength(2);
  });

  it('cleans stale screening data when a live queue item becomes terminal', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-terminal-cleanup-'));
    directories.push(directory);
    const assistant = new HhBrowserAssistant(directory, () => undefined);
    const mutable = assistant as unknown as { state: { queue: HhQueueItem[] } };
    mutable.state.queue = [pending('1')];

    const state = assistant.mark('hh:1', 'skipped');

    expect(state.queue[0]).toMatchObject({ status: 'skipped' });
    expect(state.queue[0]?.pendingQuestions).toBeUndefined();
    expect(state.queue[0]?.screeningAnswers).toBeUndefined();
    expect(state.queue[0]?.autoRetryBlockedUntil).toBeUndefined();
  });

  it('lets the user skip a screening vacancy and immediately undo without losing its questions', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-skip-undo-'));
    directories.push(directory);
    const assistant = new HhBrowserAssistant(directory, () => undefined);
    const mutable = assistant as unknown as { state: { queue: HhQueueItem[] } };
    mutable.state.queue = [pending('1')];

    expect(assistant.skipScreeningVacancy('hh:1').queue[0]).toMatchObject({ status: 'skipped' });
    const restored = assistant.restoreSkippedScreeningVacancy('hh:1').queue[0];

    expect(restored).toMatchObject({ status: 'needs_input' });
    expect(restored?.pendingQuestions).toHaveLength(2);
  });

  it('stops only for authentication or browser-context failures', () => {
    expect(isFatalHhQueueError(new Error('HTTP 503 from answer provider'))).toBe(false);
    expect(isFatalHhQueueError(new Error('Playwright page closed'))).toBe(false);
    expect(isFatalHhQueueError(new Error('HH показал captcha'))).toBe(false);
    expect(isFatalHhQueueError(new Error('Target page, context or browser has been closed'))).toBe(true);
    expect(isFatalHhQueueError(new Error('anything'), true)).toBe(true);
  });

  it('continues the queue after a per-vacancy transient exception', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-transient-queue-'));
    directories.push(directory);
    const assistant = new HhBrowserAssistant(directory, () => undefined);
    const mutable = assistant as unknown as {
      state: { queue: HhQueueItem[]; config: ReturnType<HhBrowserAssistant['getState']>['config'] };
      applyToVacancy: (item: HhQueueItem) => Promise<{ sent: boolean; blocked: boolean; reason: string }>;
      runQueue: () => Promise<{ attempted: number; blocked: boolean }>;
    };
    mutable.state.queue = [pending('1', { status: 'new', pendingQuestions: undefined }), pending('2', { status: 'new', pendingQuestions: undefined })];
    mutable.state.config = { ...mutable.state.config, dailyLimit: 200 };
    const apply = vi.fn(async (item: HhQueueItem) => {
      if (item.id === '1') throw new Error('HTTP 503 from vacancy page');
      assistant.mark(item.key, 'skipped');
      return { sent: false, blocked: false, reason: 'Пропущено в тесте.' };
    });
    mutable.applyToVacancy = apply;

    const stats = await mutable.runQueue();

    expect(apply).toHaveBeenCalledTimes(2);
    expect(stats).toMatchObject({ attempted: 2, blocked: false });
    expect(assistant.getState().queue[0]).toMatchObject({
      status: 'opened',
      autoRetryBlockedUntil: 'daily',
    });
  });

  it('isolates a captcha exception to one vacancy and continues the queue', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-fatal-queue-'));
    directories.push(directory);
    const assistant = new HhBrowserAssistant(directory, () => undefined);
    const mutable = assistant as unknown as {
      state: { queue: HhQueueItem[]; config: ReturnType<HhBrowserAssistant['getState']>['config'] };
      applyToVacancy: (item: HhQueueItem) => Promise<{ sent: boolean; blocked: boolean; reason: string }>;
      runQueue: () => Promise<{ attempted: number; blocked: boolean }>;
    };
    mutable.state.queue = [pending('1', { status: 'new', pendingQuestions: undefined }), pending('2', { status: 'new', pendingQuestions: undefined })];
    mutable.state.config = { ...mutable.state.config, dailyLimit: 200 };
    const apply = vi.fn(async (item: HhQueueItem) => {
      if (item.id === '1') throw new Error('HH показал captcha');
      assistant.mark(item.key, 'skipped');
      return { sent: false, blocked: false, reason: 'Пропущено в тесте.' };
    });
    mutable.applyToVacancy = apply;

    const stats = await mutable.runQueue();

    expect(apply).toHaveBeenCalledTimes(2);
    expect(stats).toMatchObject({ attempted: 2, blocked: false });
    expect(assistant.getState().queue[0]).toMatchObject({
      status: 'opened',
      autoRetryBlockedUntil: 'manual',
    });
  });

  it('silently retries a transient HH verification before treating it as persistent', async () => {
    const blocked = [true, false];
    const refresh = vi.fn(async () => undefined);

    const persistent = await retryTransientHhVerification(
      async () => blocked.shift() ?? false,
      refresh,
    );

    expect(persistent).toBe(false);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('persists a wait-user decision on the vacancy itself', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-wait-user-'));
    directories.push(directory);
    const assistant = new HhBrowserAssistant(directory, () => undefined);
    const item = pending('123456789', { status: 'new', pendingQuestions: undefined });
    const page = { url: () => item.url } as unknown as Page;
    const mutable = assistant as unknown as {
      state: { queue: HhQueueItem[] };
      ensureBrowser: () => Promise<Page>;
      preferredApplicantResume: () => Promise<null>;
      captureVacancyDescription: (_page: Page, vacancy: HhQueueItem) => Promise<string>;
      detectApplySituation: () => Promise<'captcha'>;
    };
    mutable.state.queue = [item];
    mutable.ensureBrowser = vi.fn(async () => page);
    mutable.preferredApplicantResume = vi.fn(async () => null);
    mutable.captureVacancyDescription = vi.fn(async (_page, vacancy) => vacancy.description ?? '');
    mutable.detectApplySituation = vi.fn(async () => 'captcha');

    const state = await assistant.applyOne(item.key, { explicitUserSelection: true });

    expect(state.phase).toBe('ready');
    expect(state.queue[0]).toMatchObject({
      status: 'opened',
      autoRetryBlockedUntil: 'manual',
      reason: 'HH трижды показал проверку для этой вакансии. Она отложена; остальные вакансии продолжаю обрабатывать.',
    });
  });

  it('clicks the final HH submit button at most once while confirmation is stale', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-submit-once-'));
    directories.push(directory);
    const assistant = new HhBrowserAssistant(directory, () => undefined);
    const item = pending('123456789', { status: 'new', pendingQuestions: undefined });
    const page = {
      url: () => item.url,
      waitForTimeout: vi.fn(async () => undefined),
      waitForLoadState: vi.fn(async () => undefined),
    } as unknown as Page;
    const mutable = assistant as unknown as {
      state: { queue: HhQueueItem[] };
      ensureBrowser: () => Promise<Page>;
      preferredApplicantResume: () => Promise<null>;
      captureVacancyDescription: (_page: Page, vacancy: HhQueueItem) => Promise<string>;
      detectApplySituation: () => Promise<'confirm'>;
      prepareCoverLetter: () => Promise<{ ok: true; letter: string }>;
      clickFirstVisible: () => Promise<boolean>;
    };
    mutable.state.queue = [item];
    mutable.ensureBrowser = vi.fn(async () => page);
    mutable.preferredApplicantResume = vi.fn(async () => null);
    mutable.captureVacancyDescription = vi.fn(async (_page, vacancy) => vacancy.description ?? '');
    mutable.detectApplySituation = vi.fn(async () => 'confirm');
    mutable.prepareCoverLetter = vi.fn(async () => ({ ok: true, letter: 'Проверенное письмо' }));
    mutable.clickFirstVisible = vi.fn(async () => true);

    const state = await assistant.applyOne(item.key, { explicitUserSelection: true });

    expect(mutable.clickFirstVisible).toHaveBeenCalledOnce();
    expect(mutable.prepareCoverLetter).toHaveBeenCalledOnce();
    expect(state.queue[0]).toMatchObject({
      status: 'opened',
      autoRetryBlockedUntil: 'daily',
    });
    expect(state.queue[0]?.reason).toContain('Не нажимаю повторно');
  });

  it('allows a new submit after HH opens and fills a distinct post-response letter form', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-submit-new-form-'));
    directories.push(directory);
    const assistant = new HhBrowserAssistant(directory, () => undefined);
    const item = pending('123456790', { status: 'new', pendingQuestions: undefined });
    let filledLetter = '';
    const controls = {
      waitFor: vi.fn(async () => undefined),
      fill: vi.fn(async (value: string) => { filledLetter = value; }),
      inputValue: vi.fn(async () => filledLetter),
    };
    const page = {
      url: () => item.url,
      waitForTimeout: vi.fn(async () => undefined),
      waitForLoadState: vi.fn(async () => undefined),
      locator: vi.fn(() => ({ first: () => controls })),
    } as unknown as Page;
    const situations = [
      'confirm',
      'post_response_letter_offer',
      'letter_form',
      'confirm',
      'success',
    ] as const;
    let situationIndex = 0;
    const mutable = assistant as unknown as {
      state: { queue: HhQueueItem[] };
      ensureBrowser: () => Promise<Page>;
      preferredApplicantResume: () => Promise<null>;
      captureVacancyDescription: (_page: Page, vacancy: HhQueueItem) => Promise<string>;
      detectApplySituation: () => Promise<(typeof situations)[number]>;
      prepareCoverLetter: () => Promise<{ ok: true; letter: string }>;
      clickFirstVisible: () => Promise<boolean>;
    };
    mutable.state.queue = [item];
    mutable.ensureBrowser = vi.fn(async () => page);
    mutable.preferredApplicantResume = vi.fn(async () => null);
    mutable.captureVacancyDescription = vi.fn(async (_page, vacancy) => vacancy.description ?? '');
    mutable.detectApplySituation = vi.fn(async () => situations[situationIndex++] ?? 'success');
    mutable.prepareCoverLetter = vi.fn(async () => ({ ok: true, letter: 'Проверенное письмо' }));
    mutable.clickFirstVisible = vi.fn(async () => true);

    const state = await assistant.applyOne(item.key, { explicitUserSelection: true });

    // First application submit + opening the separate letter editor + its submit.
    expect(mutable.clickFirstVisible).toHaveBeenCalledTimes(3);
    expect(state.queue[0]).toMatchObject({ status: 'sent', coverLetterAdded: true });
  });
});
