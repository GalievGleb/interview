import { describe, expect, it } from 'vitest';
import { requiresScreenContext } from './visualQuestion';

describe('requiresScreenContext', () => {
  it.each([
    'Что выведет этот код?',
    'Посмотри на экран и скажи, где ошибка',
    'Объясни этот фрагмент',
    'Что произойдёт в данном выражении?',
    'What will this code print?',
    'Explain the snippet on the screen',
  ])('routes deictic task to vision: %s', (question) => {
    expect(requiresScreenContext(question)).toBe(true);
  });

  it.each([
    'Что такое генератор?',
    'Напиши функцию с аргументом по умолчанию',
    'Как работает git rebase?',
    'What is a context manager?',
  ])('keeps self-contained question on text route: %s', (question) => {
    expect(requiresScreenContext(question)).toBe(false);
  });
});
