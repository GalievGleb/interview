import { describe, expect, it } from 'vitest';
import {
  countUnansweredHhScreeningQuestions,
  isHhAiQuotaMessage,
  isHhScreeningAnswerComplete,
  isHhScreeningDraftReady,
  hhScreeningPromptKey,
  hhScreeningSemanticKey,
  readHhScreeningDrafts,
  reconcileHhScreeningLocalDraft,
  summarizePendingHhScreening,
} from './hhScreening';
import type { HhQueueItem } from '../types/electron';

function vacancy(id: string, prompt: string, assistantReason?: string): HhQueueItem {
  return {
    key: `hh:${id}`,
    platform: 'hh',
    id,
    title: 'QA',
    company: 'Company',
    salary: '',
    url: `https://hh.ru/vacancy/${id}`,
    status: 'needs_input',
    addedAt: new Date().toISOString(),
    pendingQuestions: [{ id: `q-${id}`, prompt, kind: 'text', options: [], required: true, assistantReason }],
  };
}

describe('HH pending screening summary', () => {
  it('treats a visible answer as ready for the explicit Send action without a second confirmation click', () => {
    expect(isHhScreeningDraftReady(
      { kind: 'text' },
      'Да, работал с Kafka и RabbitMQ.',
      [],
    )).toBe(true);
    expect(isHhScreeningDraftReady({ kind: 'single' }, '', ['Да'])).toBe(true);
    expect(isHhScreeningDraftReady({ kind: 'text' }, '   ', [])).toBe(false);
  });

  it('subtracts locally answered drafts from the visible remaining count', () => {
    const summary = summarizePendingHhScreening([
      vacancy('one', 'Готовы работать удалённо?'),
      vacancy('two', 'Назовите зарплатные ожидания'),
    ]);
    const drafts = readHhScreeningDrafts({
      getItem: () => JSON.stringify({
        'hh:one::q-one': {
          answer: 'Да',
          selectedOptions: [],
          confirmedByUser: true,
          promptKey: hhScreeningPromptKey('Готовы работать удалённо?'),
        },
      }),
    });

    expect(countUnansweredHhScreeningQuestions(summary, drafts)).toBe(1);
  });

  it('accepts short yes/no text as a complete employer answer', () => {
    const textQuestion = { kind: 'text' as const };
    expect(isHhScreeningAnswerComplete(textQuestion, 'Нет', [], true)).toBe(true);
    expect(isHhScreeningAnswerComplete(textQuestion, 'Да', [], true)).toBe(true);
    expect(isHhScreeningAnswerComplete(textQuestion, '   ', [], true)).toBe(false);
  });

  it('does not count an AI suggestion as complete until the user accepts it', () => {
    const summary = summarizePendingHhScreening([vacancy('one', 'Готовы работать удалённо?')]);
    const drafts = readHhScreeningDrafts({
      getItem: () => JSON.stringify({
        'hh:one::q-one': { answer: 'Да', selectedOptions: [], confirmedByUser: false },
      }),
    });

    expect(isHhScreeningAnswerComplete({ kind: 'text' }, 'Да', [], false)).toBe(false);
    expect(countUnansweredHhScreeningQuestions(summary, drafts)).toBe(1);
  });

  it('treats legacy drafts without an explicit confirmation flag as unconfirmed', () => {
    const drafts = readHhScreeningDrafts({
      getItem: () => JSON.stringify({
        legacy: { answer: 'Да', selectedOptions: [] },
      }),
    });
    expect(drafts.legacy.confirmedByUser).toBe(false);
  });

  it('replaces an unconfirmed legacy legal choice with safe queue guidance', () => {
    const question = {
      id: 'official-work',
      prompt: 'Твой опыт работы за последние 3 года — официальный (по ТК РФ)?',
      kind: 'single' as const,
      options: ['Да', 'Нет (ИП/ГПХ/другое)'],
      required: true,
      suggestedAnswer: 'Выберите точный вариант: SkillCue не будет угадывать.',
    };
    const result = reconcileHhScreeningLocalDraft(question, {
      answer: '',
      selectedOptions: ['Нет (ИП/ГПХ/другое)'],
      confirmedByUser: false,
    });

    expect(result.selectedOptions).toEqual([]);
    expect(result.answer).toContain('не будет угадывать');
    expect(result.confirmedByUser).toBe(false);
  });

  it('preserves an explicitly confirmed legal choice during the draft migration', () => {
    const prompt = 'Опыт был официальным по ТК РФ?';
    const confirmed = {
      answer: '',
      selectedOptions: ['Нет'],
      confirmedByUser: true,
      promptKey: hhScreeningPromptKey(prompt),
    };
    const result = reconcileHhScreeningLocalDraft({
      id: 'official-work',
      prompt,
      kind: 'single',
      options: ['Да', 'Нет'],
      required: true,
      suggestedAnswer: 'Проверьте точный вариант.',
    }, confirmed);

    expect(result).toBe(confirmed);
  });

  it('scrubs an unconfirmed personal-history text draft from legacy local storage', () => {
    const result = reconcileHhScreeningLocalDraft({
      id: 'games',
      prompt: 'Нравятся ли вам игры жанра RTS? В какие игры этого жанра вы играли?',
      kind: 'text',
      options: [],
      required: true,
    }, {
      answer: 'Да, играл в StarCraft II и Age of Empires II.',
      selectedOptions: [],
      confirmedByUser: false,
    });

    expect(result.answer).not.toMatch(/StarCraft|Age of Empires/);
    expect(result.answer).toBe('');
    expect(result.confirmedByUser).toBe(false);
  });

  it('preserves explicitly confirmed personal-history text during migration', () => {
    const prompt = 'Нравятся ли вам игры жанра RTS? В какие игры этого жанра вы играли?';
    const confirmed = {
      answer: 'Да, играл в StarCraft II.',
      selectedOptions: [],
      confirmedByUser: true,
      promptKey: hhScreeningPromptKey(prompt),
    };
    const result = reconcileHhScreeningLocalDraft({
      id: 'games',
      prompt,
      kind: 'text',
      options: [],
      required: true,
    }, confirmed);

    expect(result).toBe(confirmed);
  });

  it('does not reuse a confirmed value when HH changes the prompt behind the same id', () => {
    const prompt = 'Укажите ваш текущий город';
    const result = reconcileHhScreeningLocalDraft({
      id: 'question-1',
      prompt,
      kind: 'text',
      options: [],
      required: true,
      suggestedAnswer: 'Казань',
    }, {
      answer: 'Готов дать предметный ответ; перед отправкой уточню личные факты и оставлю только то, что точно соответствует моему опыту.',
      selectedOptions: [],
      confirmedByUser: true,
      promptKey: hhScreeningPromptKey('Работали ли вы с Python?'),
    });

    expect(result).toMatchObject({
      answer: 'Казань',
      confirmedByUser: false,
      promptKey: hhScreeningPromptKey(prompt),
    });
  });

  it('downgrades a legacy confirmed draft that has no prompt fingerprint', () => {
    const result = reconcileHhScreeningLocalDraft({
      id: 'status',
      prompt: 'Есть ли у вас действующая рабочая виза?',
      kind: 'single',
      options: ['Да', 'Нет'],
      required: true,
    }, {
      answer: '',
      selectedOptions: ['Да'],
      confirmedByUser: true,
    });

    expect(result.confirmedByUser).toBe(false);
    expect(result.selectedOptions).toEqual([]);
    expect(result.promptKey).toBe(hhScreeningPromptKey('Есть ли у вас действующая рабочая виза?'));
  });

  it('replaces an empty unconfirmed local draft with the new queue suggestion', () => {
    const result = reconcileHhScreeningLocalDraft({
      id: 'motivation',
      prompt: 'Почему вам интересна вакансия?',
      kind: 'text',
      options: [],
      required: true,
      suggestedAnswer: 'Мне интересны задачи продукта и зона ответственности.',
    }, {
      answer: '',
      selectedOptions: [],
      confirmedByUser: false,
    });

    expect(result.answer).toBe('Мне интересны задачи продукта и зона ответственности.');
    expect(result.confirmedByUser).toBe(false);
  });

  it('counts repeated employer prompts once', () => {
    const summary = summarizePendingHhScreening([
      vacancy('1', 'Где вы живёте?'),
      vacancy('2', '  ГДЕ Вы живете? '),
    ]);
    expect(summary.rawCount).toBe(2);
    expect(summary.uniqueCount).toBe(1);
  });

  it('counts differently worded current-city questions once', () => {
    const summary = summarizePendingHhScreening([
      vacancy('1', 'В каком городе проживаешь фактически?'),
      vacancy('2', 'Где вы сейчас живёте?'),
      vacancy('3', 'Укажите город вашего текущего проживания'),
      vacancy('4', 'Где живёте?'),
      vacancy('5', 'Где живешь?'),
      vacancy('6', 'Укажите населённый пункт'),
    ]);
    expect(summary.rawCount).toBe(6);
    expect(summary.uniqueCount).toBe(1);
    expect(hhScreeningSemanticKey('Где вы сейчас живёте?')).toBe('profile:current-location');
    expect(hhScreeningSemanticKey('Где живёте?')).toBe('profile:current-location');
    expect(hhScreeningSemanticKey('Где живешь?')).toBe('profile:current-location');
    expect(hhScreeningSemanticKey('Укажите населённый пункт')).toBe('profile:current-location');
  });

  it('groups differently worded age questions without mixing in date of birth', () => {
    expect(hhScreeningSemanticKey('Сколько вам лет?')).toBe('profile:age');
    expect(hhScreeningSemanticKey('Укажите ваш возраст полных лет')).toBe('profile:age');
    expect(hhScreeningSemanticKey('Укажите дату рождения')).not.toBe('profile:age');
  });

  it('groups backend/frontend testing ratio wording without mixing in experience duration', () => {
    expect(hhScreeningSemanticKey('Сколько в процентах вы тестировали бэкэнд к фронту?'))
      .toBe('profile:test-scope-ratio');
    expect(hhScreeningSemanticKey('Какое соотношение тестирования backend и frontend?'))
      .toBe('profile:test-scope-ratio');
    expect(hhScreeningSemanticKey('Сколько лет опыта автотестов Backend и Frontend?'))
      .not.toBe('profile:test-scope-ratio');
  });

  it('keeps project geography restrictions separate from the current city', () => {
    expect(hhScreeningSemanticKey(
      'На проектах есть ограничения по месту нахождения кандидата (РФ/вне РФ). Готовы ли вы рассматривать такие проекты?',
    )).not.toBe('profile:current-location');
  });

  it.each([
    'В каком регионе вы сейчас проживаете?',
    'В каком субъекте РФ вы сейчас проживаете?',
    'Укажите область проживания',
  ])('keeps a requested region separate from a current-city fact: %s', (prompt) => {
    expect(hhScreeningSemanticKey(prompt)).not.toBe('profile:current-location');
  });

  it.each([
    'Укажите ваш город рождения',
    'Укажите город регистрации',
    'Укажите город прописки',
    'Укажите город, где находится офис работодателя',
    'В каком городе работает команда проекта?',
    'Укажите город, в котором хотели бы работать',
    'Укажите город получения образования',
    'Укажите любимый город',
    'Назовите любой город',
  ])('does not group another place with current residence: %s', (prompt) => {
    expect(hhScreeningSemanticKey(prompt)).not.toBe('profile:current-location');
  });

  it('keeps every relocation destination visible as a separate question', () => {
    const summary = summarizePendingHhScreening([
      vacancy('1', 'Готовы ли вы к переезду в Рязань?'),
      vacancy('2', 'Готовы ли вы к переезду в Йошкар-Олу?'),
      vacancy('3', 'Готовы ли вы к релокации в Саудовскую Аравию?'),
    ]);
    expect(summary.rawCount).toBe(3);
    expect(summary.uniqueCount).toBe(3);
    expect(hhScreeningSemanticKey('Переезд в Рязань')).not.toBe(hhScreeningSemanticKey('Релокация в Саудовскую Аравию'));
  });

  it('keeps an unrecognized relocation destination isolated', () => {
    const summary = summarizePendingHhScreening([
      vacancy('1', 'Готовы ли вы к переезду в Пуэрто-Вальярту?'),
      vacancy('2', 'Готовы ли вы к переезду в Рязань?'),
    ]);
    expect(summary.uniqueCount).toBe(2);
  });

  it('separates an AI quota failure from a missing candidate fact', () => {
    const summary = summarizePendingHhScreening([
      vacancy('1', 'Ваш опыт?', 'Месячный лимит токенов тарифа исчерпан'),
      vacancy('2', 'Готовы к релокации?', 'Нужен подтверждённый ответ пользователя'),
    ]);
    expect(summary.quotaLimitedCount).toBe(1);
    expect(summary.missingFactCount).toBe(1);
    expect(isHhAiQuotaMessage('Лимит обновится 1-го числа')).toBe(true);
  });
});
