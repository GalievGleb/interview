import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HhBrowserAssistant, type HhAssistantState, type HhQueueItem } from './hhBrowserAssistant';

const directories: string[] = [];

function pending(id: string): HhQueueItem {
  return {
    key: `hh:${id}`,
    platform: 'hh',
    id,
    title: `QA ${id}`,
    company: 'Example',
    salary: '',
    url: `https://hh.ru/vacancy/${id}`,
    status: 'needs_input',
    addedAt: new Date().toISOString(),
    pendingQuestions: [{
      id: `location-${id}`,
      prompt: 'В какой локации вы проживаете?',
      kind: 'text',
      options: [],
      required: true,
    }],
  };
}

function relocationPending(id: string, city: string, options: string[]): HhQueueItem {
  return {
    ...pending(id),
    pendingQuestions: [{
      id: `relocation-${id}`,
      prompt: `Готовы ли вы к переезду в ${city}?`,
      kind: 'single',
      options,
      required: true,
    }],
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('HH remembered screening answers', () => {
  it('unblocks every vacancy with the same normalized question', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-screening-reuse-'));
    directories.push(directory);
    const assistant = new HhBrowserAssistant(directory, () => undefined);
    const mutable = assistant as unknown as {
      state: HhAssistantState;
      applyInFlight: boolean;
    };
    mutable.state.config = { ...mutable.state.config, autoRunDaily: false };
    mutable.state.queue = [pending('1'), pending('2')];
    mutable.applyInFlight = true;

    const state = await assistant.answerScreeningQuestions('hh:1', [{
      questionId: 'location-1',
      question: 'В какой локации вы проживаете?',
      answer: 'Казань',
      selectedOptions: [],
      remember: true,
    }]);

    expect(state.queue.find((item) => item.key === 'hh:1')?.status).toBe('prepared');
    const reused = state.queue.find((item) => item.key === 'hh:2');
    expect(reused?.status).toBe('prepared');
    expect(reused?.pendingQuestions).toBeUndefined();
    expect(reused?.screeningAnswers?.[0].answer).toBe('Казань');
    expect(state.screeningFacts).toHaveLength(1);
  });

  it('applies one Russian relocation answer to another city and option wording', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-relocation-reuse-'));
    directories.push(directory);
    const assistant = new HhBrowserAssistant(directory, () => undefined);
    const mutable = assistant as unknown as { state: HhAssistantState; applyInFlight: boolean };
    mutable.state.config = { ...mutable.state.config, autoRunDaily: false, schedule: '' };
    mutable.state.queue = [
      relocationPending('1', 'г. Рязань', ['Да, готов переехать', 'Нет, рассматриваю только удалённый формат']),
      relocationPending('2', 'Йошкар-Олу', ['Да, готов(а)', 'Скорее да, хотелось бы узнать условия', 'Нет, рассматриваю только работу в своем городе']),
    ];
    mutable.applyInFlight = true;

    const state = await assistant.answerScreeningQuestions('hh:1', [{
      questionId: 'relocation-1',
      answer: '',
      selectedOptions: ['Нет, рассматриваю только удалённый формат'],
      remember: true,
    }]);

    const reused = state.queue.find((item) => item.key === 'hh:2');
    expect(reused?.status).toBe('prepared');
    expect(reused?.pendingQuestions).toBeUndefined();
    expect(reused?.screeningAnswers?.[0].selectedOptions).toEqual([
      'Нет, рассматриваю только работу в своем городе',
    ]);
    expect(state.screeningFacts).toHaveLength(1);
  });

  it('accepts one visible answer for duplicate relocation questions in the same HH form', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-relocation-same-form-'));
    directories.push(directory);
    const assistant = new HhBrowserAssistant(directory, () => undefined);
    const mutable = assistant as unknown as { state: HhAssistantState; applyInFlight: boolean };
    mutable.state.config = { ...mutable.state.config, autoRunDaily: false, schedule: '' };
    const first = relocationPending('1', 'Рязань', ['Да', 'Нет, только удалённо']);
    mutable.state.queue = [{
      ...first,
      pendingQuestions: [
        first.pendingQuestions![0],
        {
          id: 'relocation-1-duplicate',
          prompt: 'Рассматриваете ли вы переезд в Йошкар-Олу?',
          kind: 'single',
          options: ['Да, готов(а)', 'Нет, рассматриваю только работу в своем городе'],
          required: true,
        },
      ],
    }];
    mutable.applyInFlight = true;

    const state = await assistant.answerScreeningQuestions('hh:1', [{
      questionId: 'relocation-1',
      answer: '',
      selectedOptions: ['Нет, только удалённо'],
      remember: true,
    }]);

    expect(state.queue[0]?.status).toBe('prepared');
    expect(state.queue[0]?.pendingQuestions).toBeUndefined();
    expect(state.phase).not.toBe('manual_required');
  });

  it('resolves persisted Russian relocation questions from the remote-only search filter', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-relocation-remote-'));
    directories.push(directory);
    const assistant = new HhBrowserAssistant(directory, () => undefined);
    const mutable = assistant as unknown as { state: HhAssistantState };
    mutable.state.screeningFacts = [{
      id: 'old-relocation-preference',
      question: 'Готовы ли вы к переезду в Йошкар-Олу?',
      answer: '',
      selectedOptions: ['Скорее да, хотелось бы узнать условия'],
      updatedAt: new Date().toISOString(),
    }];
    mutable.state.queue = [
      relocationPending('1', 'Рязань', ['Да, готов переехать', 'Нет, только удалённый формат']),
    ];

    const state = assistant.saveConfig({ schedule: 'remote', autoSend: false });

    expect(state.queue[0]?.status).toBe('prepared');
    expect(state.queue[0]?.pendingQuestions).toBeUndefined();
    expect(state.queue[0]?.screeningAnswers?.[0].selectedOptions).toEqual(['Нет, только удалённый формат']);
    expect(state.screeningFacts[0]?.answer).toContain('переезд по России не рассматриваю');
    expect(state.screeningFacts[0]?.selectedOptions).toEqual([]);
  });

  it('replaces a stale Russian relocation choice in an unfinished restored application', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-relocation-stale-'));
    directories.push(directory);
    fs.writeFileSync(path.join(directory, 'hh-browser-assistant.json'), JSON.stringify({
      version: 2,
      config: {
        ...new HhBrowserAssistant(directory, () => undefined).getState().config,
        schedule: 'remote',
        autoRunDaily: false,
        autoSend: false,
      },
      queue: [{
        ...relocationPending(
          '135485641',
          'Йошкар-Олу',
          [
            'Да, готов(а)',
            'Скорее да, хотелось бы узнать условия релокации',
            'Пока не уверен(а), готов(а) обсудить',
            'Нет, рассматриваю только работу в своем городе',
          ],
        ),
        title: 'Senior Full Stack QA Engineer (в Йошкар-Олу)',
        company: 'iSpring',
        status: 'opened',
        pendingQuestions: undefined,
        screeningAnswers: [{
          questionId: 'relocation-135485641',
          question: 'Готовы ли вы к переезду в Йошкар-Олу?',
          answer: '',
          selectedOptions: ['Пока не уверен(а), готов(а) обсудить'],
        }],
      }],
      screeningFacts: [],
      runHistory: [],
    }, null, 2), 'utf8');

    const restored = new HhBrowserAssistant(directory, () => undefined).getState();
    const answer = restored.queue[0]?.screeningAnswers?.[0];

    expect(restored.queue[0]?.status).toBe('opened');
    expect(answer?.question).toBe('Готовы ли вы к переезду в Йошкар-Олу?');
    expect(answer?.answer).toContain('переезд по России не рассматриваю');
    expect(answer?.selectedOptions).toEqual([]);
  });

  it('suggests the current remote-only preference instead of an older Russian relocation fact', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-relocation-precedence-'));
    directories.push(directory);
    const assistant = new HhBrowserAssistant(directory, () => undefined);
    const mutable = assistant as unknown as { state: HhAssistantState };
    mutable.state.config = { ...mutable.state.config, schedule: 'remote' };
    mutable.state.screeningFacts = [{
      id: 'old-relocation-preference',
      question: 'Готовы ли вы к переезду в Йошкар-Олу?',
      answer: '',
      selectedOptions: ['Да, готов(а)'],
      updatedAt: new Date().toISOString(),
    }];
    mutable.state.queue = [
      relocationPending('1', 'Рязань', ['Да, готов переехать', 'Нет, только удалённый формат']),
    ];

    const suggestion = await assistant.suggestScreeningAnswer('hh:1', 'relocation-1');

    expect(suggestion.selectedOptions).toEqual(['Нет, только удалённый формат']);
    expect(suggestion.note).toContain('без переезда по России');
  });
});
