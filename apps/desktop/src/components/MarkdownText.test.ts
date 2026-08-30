import { describe, expect, it } from 'vitest';

import { formatCodeForCompactDisplay } from './MarkdownText';

describe('formatCodeForCompactDisplay', () => {
  it('moves Russian SQL explanations below the code line', () => {
    expect(formatCodeForCompactDisplay(
      'sql',
      "SELECT SUM(price * items) AS income -- Считаем доход\nFROM Purchases -- Берём покупки",
    )).toBe(
      "SELECT SUM(price * items) AS income\n-- Считаем доход\nFROM Purchases\n-- Берём покупки",
    );
  });

  it('keeps indentation and ignores comment markers inside Python strings', () => {
    expect(formatCodeForCompactDisplay(
      'python',
      'def render():  # Объявляем функцию\n    value = "текст # не комментарий"  # Храним строку',
    )).toBe(
      'def render():\n# Объявляем функцию\n    value = "текст # не комментарий"\n    # Храним строку',
    );
  });

  it('does not duplicate comments that are already on their own line', () => {
    expect(formatCodeForCompactDisplay(
      'javascript',
      'const url = "https://skill-cue.ru";\n// Оставляем адрес приложения',
    )).toBe(
      'const url = "https://skill-cue.ru";\n// Оставляем адрес приложения',
    );
  });
});
