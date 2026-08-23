import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HhBrowserAssistant,
  type HhAssistantState,
  type HhQueueItem,
} from './hhBrowserAssistant';

const temporaryDirectories: string[] = [];

function pendingRtsVacancy(): HhQueueItem {
  return {
    key: 'hh:135082692',
    platform: 'hh',
    id: '135082692',
    title: 'Junior Software Development Engineer in Test',
    company: 'Gear Games',
    salary: '',
    url: 'https://hh.ru/vacancy/135082692',
    status: 'needs_input',
    addedAt: new Date().toISOString(),
    pendingQuestions: [{
      id: 'rts-games',
      prompt: 'Нравятся ли вам игры жанра RTS? В какие игры этого жанра вы играли?',
      kind: 'text',
      options: [],
      required: true,
    }],
  };
}

function pendingRelocationVacancy(): HhQueueItem {
  return {
    ...pendingRtsVacancy(),
    key: 'hh:135790743',
    id: '135790743',
    title: 'DevOps/Infrastructure Engineer (Matrix, self-hosted, KSA)',
    company: 'Doubletapp',
    pendingQuestions: [{
      id: 'relocation',
      prompt: 'Готовы ли Вы к релокации в Саудовскую Аравию на 3 месяца (релокацию оплачиваем)?',
      kind: 'text',
      options: [],
      required: true,
    }],
  };
}

