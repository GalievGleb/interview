import { describe, expect, it } from 'vitest';
import {
  buildScreenTaskContinuityContext,
  findLatestUnconsumedScreenCaptureCue,
  isScreenTaskFollowUp,
  isSpokenScreenCaptureCue,
  screenCaptureRequestFromCue,
} from './screenTaskContinuity';

describe('screen task continuity', () => {
  it.each([
    'Сейчас покажу решение.',
    'Покажу своё решение и объясню ход мыслей.',
  ])('recognizes the natural spoken screen cue: %s', (text) => {
    expect(isSpokenScreenCaptureCue(text)).toBe(true);
    expect(screenCaptureRequestFromCue(text)).toContain('текущее задание на экране');
  });

  it('finds a candidate microphone cue even when system audio owns Ctrl+Enter', () => {
    const cue = findLatestUnconsumedScreenCaptureCue(
      [
        { sequence: 11, source: 'system', text: 'Теперь добавь обработку None.' },
        { sequence: 12, source: 'mic', text: 'Сейчас покажу решение.' },
        { sequence: 13, source: 'system', text: 'Хорошо.' },
      ],
      10,
    );
    expect(cue).toMatchObject({ sequence: 12, source: 'mic' });
    expect(findLatestUnconsumedScreenCaptureCue([cue!], 12)).toBeNull();
  });

  it.each([
    'Я применяю Page Object в UI-автотестах.',
    'Покажу на примере из своего опыта, как работал с API.',
    'Как можно улучшить процесс тестирования в команде?',
  ])('does not treat ordinary candidate speech as a screen command: %s', (text) => {
    expect(isSpokenScreenCaptureCue(text)).toBe(false);
  });

  it.each([
    'Не удаляй текущую проверку, а добавь обработку None.',
    'А как это решение можно улучшить?',
    'Теперь поменяй запрос: нужна группировка по городу.',
  ])('recognizes an explicit previous-task modification: %s', (text) => {
    expect(isScreenTaskFollowUp(text)).toBe(true);
  });

  it('passes bounded prior task and answer only to an explicit continuation', () => {
    const previous = {
      question: `Напиши SQL-запрос ${'Q'.repeat(900)}`,
      answer: `SELECT * FROM users; ${'A'.repeat(5000)}`,
    };

    expect(buildScreenTaskContinuityContext('Что такое JOIN?', previous)).toBe('');

    const context = buildScreenTaskContinuityContext(
      'Теперь улучши предыдущее решение и не удаляй фильтр.',
      previous,
    );
    expect(context).toContain('ПРЕДЫДУЩЕЕ ЗАДАНИЕ С ЭКРАНА');
    expect(context).toContain('ПРЕДЫДУЩИЙ ОТВЕТ SKILLCUE');
    expect(context.length).toBeLessThanOrEqual(3900);
  });

  it('keeps the beginning of fenced prior code while retaining the newest correction', () => {
    const context = buildScreenTaskContinuityContext(
      'Теперь измени предыдущее решение: добавь группировку по городу.',
      {
        question: 'Напиши SQL-запрос',
        answer: `Старое пояснение ${'x'.repeat(3_000)}\n\`\`\`sql\nSELECT city, count(*)\n${'y'.repeat(3_000)}\n\`\`\`\nНовейшее исправление: не удаляй фильтр active = true.`,
      },
    );

    expect(context).toContain('```sql\nSELECT city, count(*)');
    expect(context).toContain('Новейшее исправление: не удаляй фильтр active = true.');
  });

  it('never exceeds its declared limit when a prior solution has no fenced code', () => {
    const context = buildScreenTaskContinuityContext(
      'Теперь измени предыдущее решение.',
      { question: 'Q', answer: `${'старый текст '.repeat(400)}НОВЕЙШАЯ_ПРАВКА` },
    );

    const answer = context.split('ПРЕДЫДУЩИЙ ОТВЕТ SKILLCUE:\n')[1]
      .split('\nТекущий скриншот')[0];
    expect(answer.length).toBeLessThanOrEqual(2_800);
    expect(answer).toContain('НОВЕЙШАЯ_ПРАВКА');
  });
});
