import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HhBrowserAssistant,
  normalizePersistedQueue,
  type HhAssistantState,
  type HhQueueItem,
} from './hhBrowserAssistant';
import type { HhCoverLetterResponse } from './hhCoverLetter';
import type { HhApplySituation } from './hhAutoApplyPolicy';

const directories: string[] = [];

function vacancy(): HhQueueItem {
  return {
    key: 'hh:123456789',
    platform: 'hh',
    id: '123456789',
    title: 'QA Automation Engineer',
    company: 'Example',
    salary: '',
    url: 'https://hh.ru/vacancy/123456789',
    description: 'Нужен инженер по автоматизации тестирования с опытом Java и Kubernetes. '.repeat(3),
    status: 'new',
    addedAt: new Date().toISOString(),
  };
}

type TestableAssistant = {
  state: HhAssistantState;
  statePath: string;
  getState: () => HhAssistantState;
  ensureBrowser: () => Promise<unknown>;
  preferredApplicantResume: () => Promise<null>;
  captureVacancyDescription: (_page: unknown, item: HhQueueItem) => Promise<string>;
  getSelectedResumeText: () => Promise<string>;
  detectApplySituation: () => Promise<HhApplySituation>;
  applyToVacancy: (item: HhQueueItem, options?: { explicitUserSelection?: boolean }) => Promise<{
    sent: boolean;
    alreadyApplied?: boolean;
    blocked: boolean;
    reason: string;
  }>;
  applyOne: (
    vacancyId: string,
    options?: { explicitUserSelection?: boolean },
  ) => Promise<HhAssistantState>;
  resumePendingQueue: () => Promise<void>;
  scheduleQueueResume: (delayMs?: number) => void;
  pendingQueueCount: () => number;
  queueResumeTimer: NodeJS.Timeout | null;
  restoreSchedule: () => void;
  saveConfig: (value: Partial<HhAssistantState['config']>) => HhAssistantState;
  setDailySchedule: (enabled: boolean) => HhAssistantState;
  beginRun: (trigger: 'schedule') => { id: string };
  runQueue: (runId?: string) => Promise<{ attempted: number }>;
};

