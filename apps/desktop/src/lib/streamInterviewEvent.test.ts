import { describe, expect, it } from 'vitest';
import { parseInterviewStreamEvent } from './streamInterviewEvent';

describe('parseInterviewStreamEvent', () => {
  it('keeps the resolved model and model source from the terminal SSE event', () => {
    const event = parseInterviewStreamEvent(JSON.stringify({
      type: 'done',
      id: 'answer-1',
      spoken: 'Smoke testing — быстрая проверка основных функций.',
      model: 'openai/gpt-4.1-mini',
      model_source: 'live_fast',
      correction: { question_intent: 'technical_definition' },
    }));

    expect(event).toEqual({
      type: 'done',
      id: 'answer-1',
      spoken: 'Smoke testing — быстрая проверка основных функций.',
      model: 'openai/gpt-4.1-mini',
      modelSource: 'live_fast',
      correction: { question_intent: 'technical_definition' },
    });
  });

  it('rejects malformed or unsupported events instead of throwing', () => {
    expect(parseInterviewStreamEvent('{broken')).toBeNull();
    expect(parseInterviewStreamEvent(JSON.stringify({ type: 'mystery' }))).toBeNull();
  });

  it('turns a terminal provider stream failure into a visible request error', () => {
    const event = parseInterviewStreamEvent(JSON.stringify({
      type: 'stream_failed',
      reason: 'provider_error',
      message: 'Модели временно недоступны. Повторите вопрос.',
    }));

    expect(event).toEqual({
      type: 'error',
      message: 'Модели временно недоступны. Повторите вопрос.',
    });
  });
});
