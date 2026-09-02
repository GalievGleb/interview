import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import MarkdownText, {
  closeUnmatchedFinalFence,
  formatCodeForCompactDisplay,
  formatLiveMarkdown,
} from './MarkdownText';

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

describe('streaming fenced code', () => {
  it('renders an unfinished final fence as a contained code block immediately', () => {
    const html = renderToStaticMarkup(React.createElement(MarkdownText, {
      text: 'Решение:\n\n```sql\nSELECT very_long_column_name FROM users',
    }));

    expect(html).toContain('<pre');
    expect(html).toContain('<code');
    expect(html).toContain('SELECT very_long_column_name FROM users');
    expect(html).toContain('overflow-x-hidden');
    expect(html).toContain('overflow-wrap:anywhere');
  });

  it('closes only an unmatched final fence and stays idempotent after the real close arrives', () => {
    const partial = '```python\nprint("ok")';
    const repaired = closeUnmatchedFinalFence(partial);

    expect(repaired).toBe('```python\nprint("ok")\n```');
    expect(closeUnmatchedFinalFence(repaired)).toBe(repaired);
    expect(formatLiveMarkdown(`${partial}\n\`\`\``)).toBe(`${partial}\n\`\`\``);
  });

  it('keeps a long unbroken code token wrapped inside the fixed width', () => {
    const html = renderToStaticMarkup(React.createElement(MarkdownText, {
      text: `\`\`\`python\n${'x'.repeat(600)}\n\`\`\``,
    }));

    expect(html).toContain('max-w-full');
    expect(html).toContain('whitespace-pre-wrap');
    expect(html).toContain('break-words');
    expect(html).not.toContain('overflow-x-auto');
  });
});
