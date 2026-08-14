import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HhBrowserAssistant,
  type HhAssistantState,
  type HhQueueItem,
} from './hhBrowserAssistant';
import {
  findHhSemanticDuplicate,
  hhVacancyDuplicateFingerprint,
  mergeHhVacancyDescription,
} from './hhVacancyDuplicateGuard';
import type { HhCoverLetterResponse } from './hhCoverLetter';

const directories: string[] = [];
const baseDescription = [
  'Мы ищем инженера по автоматизации тестирования веб-приложений.',
  'Нужно писать тесты на Python и Playwright, проверять REST API,',
  'развивать CI/CD, разбирать дефекты и работать вместе с командой разработки.',
  'Работа полностью удалённая, оформление официальное.',
].join(' ');

function vacancy(
  id: string,
  overrides: Partial<HhQueueItem> = {},
): HhQueueItem {
  return {
    key: `hh:${id}`,
    platform: 'hh',
    id,
    title: 'QA Automation Engineer',
    company: 'Example, ООО',
    salary: '',
    url: `https://hh.ru/vacancy/${id}`,
    description: baseDescription,
    status: 'new',
    addedAt: '2026-08-15T00:00:00.000Z',
    ...overrides,
  };
}

type TestableAssistant = {
  state: HhAssistantState;
  getState: () => HhAssistantState;
  ensureBrowser: () => Promise<unknown>;
  preferredApplicantResume: () => Promise<null>;
  captureVacancyDescription: (_page: unknown, item: HhQueueItem) => Promise<string>;
  detectApplySituation: () => Promise<'response_button'>;
  getSelectedResumeText: () => Promise<string>;
  applyToVacancy: (item: HhQueueItem, options?: { explicitUserSelection?: boolean }) => Promise<{
    sent: boolean;
    blocked: boolean;
    reason: string;
  }>;
};

