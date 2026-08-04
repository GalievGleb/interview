import { describe, expect, it } from 'vitest';
import { deriveLiveExchange } from './liveOverlaySync';

describe('deriveLiveExchange', () => {
  it('shows the streaming text while it arrives', () => {
    expect(deriveLiveExchange('Кроме кода я…', true, 'старый ответ')).toEqual({
      show: true,
      text: 'Кроме кода я…',
    });
  });

  it('shows empty (loader), NOT the previous answer, during the pre-first-token gap', () => {
    // Регресс: streamText сброшен, ответ ещё генерируется, прошлый ответ есть.
    // Нельзя показывать A1 в паре с новым вопросом — только лоадер.
    expect(deriveLiveExchange('', true, 'ответ на прошлый вопрос')).toEqual({
      show: true,
      text: '',
    });
  });

  it('shows the loader immediately while Ctrl+Enter is finalizing the transcript', () => {
    expect(deriveLiveExchange('', false, undefined, 'finalizing-transcript')).toEqual({
      show: true,
      text: '',
    });
  });

  it('shows the loader while the forced answer is waiting for its first token', () => {
    expect(deriveLiveExchange('', false, 'previous answer', 'waiting-first-token')).toEqual({
      show: true,
      text: '',
    });
  });

  it('restores the latest answer once the forced generation is done', () => {
    expect(deriveLiveExchange('', false, 'latest answer', 'done')).toEqual({
      show: true,
      text: 'latest answer',
    });
  });

  it('shows a forced-answer error instead of the previous successful answer', () => {
    expect(
      deriveLiveExchange('', false, 'старый успешный ответ', 'error', 'Ответ не пришёл вовремя'),
    ).toEqual({
      show: true,
      text: '⚠ Ответ не пришёл вовремя',
    });
  });

  it('persists the last answer when idle (not generating)', () => {
    expect(deriveLiveExchange('', false, 'последний ответ')).toEqual({
      show: true,
      text: 'последний ответ',
    });
  });

  it('shows nothing on a fresh session (no stream, no history, not generating)', () => {
    expect(deriveLiveExchange('', false, undefined)).toEqual({ show: false, text: '' });
  });

  it('keeps showing streamed text after done (streamText retained, streaming false)', () => {
    expect(deriveLiveExchange('готовый ответ', false, 'готовый ответ')).toEqual({
      show: true,
      text: 'готовый ответ',
    });
  });
});
