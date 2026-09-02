import { describe, expect, it } from 'vitest';
import type { HhQueueItem } from '../types/electron';
import {
  hhQueueItemPresentation,
  hhScreeningVacancyPath,
  hhVerificationCooldownLabel,
  summarizeHhQueueGates,
} from './HhApplicationsPage';
import {
  classifyHhScreeningSubmission,
  clampHhScreeningQuestionIndex,
  isHhScreeningSubmissionAccepted,
  resolveHhScreeningVacancy,
  shouldResetHhScreeningQuestionPosition,
} from './HhHrProfilePage';
import { summarizeHomeHhQueue } from './HomePage';

function vacancy(
  id: string,
  status: HhQueueItem['status'],
  gate?: HhQueueItem['autoRetryBlockedUntil'],
  override: Partial<HhQueueItem> = {},
): HhQueueItem {
  return {
    key: `hh:${id}`,
    id,
    platform: 'hh',
    title: `Vacancy ${id}`,
    company: 'Example',
    salary: '',
    url: `https://hh.ru/vacancy/${id}`,
    status,
    addedAt: '2026-08-15T01:00:00.000Z',
    autoRetryBlockedUntil: gate,
    ...override,
  };
}

describe('HH queue UI state', () => {
  it('separates immediately eligible, daily, and manual vacancies', () => {
    const queue = [
      vacancy('1', 'new'),
      vacancy('2', 'opened', 'daily', { reason: 'HH трижды показал проверку.' }),
      vacancy('3', 'prepared', 'manual'),
      vacancy('4', 'needs_input', 'manual'),
      vacancy('5', 'sent'),
    ];

    expect(summarizeHhQueueGates(queue)).toEqual({ eligible: 1, daily: 1, manual: 1, verification: 1 });
    expect(summarizeHomeHhQueue(queue)).toEqual({ eligible: 1, daily: 1, manual: 1 });
  });

  it('presents automatic queue items as automatic and removes the redundant manual apply action', () => {
    expect(hhQueueItemPresentation(vacancy('1', 'new'), true)).toMatchObject({
      statusLabel: 'В автоочереди',
      showApplyButton: false,
    });
    expect(hhQueueItemPresentation(vacancy('2', 'opened', 'daily'), true)).toMatchObject({
      statusLabel: 'Автоповтор',
      showApplyButton: false,
    });
    expect(hhQueueItemPresentation(vacancy('3', 'opened', 'daily', {
      reason: 'HH трижды показал проверку.',
    }), true)).toMatchObject({
      statusLabel: 'Пауза HH',
      showApplyButton: false,
    });
  });

  it('describes a global HH cooldown as automatic rather than manual work', () => {
    expect(hhVerificationCooldownLabel(
      '2026-08-25T03:00:00.000Z',
      new Date('2026-08-25T01:00:00.000Z'),
    )).toContain('Автоотклики продолжатся сами');
    expect(hhVerificationCooldownLabel(
      '2026-08-25T01:00:00.000Z',
      new Date('2026-08-25T01:00:00.000Z'),
    )).toBe('');
  });

  it('keeps a direct apply action when automatic applications are disabled', () => {
    expect(hhQueueItemPresentation(vacancy('1', 'new'), false)).toMatchObject({
      statusLabel: 'В очереди',
      showApplyButton: true,
    });
  });

  it('builds a vacancy-specific question route and resolves that vacancy', () => {
    const first = vacancy('1', 'needs_input');
    const requested = vacancy('2', 'needs_input');

    expect(hhScreeningVacancyPath(requested.key)).toBe('/applications/hr-profile?vacancy=hh%3A2');
    expect(resolveHhScreeningVacancy([first, requested], '', requested.key)?.key).toBe(requested.key);
  });

  it('clears questionnaire drafts only after HH confirms a terminal success', () => {
    const target = {
      ...vacancy('1', 'needs_input'),
      pendingQuestions: [{
        id: 'q1',
        prompt: 'Где вы живёте?',
        kind: 'text' as const,
        options: [],
        required: true,
      }],
    };

    expect(isHhScreeningSubmissionAccepted({ queue: [target] }, target.key)).toBe(false);
    expect(isHhScreeningSubmissionAccepted({ queue: [{ ...target, status: 'prepared', pendingQuestions: undefined }] }, target.key)).toBe(false);
    expect(isHhScreeningSubmissionAccepted({ queue: [{ ...target, status: 'opened', pendingQuestions: undefined }] }, target.key)).toBe(false);
    expect(isHhScreeningSubmissionAccepted({ queue: [{ ...target, status: 'skipped', pendingQuestions: undefined }] }, target.key)).toBe(false);
    expect(isHhScreeningSubmissionAccepted({ queue: [] }, target.key)).toBe(false);
    expect(isHhScreeningSubmissionAccepted({ queue: [{ ...target, status: 'sent', pendingQuestions: undefined }] }, target.key)).toBe(true);
    expect(isHhScreeningSubmissionAccepted({ queue: [{ ...target, status: 'already_applied', pendingQuestions: undefined }] }, target.key)).toBe(true);
  });

  it('treats a fully persisted prepared questionnaire as queued success rather than an error', () => {
    const target = vacancy('1', 'prepared', undefined, {
      pendingQuestions: undefined,
      screeningAnswers: [{
        questionId: 'q1',
        question: 'Где вы живёте?',
        answer: 'Красноярск',
        selectedOptions: [],
        confirmedByUser: true,
      }],
    });

    expect(classifyHhScreeningSubmission({ queue: [target] }, target.key, ['q1']))
      .toBe('queued');
    expect(classifyHhScreeningSubmission({ queue: [{ ...target, status: 'sent' }] }, target.key, ['q1']))
      .toBe('sent');
    expect(classifyHhScreeningSubmission({ queue: [{ ...target, screeningAnswers: [] }] }, target.key, ['q1']))
      .toBe('rejected');
  });

  it('keeps the visible question during transient queue refreshes and vacancy-key normalization', () => {
    const target = vacancy('42', 'needs_input');

    expect(clampHhScreeningQuestionIndex(7, 0)).toBe(7);
    expect(clampHhScreeningQuestionIndex(7, 16)).toBe(7);
    expect(clampHhScreeningQuestionIndex(20, 16)).toBe(15);
    expect(shouldResetHhScreeningQuestionPosition(target, target.id)).toBe(false);
    expect(shouldResetHhScreeningQuestionPosition(target, target.key)).toBe(false);
    expect(shouldResetHhScreeningQuestionPosition(target, 'hh:another')).toBe(true);
  });
});
