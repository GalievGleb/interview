import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import type {
  HhScreeningAnswer,
  HhScreeningAnswersRequest,
  HhScreeningField,
  HhScreeningQuestion,
} from './hhScreeningQuestions';
import type { HhApplySituation } from './hhAutoApplyPolicy';

const screeningMocks = vi.hoisted(() => ({
  collect: vi.fn(),
  fill: vi.fn(),
}));

vi.mock('./hhScreeningQuestions', async () => {
  const actual = await vi.importActual<typeof import('./hhScreeningQuestions')>(
    './hhScreeningQuestions',
  );
  return {
    ...actual,
    collectHhScreeningFields: screeningMocks.collect,
    fillHhScreeningFields: screeningMocks.fill,
  };
});

import {
  HhBrowserAssistant,
  type HhAssistantState,
  type HhQueueItem,
} from './hhBrowserAssistant';

const directories: string[] = [];

function field(id: string): HhScreeningField {
  return {
    question: {
      id,
      prompt: `Расскажите о личном опыте для вопроса ${id}`,
      kind: 'text',
      options: [],
      required: true,
    },
    controlIndices: [0],
    optionValues: [],
  };
}

function vacancy(
  id = '123456789',
  company = 'Example',
): HhQueueItem {
  return {
    key: `hh:${id}`,
    platform: 'hh',
    id,
    title: 'QA Automation Engineer',
    company,
    salary: '',
    url: `https://hh.ru/vacancy/${id}`,
    description: 'Нужен инженер по автоматизации тестирования с опытом Python и Playwright. '.repeat(3),
    status: 'new',
    addedAt: new Date().toISOString(),
  };
}

type ScreeningResult = {
  ok: boolean;
  reason: string;
  failureKind?: 'manual' | 'transient';
  pendingQuestions?: HhScreeningQuestion[];
};

type TestableAssistant = {
  state: HhAssistantState;
  statePath: string;
  getState: () => HhAssistantState;
  getSelectedResumeText: (
    vacancyTitle: string,
    options?: { throwOnFailure?: boolean; selectedResumeTitle?: string },
  ) => Promise<string>;
  fillEmployerQuestions: (page: Page, item: HhQueueItem) => Promise<ScreeningResult>;
  ensureBrowser: () => Promise<Page>;
  preferredApplicantResume: () => Promise<null>;
  captureVacancyDescription: (page: Page, item: HhQueueItem) => Promise<string>;
  detectApplySituation: () => Promise<HhApplySituation>;
  applyOne: (
    vacancyId: string,
    options?: { explicitUserSelection?: boolean },
  ) => Promise<HhAssistantState>;
  restoreSchedule: () => void;
  resumePendingQueue: () => Promise<void>;
  scheduleQueueResume: (delayMs?: number) => void;
  queueResumeTimer: NodeJS.Timeout | null;
};

function createAssistant(
  generator: (request: HhScreeningAnswersRequest) => Promise<{ answers: HhScreeningAnswer[] }>,
  existingDirectory?: string,
): TestableAssistant {
  const directory = existingDirectory
    ?? fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-screening-'));
  if (!existingDirectory) directories.push(directory);
  const assistant = new HhBrowserAssistant(
    directory,
    () => undefined,
    generator,
  ) as unknown as TestableAssistant;
  assistant.getSelectedResumeText = vi.fn(async () => 'QA Automation Engineer.');
  return assistant;
}

function configureExternalForm(
  assistant: TestableAssistant,
  seedQueue: boolean,
): ReturnType<typeof vi.fn> {
  if (seedQueue) assistant.state.queue = [vacancy()];
  assistant.state.config = {
    ...assistant.state.config,
    platform: 'hh',
    autoSend: true,
    autoRunDaily: false,
    dailyLimit: 200,
  };
  const item = assistant.state.queue[0];
  const page = {
    url: () => item?.url ?? 'https://hh.ru/',
    waitForTimeout: vi.fn(async () => undefined),
  } as unknown as Page;
  const detect = vi.fn(async () => 'employer_questions' as const);
  assistant.ensureBrowser = vi.fn(async () => page);
  assistant.preferredApplicantResume = vi.fn(async () => null);
  assistant.captureVacancyDescription = vi.fn(
    async (_page, current) => current.description ?? '',
  );
  assistant.detectApplySituation = detect;
  return detect;
}