function createAssistant(
  queue: HhQueueItem[],
  generator: () => Promise<HhCoverLetterResponse>,
): TestableAssistant {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-dedupe-'));
  directories.push(directory);
  const assistant = new HhBrowserAssistant(
    directory,
    () => undefined,
    undefined,
    generator,
  ) as unknown as TestableAssistant;
  assistant.state.queue = queue;
  assistant.state.config = {
    ...assistant.state.config,
    platform: 'hh',
    query: 'QA Automation Engineer',
  };
  const page = {
    url: () => queue.at(-1)?.url ?? 'https://hh.ru/',
    waitForLoadState: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async () => undefined),
  };
  assistant.ensureBrowser = vi.fn(async () => page);
  assistant.preferredApplicantResume = vi.fn(async () => null);
  assistant.captureVacancyDescription = vi.fn(async (_page, item) => item.description ?? '');
  assistant.detectApplySituation = vi.fn(async () => 'response_button');
  assistant.getSelectedResumeText = vi.fn(async () => (
    'QA Automation Engineer. Python, Pytest, Playwright, REST API, Docker и CI/CD. '.repeat(3)
  ));
  return assistant;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('HH semantic duplicate guard', () => {
  it('keeps a captured full description when a rescan only has an empty or short card snippet', () => {
    expect(mergeHhVacancyDescription(baseDescription, '')).toBe(baseDescription);
    expect(mergeHhVacancyDescription(baseDescription, 'Короткий текст карточки')).toBe(baseDescription);
  });

  it('uses a new full description on rescan and keeps a snippet when no full text exists yet', () => {
    const updatedDescription = `${baseDescription} Новая полная версия требований работодателя.`;

    expect(mergeHhVacancyDescription(baseDescription, updatedDescription)).toBe(updatedDescription);
    expect(mergeHhVacancyDescription('', 'Короткий текст карточки')).toBe('Короткий текст карточки');
  });

  it('retains a sent vacancy fingerprint across an empty search-card rescan', () => {
    const sentAfterRescan = vacancy('100', {
      status: 'sent',
      sentAt: '2026-08-15T01:00:00.000Z',
      description: mergeHhVacancyDescription(baseDescription, ''),
    });
    const repost = vacancy('101');

    expect(findHhSemanticDuplicate(
      [sentAfterRescan, repost],
      repost,
      repost.description ?? '',
    )).toBe(sentAfterRescan);
  });

  it('normalizes harmless formatting differences in employer and description', () => {
    const first = vacancy('100');
    const reformatted = vacancy('101', {
      company: '  EXAMPLE ООО ',
      description: baseDescription.toLocaleUpperCase('ru-RU').replaceAll(' ', ' \n '),
    });

    expect(hhVacancyDuplicateFingerprint(first)).toBe(
      hhVacancyDuplicateFingerprint(reformatted),
    );
  });

  it('keeps the same employer and title separate when descriptions differ', () => {
    const first = vacancy('100');
    const otherRole = vacancy('101', {
      description: `${baseDescription} Дополнительно вакансия требует уверенный Java и Selenium.`,
    });

    expect(hhVacancyDuplicateFingerprint(first)).not.toBe(
      hhVacancyDuplicateFingerprint(otherRole),
    );
    expect(findHhSemanticDuplicate([first, otherRole], otherRole, otherRole.description ?? '')).toBeNull();
  });

  it('does not deduplicate short generic snippets or different employers', () => {
    const shortFirst = vacancy('100', { description: 'Ищем QA-инженера в команду.' });
    const shortSecond = vacancy('101', { description: 'Ищем QA-инженера в команду.' });
    const otherEmployer = vacancy('102', { company: 'Another Company' });

    expect(findHhSemanticDuplicate([shortFirst, shortSecond], shortSecond, shortSecond.description ?? '')).toBeNull();
    expect(findHhSemanticDuplicate([vacancy('103'), otherEmployer], otherEmployer, otherEmployer.description ?? '')).toBeNull();
  });

  it('reserves an identical description for the earlier unfinished queue item only', () => {
    const first = vacancy('100', { status: 'needs_input' });
    const second = vacancy('101');

    expect(findHhSemanticDuplicate([first, second], second, second.description ?? '')).toBe(first);
    expect(findHhSemanticDuplicate([first, second], first, first.description ?? '')).toBeNull();
  });

  it('skips a second HH id before any provider or response action when an identical response exists', async () => {
    const sent = vacancy('100', {
      status: 'sent',
      sentAt: '2026-08-15T01:00:00.000Z',
    });
    const duplicate = vacancy('101');
    const generator = vi.fn(async (): Promise<HhCoverLetterResponse> => ({
      coverLetter: 'Не должен быть вызван.',
      matches: [],
      canAutoFill: true,
    }));
    const assistant = createAssistant([sent, duplicate], generator);

    const outcome = await assistant.applyToVacancy(duplicate, { explicitUserSelection: true });

    expect(outcome).toMatchObject({ sent: false, blocked: false });
    expect(outcome.reason).toContain('Повторный автоотклик не отправляю');
    expect(outcome.reason).toContain('HH 100');
    expect(generator).not.toHaveBeenCalled();
    expect(assistant.getState().queue).toEqual([
      expect.objectContaining({ key: 'hh:100', status: 'sent' }),
      expect.objectContaining({ key: 'hh:101', status: 'skipped' }),
    ]);
  });

  it('lets a genuinely different description reach the normal cover-letter policy', async () => {
    const sent = vacancy('100', {
      status: 'sent',
      sentAt: '2026-08-15T01:00:00.000Z',
    });
    const otherRole = vacancy('101', {
      description: `${baseDescription} Эта позиция отдельно требует опыт нагрузочного тестирования и k6.`,
    });
    const generator = vi.fn(async (): Promise<HhCoverLetterResponse> => ({
      coverLetter: '',
      matches: [],
      canAutoFill: false,
      failureKind: 'skill_mismatch',
      reason: 'В резюме нет подтверждённых совпадений.',
    }));
    const assistant = createAssistant([sent, otherRole], generator);

    const outcome = await assistant.applyToVacancy(otherRole, { explicitUserSelection: true });

    expect(generator).toHaveBeenCalledOnce();
    expect(outcome.reason).not.toContain('Повторный автоотклик');
  });
});
