import { describe, expect, it } from 'vitest';
import { buildHhScreeningReviewDraft, isUsableHhScreeningDraft } from './hhScreeningReviewDraft';
import type { HhScreeningQuestion } from './hhScreeningQuestions';

function question(
  kind: HhScreeningQuestion['kind'],
  prompt: string,
  options: string[] = [],
): HhScreeningQuestion {
  return { id: `${kind}-question`, kind, prompt, options, required: true };
}

describe('last-resort HH screening review drafts', () => {
  it('leaves an unknown personal fact empty instead of presenting a generic filler as an answer', () => {
    const item = question('text', 'В каком городе вы сейчас живёте?');
    const draft = buildHhScreeningReviewDraft(item);

    expect(draft.answer).toBe('');
    expect(draft.canAutoFill).toBe(false);
    expect(isUsableHhScreeningDraft(item, draft)).toBe(false);
  });

  it('uses concrete matching resume evidence instead of referring the employer back to the resume', () => {
    const item = question(
      'text',
      'Имеется ли у вас опыт администрирования Windows или Linux? Опишите, чем занимались.',
    );
    const draft = buildHhScreeningReviewDraft(item, {
      resumeText: 'Администрировал Linux-серверы: управлял пользователями, правами доступа, systemd-сервисами и анализировал журналы.',
    });

    expect(draft.answer).toContain('управлял пользователями');
    expect(draft.answer).toContain('systemd');
    expect(draft.answer).not.toMatch(/в резюме|готов.*обсуд/i);
  });

  it.each(['single', 'select'] as const)('does not guess an unsupported %s option', (kind) => {
    const item = question(kind, 'Готовы ли вы работать удалённо?', ['Да', 'Нет']);
    const draft = buildHhScreeningReviewDraft(item);

    expect(draft.selectedOptions).toEqual([]);
    expect(draft.answer).toContain('не будет угадывать');
    expect(draft.canAutoFill).toBe(false);
    expect(isUsableHhScreeningDraft(item, draft)).toBe(true);
  });

  it('does not turn an unknown Swift experience question into Yes', () => {
    const item = question('single', 'Работали ли вы со Swift?', ['Да', 'Нет']);
    const draft = buildHhScreeningReviewDraft(item, {
      resumeText: 'QA Automation на Python: API и UI автотесты.',
    });

    expect(draft.selectedOptions).toEqual([]);
    expect(draft.answer).toContain('опыта');
    expect(draft.canAutoFill).toBe(false);
  });

  it('uses resume-matching exact labels for a multiple-choice review draft', () => {
    const item = question('multiple', 'С какими инструментами вы работали?', ['Java', 'Python', 'Playwright']);
    const draft = buildHhScreeningReviewDraft(item, {
      resumeText: 'QA Automation: Python, Pytest, Playwright.',
    });

    expect(draft.selectedOptions).toEqual(['Python', 'Playwright']);
    expect(draft.canAutoFill).toBe(false);
    expect(isUsableHhScreeningDraft(item, draft)).toBe(true);
  });

  it('prefers a neutral option when no resume evidence is available', () => {
    const item = question('multiple', 'Какой формат вы рассматриваете?', ['Офис', 'Удалённо', 'Готов обсудить']);
    const draft = buildHhScreeningReviewDraft(item);

    expect(draft.selectedOptions).toEqual(['Готов обсудить']);
  });

  it('never guesses yes or no for official employment under the Russian Labour Code', () => {
    const item = question(
      'single',
      'Твой опыт работы за последние 3 года - официальный (по ТК РФ)?',
      ['Да', 'Нет'],
    );
    const draft = buildHhScreeningReviewDraft(item, {
      resumeText: 'Решал задачи обработки данных и поддерживал автотесты на Python.',
    });

    expect(draft.selectedOptions).toEqual([]);
    expect(draft.answer).toContain('не будет угадывать');
    expect(draft.canAutoFill).toBe(false);
    expect(isUsableHhScreeningDraft(item, draft)).toBe(true);
  });

  it('keeps the outstaffing preference neutral until the user confirms it', () => {
    const item = question('text', 'Готовы ли вы работать по модели аутстаффинга?');
    const draft = buildHhScreeningReviewDraft(item);

    expect(draft.answer).toContain('нужно подтвердить');
    expect(draft.answer).not.toContain('Готов рассмотреть');
    expect(draft.canAutoFill).toBe(false);
  });

  it('keeps location restrictions explicit and review-only', () => {
    const item = question('text', 'Есть ли ограничения по месту нахождения в РФ / вне РФ?');
    const draft = buildHhScreeningReviewDraft(item);

    expect(draft.answer).toContain('ограничения по месту нахождения');
    expect(draft.answer).toContain('РФ');
    expect(draft.canAutoFill).toBe(false);
  });
});