function createAssistant(
  generator: ConstructorParameters<typeof HhBrowserAssistant>[2],
  vacancy: HhQueueItem = pendingRtsVacancy(),
): HhBrowserAssistant {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-screening-suggestion-'));
  temporaryDirectories.push(directory);
  const assistant = new HhBrowserAssistant(directory, () => undefined, generator);
  const mutable = assistant as unknown as { state: HhAssistantState };
  mutable.state.queue = [vacancy];
  return assistant;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('HH interactive screening-answer suggestions', () => {
  it('uses the salary from the resume selected for this vacancy before another configured resume', async () => {
    const generator = vi.fn(async () => ({ answers: [] }));
    const vacancy: HhQueueItem = {
      ...pendingRtsVacancy(),
      selectedResumeTitle: 'QA Automation Engineer Python 220 000 ₽ · Удалённо',
      pendingQuestions: [{
        id: 'salary',
        prompt: 'Уточните, пожалуйста, Ваши финансовые ожидания',
        kind: 'text',
        options: [],
        required: true,
      }],
    };
    const assistant = createAssistant(generator, vacancy);
    const mutable = assistant as unknown as { state: HhAssistantState };
    mutable.state.config = {
      ...mutable.state.config,
      salaryFrom: null,
      resumeTitles: ['QA Fullstack Engineer Python 240 000 ₽ · Удалённо'],
    };
    vi.spyOn(assistant, 'getSelectedResumeText').mockResolvedValue(
      'QA Automation Engineer Python 220 000 ₽ · Удалённо\nГород проживания: Казань',
    );

    const result = await assistant.suggestScreeningAnswer(vacancy.key, 'salary');

    expect(result.source).toBe('profile');
    expect(result.answer).toMatch(/220[\s\u00a0]000 ₽/u);
    expect(result.answer).not.toContain('240');
    expect(generator).not.toHaveBeenCalled();
    expect(assistant.getSelectedResumeText).not.toHaveBeenCalled();
  });

  it('uses an exact answer already confirmed for this vacancy before the resume salary', async () => {
    const generator = vi.fn(async () => ({ answers: [] }));
    const vacancy: HhQueueItem = {
      ...pendingRtsVacancy(),
      selectedResumeTitle: 'QA Automation Engineer Python 220 000 ₽ · Удалённо',
      pendingQuestions: [{
        id: 'salary',
        prompt: 'Уточните, пожалуйста, Ваши финансовые ожидания',
        kind: 'text',
        options: [],
        required: true,
      }],
      screeningAnswers: [{
        questionId: 'salary',
        question: 'Уточните, пожалуйста, Ваши финансовые ожидания',
        answer: 'Рассматриваю предложения от 250 000 ₽ в месяц.',
        selectedOptions: [],
        confirmedByUser: true,
      }],
    };
    const assistant = createAssistant(generator, vacancy);
    vi.spyOn(assistant, 'getSelectedResumeText').mockResolvedValue(
      'QA Automation Engineer Python 220 000 ₽ · Удалённо',
    );

    const result = await assistant.suggestScreeningAnswer(vacancy.key, 'salary');

    expect(result).toMatchObject({ source: 'profile' });
    expect(result.answer).toMatch(/250[\s\u00a0]000 ₽/u);
    expect(assistant.getSelectedResumeText).not.toHaveBeenCalled();
    expect(generator).not.toHaveBeenCalled();
  });

  it('does not borrow a net qualifier from another configured resume', async () => {
    const generator = vi.fn(async () => ({ answers: [] }));
    const vacancy: HhQueueItem = {
      ...pendingRtsVacancy(),
      selectedResumeTitle: 'QA Automation Engineer Python 220 000 ₽ · Удалённо',
      pendingQuestions: [{
        id: 'salary',
        prompt: 'Уточните, пожалуйста, Ваши финансовые ожидания',
        kind: 'text',
        options: [],
        required: true,
      }],
    };
    const assistant = createAssistant(generator, vacancy);
    const mutable = assistant as unknown as { state: HhAssistantState };
    mutable.state.config = {
      ...mutable.state.config,
      salaryFrom: null,
      resumeTitles: ['QA Fullstack Engineer Python 220 000 ₽ на руки · Удалённо'],
    };

    const result = await assistant.suggestScreeningAnswer(vacancy.key, 'salary');

    expect(result.answer).toMatch(/220[\s\u00a0]000 ₽ в месяц/u);
    expect(result.answer).not.toContain('на руки');
    expect(generator).not.toHaveBeenCalled();
  });

  it('uses the selected resume amount for an explicit net salary question', async () => {
    const generator = vi.fn(async () => ({ answers: [] }));
    const vacancy: HhQueueItem = {
      ...pendingRtsVacancy(),
      selectedResumeTitle: 'Постоянная работа, подработка Qa Fullstack engineer python 240 000 ₽ · Удалённо',
      pendingQuestions: [{
        id: 'salary-net',
        prompt: 'Какая сумма на руки будет для вас комфортна?',
        kind: 'text',
        options: [],
        required: true,
      }],
    };
    const assistant = createAssistant(generator, vacancy);

    const result = await assistant.suggestScreeningAnswer(vacancy.key, 'salary-net');

    expect(result).toMatchObject({ source: 'profile' });
    expect(result.answer).toContain('240\u00a0000 ₽ на руки');
    expect(generator).not.toHaveBeenCalled();
  });

  it('does not borrow a salary from another resume when the selected resume has none', async () => {
    const generator = vi.fn(async () => ({ answers: [] }));
    const vacancy: HhQueueItem = {
      ...pendingRtsVacancy(),
      selectedResumeTitle: 'QA Automation Engineer Python · Удалённо',
      pendingQuestions: [{
        id: 'salary',
        prompt: 'Уточните, пожалуйста, Ваши финансовые ожидания',
        kind: 'text',
        options: [],
        required: true,
      }],
    };
    const assistant = createAssistant(generator, vacancy);
    const mutable = assistant as unknown as { state: HhAssistantState };
    mutable.state.config = {
      ...mutable.state.config,
      salaryFrom: null,
      resumeTitles: ['QA Fullstack Engineer Python 240 000 ₽ на руки · Удалённо'],
    };
    vi.spyOn(assistant, 'getSelectedResumeText').mockResolvedValue(
      'QA Automation Engineer Python · Удалённо\nГород проживания: Казань',
    );

    const result = await assistant.suggestScreeningAnswer(vacancy.key, 'salary');

    expect(result.answer).not.toContain('240');
    expect(assistant.getSelectedResumeText).toHaveBeenCalledOnce();
    expect(generator).toHaveBeenCalledOnce();
  });

  it('keeps a remembered city review-only until the exact resume is selected', async () => {
    const generator = vi.fn(async () => ({ answers: [] }));
    const vacancy: HhQueueItem = {
      ...pendingRtsVacancy(),
      pendingQuestions: [{
        id: 'city',
        prompt: 'Где вы сейчас живёте?',
        kind: 'text',
        options: [],
        required: true,
      }],
    };
    const assistant = createAssistant(generator, vacancy);
    const mutable = assistant as unknown as { state: HhAssistantState };
    mutable.state.screeningFacts = [{
      id: 'confirmed-city',
      question: 'В каком городе проживаешь фактически?',
      answer: 'Казань',
      selectedOptions: [],
      updatedAt: new Date().toISOString(),
    }];

    const result = await assistant.suggestScreeningAnswer(vacancy.key, 'city');

    expect(result).toMatchObject({ source: 'local', answer: 'Казань' });
    expect(result.note).toContain('резюме для этой вакансии ещё не подтверждено');
    expect(generator).not.toHaveBeenCalled();
  });

  it('prefers the city in the selected resume over an older saved city', async () => {
    const generator = vi.fn(async () => ({ answers: [] }));
    const vacancy: HhQueueItem = {
      ...pendingRtsVacancy(),
      selectedResumeTitle: 'QA Automation Engineer Python 220 000 ₽ · Удалённо',
      pendingQuestions: [{
        id: 'city',
        prompt: 'Где вы сейчас живёте?',
        kind: 'text',
        options: [],
        required: true,
      }],
    };
    const assistant = createAssistant(generator, vacancy);
    const mutable = assistant as unknown as { state: HhAssistantState };
    mutable.state.screeningFacts = [{
      id: 'old-confirmed-city',
      question: 'В каком городе проживаешь фактически?',
      answer: 'Казань',
      selectedOptions: [],
      updatedAt: '2025-01-01T00:00:00.000Z',
    }];
    vi.spyOn(assistant, 'getSelectedResumeText').mockResolvedValue(
      'QA Automation Engineer\nГород проживания: Москва',
    );
    const browserInternals = assistant as unknown as { ensureBrowser: () => Promise<unknown> };
    browserInternals.ensureBrowser = vi.fn(async () => ({}));

    const result = await assistant.suggestScreeningAnswer(vacancy.key, 'city');

    expect(result).toMatchObject({ source: 'profile', answer: 'Москва' });
    expect(result.answer).not.toBe('Казань');
    expect(assistant.getSelectedResumeText).toHaveBeenCalledOnce();
    expect(generator).not.toHaveBeenCalled();
  });

  it('does not mark a stale saved city as confirmed when the selected resume cannot be loaded', async () => {
    const generator = vi.fn(async () => ({ answers: [] }));
    const vacancy: HhQueueItem = {
      ...pendingRtsVacancy(),
      selectedResumeTitle: 'QA Automation Engineer Python 220 000 ₽ · Удалённо',
      pendingQuestions: [{
        id: 'city-load-error',
        prompt: 'Где вы сейчас живёте?',
        kind: 'text',
        options: [],
        required: true,
      }],
    };
    const assistant = createAssistant(generator, vacancy);
    const mutable = assistant as unknown as {
      state: HhAssistantState;
      ensureBrowser: () => Promise<unknown>;
    };
    mutable.state.screeningFacts = [{
      id: 'stale-city',
      question: 'Где вы сейчас живёте?',
      answer: 'Москва',
      selectedOptions: [],
      updatedAt: '2025-01-01T00:00:00.000Z',
    }];
    mutable.ensureBrowser = vi.fn(async () => ({}));
    vi.spyOn(assistant, 'getSelectedResumeText').mockRejectedValue(
      new Error('HH временно не вернул выбранное резюме.'),
    );

    const result = await assistant.suggestScreeningAnswer(vacancy.key, 'city-load-error');

    expect(result.source).toBe('local');
    expect(result.answer).not.toBe('Москва');
    expect(result.note).toContain('Онлайн-генератор сейчас недоступен');
  });

  it('asks the model for a review-only draft and returns it to the editor', async () => {
    const generator = vi.fn(async (request) => ({
      answers: [{
        id: request.questions[0].id,
        answer: 'Да, играл в StarCraft II; особенно интересны баланс и матчмейкинг.',
        selectedOptions: [],
        canAutoFill: false,
      }],
    }));
    const assistant = createAssistant(generator);

    const result = await assistant.suggestScreeningAnswer('hh:135082692', 'rts-games');

    expect(generator).toHaveBeenCalledOnce();
    expect(generator.mock.calls[0][0].draftMode).toBe(true);
    expect(result.source).toBe('ai');
    expect(result.answer).toContain('StarCraft II');
    expect(result.note).toContain('ИИ-предположение');
  });

  it('refines the text already written by the user instead of replacing it with a new hypothesis', async () => {
    const generator = vi.fn(async (request) => ({
      answers: [{
        id: request.questions[0].id,
        answer: 'Да, знаком с RTS и играл в StarCraft II; особенно интересны баланс и матчмейкинг.',
        selectedOptions: [],
        canAutoFill: false,
      }],
    }));
    const assistant = createAssistant(generator);

    const result = await assistant.suggestScreeningAnswer(
      'hh:135082692',
      'rts-games',
      'да знаком с rts играл в starcraft 2',
    );

    expect(generator).toHaveBeenCalledOnce();
    expect(generator.mock.calls[0][0].existingDraft).toEqual({
      questionId: 'rts-games',
      answer: 'да знаком с rts играл в starcraft 2',
    });
    expect(result.answer).toContain('знаком с RTS');
    expect(result.note).toContain('сохранив исходный смысл');
  });

  it('provides a safe non-empty review draft when personal game history is unknown', async () => {
    const assistant = createAssistant(async () => {
      throw new Error('Месячный лимит токенов исчерпан');
    });

    const result = await assistant.suggestScreeningAnswer('135082692', 'rts-games');

    expect(result.source).toBe('local');
    expect(result.answer).toBeTruthy();
    expect(result.answer).not.toMatch(/StarCraft|Age of Empires|Brawl Stars|Clash Royale/);
    expect(result.note).toContain('Онлайн-генератор сейчас недоступен');
  });

  it('returns the unchanged existing user answer when AI quota is exhausted', async () => {
    const assistant = createAssistant(async () => {
      throw new Error('Месячный лимит токенов исчерпан');
    });

    const result = await assistant.suggestScreeningAnswer(
      '135082692',
      'rts-games',
      'Да, немного знаком с жанром RTS.',
    );

    expect(result.answer).toBe('Да, немного знаком с жанром RTS.');
    expect(result.source).toBe('local');
    expect(result.note).toContain('сохранён без изменений');
  });

  it('turns a quota failure into neutral relocation guidance', async () => {
    const assistant = createAssistant(async () => {
      throw new Error('Месячный лимит токенов тарифа исчерпан');
    }, pendingRelocationVacancy());

    const result = await assistant.suggestScreeningAnswer('135790743', 'relocation');

    expect(result.source).toBe('local');
    expect(result.answer).toContain('релокации');
    expect(result.answer).toContain('подтвердить');
    expect(result.answer).not.toContain('готов рассмотреть');
    expect(result.note).not.toContain('Месячный лимит токенов');
  });

  it('does not throw or guess yes/no for an unknown official-employment option', async () => {
    const officialVacancy: HhQueueItem = {
      ...pendingRtsVacancy(),
      key: 'hh:official',
      id: 'official',
      pendingQuestions: [{
        id: 'official-employment',
        prompt: 'Твой опыт работы за последние 3 года - официальный (по ТК РФ)?',
        kind: 'single',
        options: ['Да', 'Нет'],
        required: true,
      }],
    };
    const assistant = createAssistant(async () => {
      throw new Error('Провайдер временно недоступен');
    }, officialVacancy);

    const result = await assistant.suggestScreeningAnswer(
      'official',
      'official-employment',
    );

    expect(result.source).toBe('local');
    expect(result.selectedOptions).toEqual([]);
    expect(result.answer).toContain('не будет угадывать');
    expect(result.note).toContain('Онлайн-генератор сейчас недоступен');
  });

  it('returns a local draft when the selected resume body cannot be fetched', async () => {
    const outstaffVacancy: HhQueueItem = {
      ...pendingRtsVacancy(),
      selectedResumeTitle: 'QA Automation Engineer',
      pendingQuestions: [{
        id: 'outstaff',
        prompt: 'Готовы ли вы работать по модели аутстаффинга?',
        kind: 'text',
        options: [],
        required: true,
      }],
    };
    const assistant = createAssistant(async () => {
      throw new Error('Онлайн-генератор недоступен');
    }, outstaffVacancy);
    const testable = assistant as unknown as {
      getSelectedResumeText: () => Promise<string>;
    };
    testable.getSelectedResumeText = vi.fn(async () => {
      throw new Error('HH временно не вернул текст резюме.');
    });

    const result = await assistant.suggestScreeningAnswer(
      outstaffVacancy.id,
      'outstaff',
    );

    expect(result.source).toBe('local');
    expect(result.answer).toContain('нужно подтвердить');
    expect(result.note).toContain('Онлайн-генератор сейчас недоступен');
  });
});
