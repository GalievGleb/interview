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
  it('does not propagate a remembered city into another vacancy or resume', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-screening-reuse-'));
    directories.push(directory);
    const assistant = new HhBrowserAssistant(directory, () => undefined);
    const mutable = assistant as unknown as {
      state: HhAssistantState;
      applyInFlight: boolean;
    };
    mutable.state.config = { ...mutable.state.config, autoRunDaily: false };
    const reusedPending = pending('2');
    reusedPending.autoRetryBlockedUntil = 'manual';
    mutable.state.queue = [pending('1'), reusedPending];
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
    expect(reused?.status).toBe('needs_input');
    expect(reused?.pendingQuestions?.[0]?.prompt).toBe('В какой локации вы проживаете?');
    expect(reused?.screeningAnswers).toBeUndefined();
    expect(reused?.autoRetryBlockedUntil).toBe('manual');
    expect(state.screeningFacts).toHaveLength(1);
    expect(new HhBrowserAssistant(directory, () => undefined).getState()
      .queue.find((item) => item.key === 'hh:2')?.screeningAnswers).toBeUndefined();
  });

  it('applies one Russian relocation answer to another city and option wording', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-relocation-reuse-'));
    directories.push(directory);
    const assistant = new HhBrowserAssistant(directory, () => undefined);
    const mutable = assistant as unknown as { state: HhAssistantState; applyInFlight: boolean };
    mutable.state.config = { ...mutable.state.config, autoRunDaily: false, schedule: '' };
    mutable.state.queue = [
      relocationPending('1', 'г. Рязань', ['Да, готов переехать', 'Нет, рассматриваю только удалённый формат']),
      relocationPending('2', 'Йошкар-Олу', ['Да, готов(а)', 'Скорее да, хотелось бы узнать условия', 'Нет, только удалённый формат']),
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
      'Нет, только удалённый формат',
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
          options: ['Да, готов(а)', 'Нет, только удалённый формат'],
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
    expect(state.queue[0]?.screeningAnswers).toHaveLength(2);
    expect(state.queue[0]?.screeningAnswers?.map((answer) => answer.question)).toEqual([
      'Готовы ли вы к переезду в Рязань?',
      'Рассматриваете ли вы переезд в Йошкар-Олу?',
    ]);
    expect(state.phase).not.toBe('manual_required');
  });

  it('does not treat the default remote search filter as a confirmed refusal to relocate', () => {
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
      {
        ...relocationPending('1', 'Рязань', ['Да, готов переехать', 'Нет, только удалённый формат']),
        autoRetryBlockedUntil: 'manual',
      },
    ];

    const state = assistant.saveConfig({ schedule: 'remote', autoSend: false });

    expect(state.queue[0]?.status).toBe('needs_input');
    expect(state.queue[0]?.pendingQuestions?.[0]?.id).toBe('relocation-1');
    expect(state.queue[0]?.autoRetryBlockedUntil).toBe('manual');
    expect(state.queue[0]?.screeningAnswers).toBeUndefined();
    expect(state.screeningFacts[0]?.selectedOptions).toEqual([
      'Скорее да, хотелось бы узнать условия',
    ]);
  });

  it('resolves a persisted salary question from the selected resume title', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-salary-resume-title-'));
    directories.push(directory);
    const defaults = new HhBrowserAssistant(directory, () => undefined).getState().config;
    fs.writeFileSync(path.join(directory, 'hh-browser-assistant.json'), JSON.stringify({
      version: 8,
      resumeSelectionConfirmed: true,
      config: {
        ...defaults,
        salaryFrom: null,
        resumeTitles: [
          'Постоянная работа, подработка Qa Fullstack engineer python 240 000 ₽ · Удалённо',
          'Постоянная работа, подработка QA Automation Engineer Python 220 000 ₽ · Удалённо',
        ],
        autoRunDaily: false,
        autoSend: false,
      },
      queue: [{
        ...pending('135603644'),
        selectedResumeTitle: 'Постоянная работа, подработка QA Automation Engineer Python 220 000 ₽ · Удалённо',
        selectedResumeVerified: true,
        autoRetryBlockedUntil: 'manual',
        pendingQuestions: [{
          id: 'salary-expectation',
          prompt: 'Уточните, пожалуйста, Ваши финансовые ожидания',
          kind: 'text',
          options: [],
          required: true,
        }],
      }],
      screeningFacts: [{
        id: 'old-salary-from-another-resume',
        question: 'Уточните, пожалуйста, Ваши финансовые ожидания',
        answer: 'Рассматриваю предложения от 240 000 ₽ в месяц.',
        selectedOptions: [],
        updatedAt: new Date().toISOString(),
      }],
      runHistory: [],
    }, null, 2), 'utf8');

    const restored = new HhBrowserAssistant(directory, () => undefined).getState();
    const item = restored.queue[0];

    expect(item?.status).toBe('prepared');
    expect(item?.pendingQuestions).toBeUndefined();
    expect(item?.autoRetryBlockedUntil).toBeUndefined();
    expect(item?.screeningAnswers?.[0]?.answer).toMatch(/220[\s\u00a0]000 ₽/u);
  });

  it('migrates v7 inferred resume and salary answers back to explicit review', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-v7-resume-provenance-'));
    directories.push(directory);
    const defaults = new HhBrowserAssistant(directory, () => undefined).getState().config;
    fs.writeFileSync(path.join(directory, 'hh-browser-assistant.json'), JSON.stringify({
      version: 7,
      config: {
        ...defaults,
        salaryFrom: 200_000,
        resumeTitles: ['QA Fullstack Engineer Python 240 000 ₽ · Удалённо'],
        autoRunDaily: false,
        autoSend: false,
      },
      queue: [{
        ...pending('135603646'),
        selectedResumeTitle: 'QA Automation Engineer Python 220 000 ₽ · Удалённо',
        pendingQuestions: [{
          id: 'salary-expectation',
          prompt: 'Уточните, пожалуйста, Ваши финансовые ожидания',
          kind: 'text',
          options: [],
          required: true,
        }],
        screeningAnswers: [{
          questionId: 'salary-expectation',
          question: 'Уточните, пожалуйста, Ваши финансовые ожидания',
          answer: 'Рассматриваю предложения от 200 000 ₽ в месяц.',
          selectedOptions: [],
        }],
      }],
      screeningFacts: [],
      runHistory: [],
    }, null, 2), 'utf8');

    const restored = new HhBrowserAssistant(directory, () => undefined).getState();
    const item = restored.queue[0];

    expect(restored.config.resumeTitles).toEqual([]);
    expect(item?.selectedResumeTitle).toBeUndefined();
    expect(item?.selectedResumeVerified).toBeUndefined();
    expect(item?.status).toBe('needs_input');
    expect(item?.pendingQuestions?.[0]?.id).toBe('salary-expectation');
    expect(item?.screeningAnswers).toBeUndefined();
    const migrated = JSON.parse(fs.readFileSync(
      path.join(directory, 'hh-browser-assistant.json'),
      'utf8',
    )) as { version?: number; resumeSelectionConfirmed?: boolean };
    expect(migrated).toMatchObject({ version: 8, resumeSelectionConfirmed: false });
  });

  it('keeps salary pending when only another configured resume has a salary', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-selected-resume-no-salary-'));
    directories.push(directory);
    const defaults = new HhBrowserAssistant(directory, () => undefined).getState().config;
    fs.writeFileSync(path.join(directory, 'hh-browser-assistant.json'), JSON.stringify({
      version: 8,
      resumeSelectionConfirmed: true,
      config: {
        ...defaults,
        salaryFrom: null,
        resumeTitles: ['QA Fullstack Engineer Python 240 000 ₽ на руки · Удалённо'],
        autoRunDaily: false,
        autoSend: false,
      },
      queue: [{
        ...pending('135603644'),
        selectedResumeTitle: 'QA Automation Engineer Python · Удалённо',
        selectedResumeVerified: true,
        autoRetryBlockedUntil: 'manual',
        pendingQuestions: [{
          id: 'salary-expectation',
          prompt: 'Уточните, пожалуйста, Ваши финансовые ожидания',
          kind: 'text',
          options: [],
          required: true,
        }],
      }],
      screeningFacts: [{
        id: 'ambiguous-old-salary',
        question: 'Уточните, пожалуйста, Ваши финансовые ожидания',
        answer: 'Рассматриваю предложения от 240 000 ₽ в месяц.',
        selectedOptions: [],
        updatedAt: new Date().toISOString(),
      }],
      runHistory: [],
    }, null, 2), 'utf8');

    const item = new HhBrowserAssistant(directory, () => undefined).getState().queue[0];

    expect(item?.status).toBe('needs_input');
    expect(item?.pendingQuestions?.[0]?.id).toBe('salary-expectation');
    expect(item?.screeningAnswers).toBeUndefined();
  });

  it('keeps a legacy salary question pending until one of several resumes is selected', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-ambiguous-resume-salary-'));
    directories.push(directory);
    const defaults = new HhBrowserAssistant(directory, () => undefined).getState().config;
    fs.writeFileSync(path.join(directory, 'hh-browser-assistant.json'), JSON.stringify({
      version: 8,
      resumeSelectionConfirmed: true,
      config: {
        ...defaults,
        salaryFrom: null,
        resumeTitles: [
          'QA Fullstack Engineer Python 240 000 ₽ · Удалённо',
          'QA Automation Engineer Python 220 000 ₽ · Удалённо',
        ],
        autoRunDaily: false,
        autoSend: false,
      },
      queue: [{
        ...pending('135603645'),
        selectedResumeTitle: undefined,
        autoRetryBlockedUntil: 'manual',
        pendingQuestions: [{
          id: 'salary-expectation-ambiguous',
          prompt: 'Уточните, пожалуйста, Ваши финансовые ожидания',
          kind: 'text',
          options: [],
          required: true,
        }],
      }],
      screeningFacts: [],
      runHistory: [],
    }, null, 2), 'utf8');

    const item = new HhBrowserAssistant(directory, () => undefined).getState().queue[0];
    expect(item?.status).toBe('needs_input');
    expect(item?.pendingQuestions?.[0]?.id).toBe('salary-expectation-ambiguous');
    expect(item?.screeningAnswers).toBeUndefined();
  });

  it('keeps a current-city question pending until the selected resume body is loaded', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-city-fact-reuse-'));
    directories.push(directory);
    const defaults = new HhBrowserAssistant(directory, () => undefined).getState().config;
    fs.writeFileSync(path.join(directory, 'hh-browser-assistant.json'), JSON.stringify({
      version: 8,
      resumeSelectionConfirmed: true,
      config: { ...defaults, autoRunDaily: false, autoSend: false },
      queue: [{
        ...pending('9002'),
        selectedResumeTitle: 'QA Automation Engineer Python 220 000 ₽ · Удалённо',
        autoRetryBlockedUntil: 'manual',
        pendingQuestions: [{
          id: 'city-current',
          prompt: 'Где вы сейчас живёте?',
          kind: 'text',
          options: [],
          required: true,
        }],
      }],
      screeningFacts: [{
        id: 'confirmed-city',
        question: 'В каком городе проживаешь фактически?',
        answer: 'Казань',
        selectedOptions: [],
        updatedAt: new Date().toISOString(),
      }],
      runHistory: [],
    }, null, 2), 'utf8');

    const item = new HhBrowserAssistant(directory, () => undefined).getState().queue[0];

    expect(item?.status).toBe('needs_input');
    expect(item?.pendingQuestions?.[0]?.prompt).toBe('Где вы сейчас живёте?');
    expect(item?.screeningAnswers).toBeUndefined();
    expect(item?.autoRetryBlockedUntil).toBe('manual');
  });

  it('preserves an existing relocation choice instead of overwriting it from a search filter', () => {
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
    expect(answer?.answer).toBe('');
    expect(answer?.selectedOptions).toEqual(['Пока не уверен(а), готов(а) обсудить']);
  });

  it('removes the legacy synthetic no-relocation answer created from the default search filter', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-relocation-synthetic-'));
    directories.push(directory);
    const synthetic = 'Нет, переезд по России не рассматриваю. Интересует только полностью удалённый формат работы.';
    fs.writeFileSync(path.join(directory, 'hh-browser-assistant.json'), JSON.stringify({
      version: 7,
      config: {
        ...new HhBrowserAssistant(directory, () => undefined).getState().config,
        schedule: 'remote',
        autoRunDaily: false,
        autoSend: false,
      },
      queue: [{
        ...relocationPending('135000001', 'Рязань', ['Да', 'Нет']),
        status: 'prepared',
        pendingQuestions: undefined,
        screeningAnswers: [{
          questionId: 'relocation-135000001',
          question: 'Готовы ли вы к переезду в Рязань?',
          answer: synthetic,
          selectedOptions: [],
        }],
      }],
      screeningFacts: [{
        id: 'legacy-synthetic-fact',
        question: 'Рассматриваете ли вы переезд по России ради работы?',
        answer: synthetic,
        selectedOptions: [],
        updatedAt: new Date().toISOString(),
      }],
      runHistory: [],
    }, null, 2), 'utf8');

    const restored = new HhBrowserAssistant(directory, () => undefined).getState();

    expect(restored.screeningFacts).toEqual([]);
    expect(restored.queue[0]?.screeningAnswers).toBeUndefined();
  });

  it('does not reuse a city-specific relocation fact for a different city', async () => {
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

    expect(suggestion.selectedOptions).toEqual([]);
    expect(suggestion.source).toBe('local');
    expect(suggestion.note).toMatch(/проверьте|выберите|подтверд/i);
  });
});
