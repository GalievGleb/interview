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

  it('still provides an editable local hypothesis when the model is unavailable', async () => {
    const assistant = createAssistant(async () => {
      throw new Error('Месячный лимит токенов исчерпан');
    });

    const result = await assistant.suggestScreeningAnswer('135082692', 'rts-games');

    expect(result.source).toBe('local');
    expect(result.answer).toContain('Age of Empires II');
    expect(result.note).toContain('Онлайн-генератор сейчас недоступен');
  });

  it('never replaces an existing user answer with a generic fallback when AI quota is exhausted', async () => {
    const assistant = createAssistant(async () => {
      throw new Error('Месячный лимит токенов исчерпан');
    });

    await expect(assistant.suggestScreeningAnswer(
      '135082692',
      'rts-games',
      'Да, немного знаком с жанром RTS.',
    )).rejects.toThrow('Ваш ответ сохранён без изменений');
  });

  it('turns a quota failure into a conditional relocation draft', async () => {
    const assistant = createAssistant(async () => {
      throw new Error('Месячный лимит токенов тарифа исчерпан');
    }, pendingRelocationVacancy());

    const result = await assistant.suggestScreeningAnswer('135790743', 'relocation');

    expect(result.source).toBe('local');
    expect(result.answer).toContain('Саудовскую Аравию');
    expect(result.answer).toContain('если работодатель оплачивает');
    expect(result.note).not.toContain('Месячный лимит токенов');
  });
});