function createAssistant(
  generator: () => Promise<HhCoverLetterResponse>,
  existingDirectory?: string,
): TestableAssistant {
  const directory = existingDirectory
    ?? fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-retry-'));
  if (!existingDirectory) directories.push(directory);
  const assistant = new HhBrowserAssistant(
    directory,
    () => undefined,
    undefined,
    generator,
  ) as unknown as TestableAssistant;
  if (!existingDirectory) {
    assistant.state.queue = [vacancy()];
    assistant.state.config = {
      ...assistant.state.config,
      platform: 'hh',
      autoSend: true,
      autoRunDaily: false,
      dailyLimit: 200,
    };
  }
  const item = assistant.state.queue[0] ?? vacancy();
  const page = {
    url: () => item.url,
    waitForLoadState: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async () => undefined),
  };
  assistant.ensureBrowser = vi.fn(async () => page);
  assistant.preferredApplicantResume = vi.fn(async () => null);
  assistant.captureVacancyDescription = vi.fn(async (_page, current) => current.description ?? '');
  assistant.getSelectedResumeText = vi.fn(async () => (
    'QA Automation Engineer. Python, Pytest, Playwright, REST API, Docker и CI/CD. '.repeat(3)
  ));
  assistant.detectApplySituation = vi.fn(async () => 'response_button');
  return assistant;
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('HH cover-letter retry policy', () => {
  const legacyTimeoutReason =
    'Не удалось получить безопасный AI-ответ: Screening answer generation timed out';

  it('marks a deterministic skill mismatch skipped and removes it from the actionable queue', async () => {
    const assistant = createAssistant(async () => ({
      coverLetter: '',
      matches: [],
      canAutoFill: false,
      reason: 'В резюме нет подтверждённых совпадений.',
      failureKind: 'skill_mismatch',
    }));

    const outcome = await assistant.applyToVacancy(
      assistant.state.queue[0],
      { explicitUserSelection: true },
    );

    expect(outcome.blocked).toBe(false);
    expect(assistant.getState().queue[0]).toMatchObject({
      status: 'skipped',
      coverLetterPending: false,
      coverLetterAdded: false,
    });
    expect(assistant.getState().queue[0]?.autoRetryBlockedUntil).toBeUndefined();
    expect(assistant.pendingQueueCount()).toBe(0);
  });

  it('does not invoke the provider again 31 minutes after a quota, timeout, or transport failure', async () => {
    vi.useFakeTimers();
    const attempts = [
      '402 token_quota_exceeded',
      'Cover-letter generation timed out',
      'fetch failed: ECONNRESET',
    ].map((message) => {
      const generator = vi.fn(async (): Promise<HhCoverLetterResponse> => {
        throw new Error(message);
      });
      return { assistant: createAssistant(generator), generator };
    });

    for (const { assistant, generator } of attempts) {
      assistant.scheduleQueueResume(30 * 60 * 1_000);
      expect(assistant.queueResumeTimer).not.toBeNull();
      await assistant.resumePendingQueue();
      expect(generator).toHaveBeenCalledOnce();
      expect(assistant.getState().runHistory[0]?.status).toBe('attention');
      expect(assistant.getState().queue[0]?.status).toBe('opened');
      expect(assistant.getState().queue[0]?.autoRetryBlockedUntil).toBe('daily');
      expect(assistant.getState().queuePaused).toBe(false);
      expect(assistant.pendingQueueCount()).toBe(1);
      expect(assistant.queueResumeTimer).toBeNull();
    }

    await vi.advanceTimersByTimeAsync(31 * 60 * 1_000);

    for (const { assistant, generator } of attempts) {
      expect(generator).toHaveBeenCalledOnce();
      expect(assistant.queueResumeTimer).toBeNull();
    }
  });

  it('records an unexpected apply exception as attention instead of completed', async () => {
    vi.useFakeTimers();
    const assistant = createAssistant(async () => ({
      coverLetter: '', matches: [], canAutoFill: false, failureKind: 'manual',
    }));
    const apply = vi.fn(async () => {
      throw new Error('Playwright renderer crashed');
    });
    assistant.applyToVacancy = apply;

    await assistant.resumePendingQueue();

    expect(apply).toHaveBeenCalledOnce();
    expect(assistant.getState().runHistory[0]).toMatchObject({
      status: 'attention',
      attempted: 1,
      needsAttention: 1,
    });
    expect(assistant.getState().runHistory[0]?.status).not.toBe('completed');
    expect(assistant.getState().queue[0]?.reason).toContain('Playwright renderer crashed');
    expect(assistant.getState().queue[0]?.autoRetryBlockedUntil).toBe('daily');
    expect(assistant.queueResumeTimer).toBeNull();
  });

  it('cancels an existing queue timer when a manual single apply is blocked', async () => {
    vi.useFakeTimers();
    const generator = vi.fn(async (): Promise<HhCoverLetterResponse> => {
      throw new Error('fetch failed: ECONNRESET');
    });
    const assistant = createAssistant(generator);
    assistant.scheduleQueueResume(30 * 60 * 1_000);
    expect(assistant.queueResumeTimer).not.toBeNull();

    const state = await assistant.applyOne('hh:123456789', { explicitUserSelection: true });

    expect(generator).toHaveBeenCalledOnce();
    expect(state.phase).toBe('manual_required');
    expect(state.queue[0]?.status).toBe('opened');
    expect(state.queue[0]?.autoRetryBlockedUntil).toBe('daily');
    expect(assistant.queueResumeTimer).toBeNull();

    await vi.advanceTimersByTimeAsync(31 * 60 * 1_000);

    expect(generator).toHaveBeenCalledOnce();
    expect(assistant.queueResumeTimer).toBeNull();
  });

  it('persists a later-only gate across restart and ignores restore/config short retries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
    const generator = vi.fn(async (): Promise<HhCoverLetterResponse> => {
      throw new Error('Cover-letter generation timed out');
    });
    const first = createAssistant(generator);

    await first.resumePendingQueue();

    expect(generator).toHaveBeenCalledOnce();
    expect(first.getState().queue[0]?.autoRetryBlockedUntil).toBe('daily');
    const persisted = JSON.parse(fs.readFileSync(first.statePath, 'utf8')) as {
      queue?: HhQueueItem[];
    };
    expect(persisted.queue?.[0]?.autoRetryBlockedUntil).toBe('daily');

    const restored = createAssistant(generator, path.dirname(first.statePath));
    expect(restored.getState().queue[0]?.autoRetryBlockedUntil).toBe('daily');

    restored.restoreSchedule();
    expect(restored.queueResumeTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(generator).toHaveBeenCalledOnce();

    restored.saveConfig({ autoSend: true, dailyLimit: 199 });
    expect(restored.queueResumeTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(generator).toHaveBeenCalledOnce();

    restored.setDailySchedule(true);
    expect(restored.queueResumeTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(generator).toHaveBeenCalledOnce();

    await restored.applyOne('hh:123456789', { explicitUserSelection: true });
    expect(generator).toHaveBeenCalledTimes(2);
    expect(restored.getState().queue[0]?.autoRetryBlockedUntil).toBe('daily');

    const scheduledRun = restored.beginRun('schedule');
    const scheduledStats = await restored.runQueue(scheduledRun.id);
    expect(scheduledStats.attempted).toBe(1);
    expect(generator).toHaveBeenCalledTimes(3);
  });

  it.each([
    {
      name: 'unexpected exception',
      expectedGate: 'daily' as const,
      apply: async () => {
        throw new Error('Playwright page closed');
      },
    },
    {
      name: 'wait_user block',
      expectedGate: 'manual' as const,
      apply: async () => ({
        sent: false,
        blocked: true,
        reason: 'HH ждёт ручного ответа пользователя.',
      }),
    },
  ])('persists the $name gate from direct apply and does not auto-resume after restart', async ({
    expectedGate,
    apply,
  }) => {
    vi.useFakeTimers();
    const generator = vi.fn(async (): Promise<HhCoverLetterResponse> => ({
      coverLetter: '',
      matches: [],
      canAutoFill: false,
      failureKind: 'manual',
    }));
    const first = createAssistant(generator);
    first.applyToVacancy = vi.fn(apply);

    await first.applyOne('hh:123456789', { explicitUserSelection: true });

    expect(first.getState().queue[0]?.autoRetryBlockedUntil).toBe(expectedGate);
    const restored = createAssistant(generator, path.dirname(first.statePath));
    expect(restored.getState().queue[0]?.autoRetryBlockedUntil).toBe(expectedGate);

    restored.restoreSchedule();
    expect(restored.queueResumeTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(generator).not.toHaveBeenCalled();

    const scheduledRun = restored.beginRun('schedule');
    const scheduledStats = await restored.runQueue(scheduledRun.id);
    expect(scheduledStats.attempted).toBe(expectedGate === 'daily' ? 1 : 0);
    expect(generator).toHaveBeenCalledTimes(expectedGate === 'daily' ? 1 : 0);
  });

  it('migrates an all-transient legacy screening batch to daily/manual attention', () => {
    const stored = vacancy();
    stored.status = 'needs_input';
    stored.pendingQuestions = [{
      id: 'timeout-question',
      prompt: 'Расскажите о релевантном опыте.',
      kind: 'text',
      options: [],
      required: true,
      assistantReason: legacyTimeoutReason,
    }];
    stored.screeningAnswers = [{
      questionId: 'answered-question',
      question: 'Готовы к удалённой работе?',
      answer: 'Да',
      selectedOptions: [],
    }];

    const [migrated] = normalizePersistedQueue([stored]);

    expect(migrated).toMatchObject({
      status: 'opened',
      autoRetryBlockedUntil: 'daily',
      screeningAnswers: stored.screeningAnswers,
    });
    expect(migrated?.reason).toContain('Временный сбой подготовки ответов');
    expect(migrated?.pendingQuestions).toBeUndefined();
  });

  it('removes only exact legacy timeouts from a mixed batch and keeps real questions', () => {
    const stored = vacancy();
    stored.status = 'needs_input';
    stored.pendingQuestions = [
      {
        id: 'timeout-question',
        prompt: 'Синтетический timeout.',
        kind: 'text',
        options: [],
        required: true,
        assistantReason: legacyTimeoutReason,
      },
      {
        id: 'real-question',
        prompt: 'Когда вы готовы выйти на работу?',
        kind: 'text',
        options: [],
        required: true,
        assistantReason: 'Для ответа нужен личный факт пользователя.',
      },
      {
        id: 'near-miss-question',
        prompt: 'Уточните ожидания.',
        kind: 'text',
        options: [],
        required: false,
        assistantReason: `${legacyTimeoutReason}.`,
      },
    ];

    const [migrated] = normalizePersistedQueue([stored]);

    expect(migrated?.status).toBe('needs_input');
    expect(migrated?.autoRetryBlockedUntil).toBeUndefined();
    expect(migrated?.pendingQuestions?.map((question) => question.id)).toEqual([
      'real-question',
      'near-miss-question',
    ]);
  });
});
