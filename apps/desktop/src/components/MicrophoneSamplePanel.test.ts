import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MicrophoneSampleState } from '../lib/microphoneSample';

vi.mock('../lib/i18n', () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        'mic.sample.title': 'Проверка голоса',
        'mic.sample.idle': 'Запишите короткую фразу и послушайте результат.',
        'mic.sample.recording': 'Идёт запись',
        'mic.sample.ready': 'Запись готова',
        'mic.sample.start': 'Записать голос',
        'mic.sample.stop': 'Стоп',
        'mic.sample.play': 'Прослушать',
        'mic.sample.pause': 'Пауза',
        'mic.sample.retry': 'Перезаписать',
        'mic.sample.level': 'Уровень микрофона',
      })[key] ?? key,
  }),
}));

import MicrophoneSamplePanel from './MicrophoneSamplePanel';

const noop = () => undefined;

function render(state: MicrophoneSampleState): string {
  return renderToStaticMarkup(
    React.createElement(MicrophoneSamplePanel, {
      state,
      onStart: noop,
      onStop: noop,
      onPlayPause: noop,
      onReset: noop,
    }),
  );
}

describe('MicrophoneSamplePanel', () => {
  it('offers one clear recording action before a sample exists', () => {
    const html = render({ status: 'idle', elapsedMs: 0, durationMs: 0, level: 0, error: '' });

    expect(html).toContain('Проверка голоса');
    expect(html).toContain('Записать голос');
    expect(html).not.toContain('Прослушать');
  });

  it('shows elapsed time and live input level while recording', () => {
    const html = render({
      status: 'recording',
      elapsedMs: 4_240,
      durationMs: 0,
      level: 63,
      error: '',
    });

    expect(html).toContain('Идёт запись · 0:04');
    expect(html).toContain('Стоп');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="63"');
  });

  it('offers playback and re-recording after capture', () => {
    const ready = render({
      status: 'ready',
      elapsedMs: 4_240,
      durationMs: 4_240,
      level: 0,
      error: '',
    });
    const playing = render({
      status: 'playing',
      elapsedMs: 4_240,
      durationMs: 4_240,
      level: 0,
      error: '',
    });

    expect(ready).toContain('Запись готова · 0:04');
    expect(ready).toContain('Прослушать');
    expect(ready).toContain('Перезаписать');
    expect(playing).toContain('Пауза');
  });
});