beforeEach(() => {
  screeningMocks.collect.mockReset();
  screeningMocks.fill.mockReset();
  screeningMocks.fill.mockImplementation(
    async (_page: Page, fields: HhScreeningField[], answers: HhScreeningAnswer[]) => {
      const byId = new Map(answers.map((answer) => [answer.id, answer]));
      return {
        filled: 0,
        unresolved: fields.map((item) => ({
          id: item.question.id,
          prompt: item.question.prompt,
          reason: byId.get(item.question.id)?.reason ?? 'Нужен ответ пользователя.',
        })),
      };
    },
  );
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('HH rejected screening batches', () => {
  it('autofills salary and city from the resume selected for the current vacancy', async () => {
    const fields: HhScreeningField[] = [
      {
        ...field('salary'),
        question: {
          ...field('salary').question,
          prompt: 'Уточните, пожалуйста, Ваши финансовые ожидания',
        },
      },
      {
        ...field('city'),
        question: {
          ...field('city').question,
          prompt: 'Где вы сейчас живёте?',
        },
      },
    ];
    screeningMocks.collect.mockResolvedValue(fields);
    let submittedAnswers: HhScreeningAnswer[] = [];
    screeningMocks.fill.mockImplementation(async (_page, currentFields, answers) => {
      submittedAnswers = answers;
      return { filled: currentFields.length, unresolved: [] };
    });
    const generator = vi.fn(async () => ({ answers: [] }));
    const assistant = createAssistant(generator);
    const selectedResumeTitle = 'QA Automation Engineer Python 220 000 ₽ · Удалённо';
    assistant.state.config = {
      ...assistant.state.config,
      salaryFrom: null,
      resumeTitles: ['QA Fullstack Engineer Python 240 000 ₽ · Удалённо'],
    };
    assistant.getSelectedResumeText = vi.fn(async () => (
      `${selectedResumeTitle}\nГород проживания: Казань\nPython · Pytest · Playwright`
    ));
    const item = { ...vacancy(), selectedResumeTitle };

    const result = await assistant.fillEmployerQuestions({} as Page, item);

    expect(result.ok).toBe(true);
    expect(generator).not.toHaveBeenCalled();
    expect(assistant.getSelectedResumeText).toHaveBeenCalledWith(item.title, {
      throwOnFailure: true,
      selectedResumeTitle,
    });
    expect(submittedAnswers.find((answer) => answer.id === 'salary')?.answer)
      .toMatch(/220[\s\u00a0]000 ₽/u);
    expect(submittedAnswers.find((answer) => answer.id === 'city')).toMatchObject({
      answer: 'Казань',
      canAutoFill: true,
    });
  });

  it('autofills salary from the selected resume title without fetching the resume body', async () => {
    const salaryField: HhScreeningField = {
      ...field('salary-title-only'),
      question: {
        ...field('salary-title-only').question,
        prompt: 'Уточните, пожалуйста, Ваши финансовые ожидания',
      },
    };
    screeningMocks.collect.mockResolvedValue([salaryField]);
    let submittedAnswers: HhScreeningAnswer[] = [];
    screeningMocks.fill.mockImplementation(async (_page, currentFields, answers) => {
      submittedAnswers = answers;
      return { filled: currentFields.length, unresolved: [] };
    });
    const generator = vi.fn(async () => ({ answers: [] }));
    const assistant = createAssistant(generator);
    const selectedResumeTitle = 'QA Automation Engineer Python 220 000 ₽ · Удалённо';
    assistant.state.config = {
      ...assistant.state.config,
      salaryFrom: null,
      resumeTitles: ['QA Fullstack Engineer Python 240 000 ₽ · Удалённо'],
    };
    assistant.getSelectedResumeText = vi.fn(async () => {
      throw new Error('resume body temporarily unavailable');
    });

    const result = await assistant.fillEmployerQuestions(
      {} as Page,
      { ...vacancy(), selectedResumeTitle },
    );

    expect(result.ok).toBe(true);
    expect(assistant.getSelectedResumeText).not.toHaveBeenCalled();
    expect(generator).not.toHaveBeenCalled();
    expect(submittedAnswers[0]?.answer).toMatch(/220[\s\u00a0]000 ₽/u);
    expect(submittedAnswers[0]?.answer).not.toContain('на руки');
  });

  it('autofills the selected resume city instead of a stale saved city', async () => {
    const cityField: HhScreeningField = {
      ...field('current-city'),
      question: {
        ...field('current-city').question,
        prompt: 'В каком городе вы сейчас проживаете?',
      },
    };
    screeningMocks.collect.mockResolvedValue([cityField]);
    let submittedAnswers: HhScreeningAnswer[] = [];
    screeningMocks.fill.mockImplementation(async (_page, currentFields, answers) => {
      submittedAnswers = answers;
      return { filled: currentFields.length, unresolved: [] };
    });
    const generator = vi.fn(async () => ({ answers: [] }));
    const assistant = createAssistant(generator);
    const selectedResumeTitle = 'QA Automation Engineer Python 220 000 ₽ · Удалённо';
    assistant.state.screeningFacts = [{
      id: 'old-confirmed-city',
      question: 'В каком городе проживаешь фактически?',
      answer: 'Казань',
      selectedOptions: [],
      updatedAt: '2025-01-01T00:00:00.000Z',
    }];
    assistant.getSelectedResumeText = vi.fn(async () => (
      `${selectedResumeTitle}\nГород проживания: Москва`
    ));

    const result = await assistant.fillEmployerQuestions(
      {} as Page,
      { ...vacancy(), selectedResumeTitle },
    );

    expect(result.ok).toBe(true);
    expect(assistant.getSelectedResumeText).toHaveBeenCalledOnce();
    expect(generator).not.toHaveBeenCalled();
    expect(submittedAnswers[0]).toMatchObject({
      id: 'current-city',
      answer: 'Москва',
      canAutoFill: true,
    });
  });

  it('keeps an exact answer confirmed for this vacancy above resume salary and city', async () => {
    const fields: HhScreeningField[] = [
      {
        ...field('salary-exact'),
        question: {
          ...field('salary-exact').question,
          prompt: 'Уточните, пожалуйста, Ваши финансовые ожидания',
        },
      },
      {
        ...field('city-exact'),
        question: {
          ...field('city-exact').question,
          prompt: 'Где вы сейчас живёте?',
        },
      },
    ];
    screeningMocks.collect.mockResolvedValue(fields);
    let submittedAnswers: HhScreeningAnswer[] = [];
    screeningMocks.fill.mockImplementation(async (_page, currentFields, answers) => {
      submittedAnswers = answers;
      return { filled: currentFields.length, unresolved: [] };
    });
    const generator = vi.fn(async () => ({ answers: [] }));
    const assistant = createAssistant(generator);
    const selectedResumeTitle = 'QA Automation Engineer Python 220 000 ₽ · Удалённо';
    assistant.getSelectedResumeText = vi.fn(async () => (
      `${selectedResumeTitle}\nГород проживания: Москва`
    ));
    const item: HhQueueItem = {
      ...vacancy(),
      selectedResumeTitle,
      screeningAnswers: [
        {
          questionId: 'salary-exact',
          question: 'Уточните, пожалуйста, Ваши финансовые ожидания',
          answer: 'Рассматриваю предложения от 250 000 ₽ в месяц.',
          selectedOptions: [],
          confirmedByUser: true,
        },
        {
          questionId: 'city-exact',
          question: 'Где вы сейчас живёте?',
          answer: 'Казань',
          selectedOptions: [],
          confirmedByUser: true,
        },
      ],
    };

    const result = await assistant.fillEmployerQuestions({} as Page, item);

    expect(result.ok).toBe(true);
    expect(generator).not.toHaveBeenCalled();
    expect(assistant.getSelectedResumeText).not.toHaveBeenCalled();
    expect(submittedAnswers.find((answer) => answer.id === 'salary-exact')?.answer)
      .toMatch(/250[\s\u00a0]000 ₽/u);
    expect(submittedAnswers.find((answer) => answer.id === 'city-exact')?.answer).toBe('Казань');
  });

  it('does not auto-submit a remembered city when the selected resume cannot be loaded', async () => {
    const cityField: HhScreeningField = {
      ...field('current-city-load-error'),
      question: {
        ...field('current-city-load-error').question,
        prompt: 'Где вы сейчас живёте?',
      },
    };
    screeningMocks.collect.mockResolvedValue([cityField]);
    let submittedAnswers: HhScreeningAnswer[] = [];
    screeningMocks.fill.mockImplementation(async (_page, currentFields, answers) => {
      submittedAnswers = answers;
      return {
        filled: 0,
        unresolved: currentFields.map((current) => ({
          id: current.question.id,
          reason: 'Город нужно подтвердить.',
        })),
      };
    });
    const generator = vi.fn(async () => ({ answers: [] }));
    const assistant = createAssistant(generator);
    assistant.state.screeningFacts = [{
      id: 'stale-city-from-another-resume',
      question: 'Где вы сейчас живёте?',
      answer: 'Москва',
      selectedOptions: [],
      updatedAt: '2025-01-01T00:00:00.000Z',
    }];
    assistant.getSelectedResumeText = vi.fn(async () => {
      throw new Error('HH временно не вернул выбранное резюме.');
    });

    const result = await assistant.fillEmployerQuestions({} as Page, {
      ...vacancy(),
      selectedResumeTitle: 'QA Automation Engineer Python 220 000 ₽ · Удалённо',
    } as HhQueueItem);

    expect(result).toMatchObject({ ok: false, failureKind: 'manual' });
    expect(submittedAnswers[0]?.canAutoFill).toBe(false);
    expect(submittedAnswers[0]?.answer).not.toBe('Москва');
    expect(result.pendingQuestions?.[0]?.suggestedAnswer).not.toBe('Москва');
  });

  it('turns a provider failure into persisted questions with useful review drafts', async () => {
    screeningMocks.collect.mockResolvedValue([field('q1'), field('q2')]);
    const generator = vi.fn(async () => {
      throw new Error('Провайдер не успел подготовить ответы. Повторите позже.');
    });
    const assistant = createAssistant(generator);

    const result = await assistant.fillEmployerQuestions({} as Page, vacancy());

    expect(generator).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, failureKind: 'manual' });
    expect(result.pendingQuestions).toHaveLength(2);
    expect(result.pendingQuestions?.every((question) => (
      Boolean(question.suggestedAnswer?.trim())
      || Boolean(question.suggestedOptions?.length)
    ))).toBe(true);
  });

  it('keeps an explicit fulfilled canAutoFill=false answer as a manual question', async () => {
    screeningMocks.collect.mockResolvedValue([field('manual')]);
    const assistant = createAssistant(async () => ({
      answers: [{
        id: 'manual',
        answer: '',
        selectedOptions: [],
        canAutoFill: false,
        reason: 'В резюме нет подтверждённого личного факта.',
      }],
    }));

    const result = await assistant.fillEmployerQuestions({} as Page, vacancy());

    expect(result).toMatchObject({ ok: false, failureKind: 'manual' });
    expect(result.pendingQuestions).toHaveLength(1);
    expect(result.pendingQuestions?.[0]?.assistantReason).toBe(
      'В резюме нет подтверждённого личного факта.',
    );
    expect(result.pendingQuestions?.[0]?.suggestedAnswer).toBeTruthy();
  });

  it('persists an unrecognized external form as manual and never rearms the short timer', async () => {
    vi.useFakeTimers();
    screeningMocks.collect.mockResolvedValue([]);
    const generator = vi.fn(async () => ({ answers: [] }));
    const first = createAssistant(generator);
    configureExternalForm(first, true);
    first.scheduleQueueResume(30 * 60 * 1_000);
    expect(first.queueResumeTimer).not.toBeNull();

    const state = await first.applyOne('hh:123456789', { explicitUserSelection: true });

    expect(screeningMocks.collect).toHaveBeenCalledOnce();
    expect(generator).not.toHaveBeenCalled();
    expect(state.phase).toBe('manual_required');
    expect(state.queue[0]).toMatchObject({
      status: 'opened',
      autoRetryBlockedUntil: 'manual',
    });
    expect(state.queue[0]?.pendingQuestions).toBeUndefined();
    expect(first.queueResumeTimer).toBeNull();

    const persisted = JSON.parse(fs.readFileSync(first.statePath, 'utf8')) as {
      queue?: HhQueueItem[];
    };
    expect(persisted.queue?.[0]?.autoRetryBlockedUntil).toBe('manual');

    const restored = createAssistant(generator, path.dirname(first.statePath));
    const restoredDetect = configureExternalForm(restored, false);
    expect(restored.getState().queue[0]?.autoRetryBlockedUntil).toBe('manual');

    restored.restoreSchedule();
    expect(restored.queueResumeTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(31 * 60 * 1_000);

    expect(restoredDetect).not.toHaveBeenCalled();
    expect(generator).not.toHaveBeenCalled();
  });

  it('reprocesses persisted objective technical questions after an upgrade', async () => {
    const technicalPrompt = 'Я тестирую web приложение. Я вижу код, но не вижу базу данных. Это Black Box тестирование? Ответьте ДА или НЕТ и поясните в 1–2 предложениях.';
    const personalPrompt = 'Сколько вам лет?';
    const generator = vi.fn(async (request: HhScreeningAnswersRequest) => ({
      answers: request.questions.map((question) => ({
        id: question.id,
        answer: 'Нет. Доступ к исходному коду означает, что это не чистое тестирование чёрного ящика.',
        selectedOptions: ['Нет'],
        canAutoFill: true,
        sourceType: 'knowledge' as const,
        reason: '',
      })),
    }));
    const assistant = createAssistant(generator);
    const item = vacancy();
    assistant.state.queue = [{
      ...item,
      status: 'needs_input',
      pendingQuestions: [
        {
          id: 'black-box',
          prompt: technicalPrompt,
          kind: 'single',
          options: ['Да', 'Нет', 'Свой вариант'],
          required: true,
        },
        {
          id: 'age',
          prompt: personalPrompt,
          kind: 'text',
          options: [],
          required: true,
        },
      ],
    }];
    assistant.state.config = {
      ...assistant.state.config,
      autoSend: false,
      autoRunDaily: false,
    };

    assistant.restoreSchedule();

    await vi.waitFor(() => {
      expect(assistant.getState().queue[0]?.pendingQuestions?.map((question) => question.id))
        .toEqual(['age']);
    });
    expect(generator).toHaveBeenCalledOnce();
    expect(generator.mock.calls[0]?.[0].questions.map((question) => question.id))
      .toEqual(['black-box']);
    expect(assistant.getState().queue[0]?.screeningAnswers).toContainEqual({
      questionId: 'black-box',
      question: technicalPrompt,
      answer: 'Нет. Доступ к исходному коду означает, что это не чистое тестирование чёрного ящика.',
      selectedOptions: ['Нет'],
    });
  });

  it('reprocesses persisted yes/no skills from the exact selected resume', async () => {
    const generator = vi.fn(async () => ({ answers: [] }));
    const assistant = createAssistant(generator);
    const item = vacancy();
    assistant.state.queue = [{
      ...item,
      status: 'needs_input',
      selectedResumeTitle: 'Qa Fullstack engineer python 240 000 ₽ · Удалённо',
      pendingQuestions: [{
        id: 'postman',
        prompt: 'У вас уверенное владение Postman?',
        kind: 'single',
        options: ['да', 'нет'],
        required: true,
      }, {
        id: 'age',
        prompt: 'Сколько вам лет?',
        kind: 'text',
        options: [],
        required: true,
      }],
    }];
    assistant.state.config = { ...assistant.state.config, autoSend: false, autoRunDaily: false };
    assistant.getSelectedResumeText = vi.fn(async () => (
      'Qa Fullstack engineer python 240 000 ₽ · Удалённо\nРаботаю со стеком: REST API, Postman, SQL.'
    ));

    assistant.restoreSchedule();

    await vi.waitFor(() => {
      expect(assistant.getState().queue[0]?.pendingQuestions?.map((question) => question.id))
        .toEqual(['age']);
    });
    expect(assistant.getState().queue[0]?.screeningAnswers).toContainEqual({
      questionId: 'postman',
      question: 'У вас уверенное владение Postman?',
      answer: '',
      selectedOptions: ['да'],
    });
    expect(generator).not.toHaveBeenCalled();
  });

  it('keeps review drafts and continues with the second vacancy after a provider failure', async () => {
    vi.useFakeTimers();
    screeningMocks.collect.mockResolvedValue([field('provider-question')]);
    const generator = vi.fn(async () => {
      throw new Error('Провайдер не успел подготовить ответы. Повторите позже.');
    });
    const assistant = createAssistant(generator);
    const firstVacancy = vacancy('111111111', 'First Company');
    const secondVacancy = vacancy('222222222', 'Second Company');
    assistant.state.queue = [firstVacancy, secondVacancy];
    assistant.state.config = {
      ...assistant.state.config,
      platform: 'hh',
      query: 'QA Automation Engineer',
      resumeTitles: ['QA Automation Python'],
      schedule: '',
      autoSend: true,
      autoRunDaily: false,
      dailyLimit: 200,
    };

    let currentUrl = firstVacancy.url;
    const page = {
      url: () => currentUrl,
      goto: vi.fn(async (url: string) => {
        currentUrl = url;
      }),
      waitForTimeout: vi.fn(async () => undefined),
    } as unknown as Page;
    assistant.ensureBrowser = vi.fn(async () => page);
    assistant.preferredApplicantResume = vi.fn(async () => null);
    assistant.captureVacancyDescription = vi.fn(
      async (_page, current) => current.description ?? '',
    );
    const detect = vi.fn(async (): Promise<HhApplySituation> => (
      currentUrl.includes(firstVacancy.id) ? 'employer_questions' : 'already_applied'
    ));
    assistant.detectApplySituation = detect;

    await assistant.resumePendingQueue();

    expect(generator).toHaveBeenCalledOnce();
    expect(detect).toHaveBeenCalledTimes(2);
    expect(assistant.getState().queue[0]).toMatchObject({
      status: 'needs_input',
    });
    expect(assistant.getState().queue[0]?.autoRetryBlockedUntil).toBeUndefined();
    expect(assistant.getState().queue[0]?.pendingQuestions?.[0]?.suggestedAnswer).toBeTruthy();
    expect(assistant.getState().queue[1]?.status).toBe('already_applied');
    expect(assistant.getState().runHistory[0]).toMatchObject({
      status: 'attention',
      attempted: 2,
      alreadyApplied: 1,
      needsAttention: 1,
    });
    expect(assistant.queueResumeTimer).toBeNull();

    const restored = createAssistant(generator, path.dirname(assistant.statePath));
    expect(restored.getState().queue[0]?.status).toBe('needs_input');
    expect(restored.getState().queue[0]?.autoRetryBlockedUntil).toBeUndefined();
    restored.restoreSchedule();
    expect(restored.queueResumeTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(31 * 60 * 1_000);

    expect(generator).toHaveBeenCalledOnce();
  });

  it('deduplicates semantically identical questions before calling the provider', async () => {
    const duplicatePrompt = 'В каком городе вы сейчас проживаете?';
    const fields: HhScreeningField[] = ['city-a', 'city-b'].map((id) => ({
      ...field(id),
      question: { ...field(id).question, prompt: duplicatePrompt },
    }));
    screeningMocks.collect.mockResolvedValue(fields);
    let filledAnswers: HhScreeningAnswer[] = [];
    screeningMocks.fill.mockImplementation(async (_page, currentFields, answers) => {
      filledAnswers = answers;
      return { filled: currentFields.length, unresolved: [] };
    });
    const generator = vi.fn(async (request: { questions: HhScreeningQuestion[] }) => ({
      answers: request.questions.map((question) => ({
        id: question.id,
        answer: 'Казань',
        selectedOptions: [],
        canAutoFill: true,
        reason: '',
      })),
    }));
    const assistant = createAssistant(generator);

    const result = await assistant.fillEmployerQuestions({} as Page, vacancy());

    expect(result.ok).toBe(true);
    expect(generator).toHaveBeenCalledOnce();
    expect(generator.mock.calls[0]?.[0].questions).toHaveLength(1);
    expect(filledAnswers.filter((answer) => answer.canAutoFill).map((answer) => answer.id)).toEqual([
      'city-a',
      'city-b',
    ]);
  });

  it('does not promote a review-only suggestion when mapping semantic duplicates', async () => {
    const duplicatePrompt = 'В каком городе вы сейчас проживаете?';
    const fields: HhScreeningField[] = ['city-a', 'city-b'].map((id) => ({
      ...field(id),
      question: { ...field(id).question, prompt: duplicatePrompt },
    }));
    screeningMocks.collect.mockResolvedValue(fields);
    let filledAnswers: HhScreeningAnswer[] = [];
    screeningMocks.fill.mockImplementation(async (_page, currentFields, answers) => {
      filledAnswers = answers;
      return {
        filled: 0,
        unresolved: currentFields.map((current) => ({
          id: current.question.id,
          reason: 'Нужно подтвердить город.',
        })),
      };
    });
    const generator = vi.fn(async (request: { questions: HhScreeningQuestion[] }) => ({
      answers: request.questions.map((question) => ({
        id: question.id,
        answer: 'Казань',
        selectedOptions: [],
        canAutoFill: false,
        reason: 'Город не подтверждён.',
      })),
    }));
    const assistant = createAssistant(generator);

    const result = await assistant.fillEmployerQuestions({} as Page, vacancy());

    expect(result.ok).toBe(false);
    expect(generator).toHaveBeenCalledOnce();
    expect(generator.mock.calls[0]?.[0].questions).toHaveLength(1);
    expect(filledAnswers).toHaveLength(2);
    expect(filledAnswers.every((answer) => answer.canAutoFill === false)).toBe(true);
    expect(result.pendingQuestions).toHaveLength(2);
  });

  it('limits provider batches to two concurrent requests', async () => {
    screeningMocks.collect.mockResolvedValue(Array.from({ length: 18 }, (_, index) => field(`unique-${index}`)));
    screeningMocks.fill.mockImplementation(async (_page, fields) => ({ filled: fields.length, unresolved: [] }));
    let active = 0;
    let maximumActive = 0;
    const generator = vi.fn(async (request: { questions: HhScreeningQuestion[] }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        answers: request.questions.map((question) => ({
          id: question.id,
          answer: 'Подтверждённый ответ',
          selectedOptions: [],
          canAutoFill: true,
          reason: '',
        })),
      };
    });
    const assistant = createAssistant(generator);

    const result = await assistant.fillEmployerQuestions({} as Page, vacancy());

    expect(result.ok).toBe(true);
    expect(generator).toHaveBeenCalledTimes(3);
    expect(maximumActive).toBe(2);
  });

  it('keeps useful pending drafts when the selected resume body cannot be fetched', async () => {
    screeningMocks.collect.mockResolvedValue([field('resume-dependent')]);
    const generator = vi.fn(async () => ({ answers: [] }));
    const assistant = createAssistant(generator);
    assistant.getSelectedResumeText = vi.fn(async () => {
      throw new Error('HH временно не вернул текст резюме.');
    });

    const result = await assistant.fillEmployerQuestions({} as Page, vacancy());

    expect(result).toMatchObject({ ok: false, failureKind: 'manual' });
    expect(result.pendingQuestions).toHaveLength(1);
    expect(result.pendingQuestions?.[0]?.suggestedAnswer).toBeTruthy();
    expect(generator).toHaveBeenCalledOnce();
  });
});
