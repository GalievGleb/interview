import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import type {
  HhScreeningAnswer,
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
  generator: () => Promise<{ answers: HhScreeningAnswer[] }>,
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
});
