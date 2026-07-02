import { describe, it, expect } from 'vitest';
import { pluralRu } from './pluralRu';

describe('pluralRu', () => {
  const topic = (n: number) => pluralRu(n, 'тема', 'темы', 'тем');

  it('picks the singular for 1, 21, 101', () => {
    expect(topic(1)).toBe('тема');
    expect(topic(21)).toBe('тема');
    expect(topic(101)).toBe('тема');
  });

  it('picks the few-form for 2–4, 22–24', () => {
    expect(topic(2)).toBe('темы');
    expect(topic(4)).toBe('темы');
    expect(topic(23)).toBe('темы');
  });

  it('picks the many-form for 0, 5–20, and the 11–14 exception', () => {
    expect(topic(0)).toBe('тем');
    expect(topic(5)).toBe('тем');
    expect(topic(11)).toBe('тем');
    expect(topic(12)).toBe('тем');
    expect(topic(14)).toBe('тем');
    expect(topic(111)).toBe('тем');
  });
});
