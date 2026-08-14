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
  getSelectedResumeText: (vacancyTitle: string) => Promise<string>;
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
  it('does not turn a provider failure into persisted personal questions', async () => {
    screeningMocks.collect.mockResolvedValue([field('q1'), field('q2')]);
    const generator = vi.fn(async () => {
      throw new Error('Провайдер не успел подготовить ответы. Повторите позже.');
    });
    const assistant = createAssistant(generator);

    const result = await assistant.fillEmployerQuestions({} as Page, vacancy());

    expect(generator).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, failureKind: 'transient' });
    expect(result.pendingQuestions).toBeUndefined();
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

  it('continues with the second vacancy after a transient screening failure', async () => {
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
      status: 'opened',
      autoRetryBlockedUntil: 'daily',
    });
    expect(assistant.getState().queue[0]?.pendingQuestions).toBeUndefined();
    expect(assistant.getState().queue[1]?.status).toBe('already_applied');
    expect(assistant.getState().runHistory[0]).toMatchObject({
      status: 'attention',
      attempted: 2,
      alreadyApplied: 1,
      needsAttention: 1,
    });
    expect(assistant.queueResumeTimer).toBeNull();

    const restored = createAssistant(generator, path.dirname(assistant.statePath));
    expect(restored.getState().queue[0]?.autoRetryBlockedUntil).toBe('daily');
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

  it('treats a selected resume fetch failure as transient and keeps it out of personal questions', async () => {
    screeningMocks.collect.mockResolvedValue([field('resume-dependent')]);
    const generator = vi.fn(async () => ({ answers: [] }));
    const assistant = createAssistant(generator);
    assistant.getSelectedResumeText = vi.fn(async () => {
      throw new Error('HH временно не вернул текст резюме.');
    });

    const result = await assistant.fillEmployerQuestions({} as Page, vacancy());

    expect(result).toMatchObject({ ok: false, failureKind: 'transient' });
    expect(result.reason).toContain('текст резюме');
    expect(result.pendingQuestions).toBeUndefined();
    expect(generator).not.toHaveBeenCalled();
  });
});
