import { describe, it, expect } from 'vitest';
import {
  sanitizeLiveAnswer,
  trimSpokenAnswer,
  scoreSpokenAnswer,
} from '@interview/shared';

describe('sanitizeLiveAnswer — strips ChatGPT artifacts', () => {
  it('removes internal labels but keeps the content', () => {
    const out = sanitizeLiveAnswer('Main answer: POM — это паттерн. Key points: scope и conftest.');
    expect(out).not.toMatch(/main answer/i);
    expect(out).not.toMatch(/key points/i);
    expect(out).toContain('POM');
    expect(out).toContain('conftest');
  });

  it('drops markdown headers, keeps heading text', () => {
    const out = sanitizeLiveAnswer('## Виды тестирования\nФункциональное и нефункциональное.');
    expect(out).not.toContain('#');
    expect(out).toContain('Виды тестирования');
  });

  it('removes the «Если хотите, могу подробнее…» tail', () => {
    const out = sanitizeLiveAnswer('POM разделяет логику. Если хотите, могу подробнее рассказать.');
    expect(out).toContain('POM разделяет логику');
    expect(out.toLowerCase()).not.toContain('если хотите');
  });

  it('strips the «Важно отметить» filler opener, keeps the body', () => {
    const out = sanitizeLiveAnswer('Важно отметить, что scope бывает function и session.');
    expect(out).toContain('scope бывает function и session');
    expect(out.toLowerCase()).not.toContain('важно отметить');
  });

  it('removes an empty filler sentence', () => {
    const out = sanitizeLiveAnswer(
      'Я проверял status code и schema. В разных контекстах могут быть разные подходы.',
    );
    expect(out).toContain('status code');
    expect(out.toLowerCase()).not.toContain('разные подходы');
  });

  it('leaves a clean technical answer untouched', () => {
    const text = 'CI/CD я настраивал в GitLab: stages, Docker, запуск pytest, Allure и артефакты.';
    expect(sanitizeLiveAnswer(text)).toBe(text);
  });
});

describe('trimSpokenAnswer — Say-aloud length cap', () => {
  it('caps a long answer at the word limit on a sentence boundary', () => {
    const long = `${Array.from({ length: 120 }, (_, i) => `слово${i}`).join(' ')}. Хвост.`;
    const trimmed = trimSpokenAnswer(long, 90);
    expect(trimmed.split(/\s+/).length).toBeLessThanOrEqual(90);
  });

  it('keeps a short answer as-is', () => {
    const text = 'Page Object Model — это паттерн для UI-автотестов.';
    expect(trimSpokenAnswer(text, 90)).toBe(text);
  });
});

describe('scoreSpokenAnswer — regression scoring', () => {
  it('passes a clean, direct, in-length answer', () => {
    const good =
      'CI/CD я настраивал в GitLab: отдельные stages для smoke и regression, ' +
      'Docker для одинакового окружения, запуск pytest, Allure-отчёты и сохранение артефактов — логов, скриншотов и diff.';
    const q = scoreSpokenAnswer(good, { maxWords: 90 });
    expect(q.ok).toBe(true);
    expect(q.forbiddenPhrases).toHaveLength(0);
    expect(q.internalLabels).toHaveLength(0);
  });

  it('flags forbidden ChatGPT tails', () => {
    const q = scoreSpokenAnswer('POM — это паттерн. Если хотите, могу подробнее рассказать.');
    expect(q.forbiddenPhrases.length).toBeGreaterThan(0);
    expect(q.ok).toBe(false);
  });

  it('flags leaked internal labels', () => {
    const q = scoreSpokenAnswer('Main answer: POM — это паттерн.');
    expect(q.internalLabels.length).toBeGreaterThan(0);
    expect(q.ok).toBe(false);
  });

  it('flags a non-direct filler opening', () => {
    const q = scoreSpokenAnswer('Похоже, вопрос про POM. POM — это паттерн.');
    expect(q.startsWithFiller).toBe(true);
    expect(q.ok).toBe(false);
  });

  it('flags an over-length answer', () => {
    const long = Array.from({ length: 130 }, (_, i) => `слово${i}`).join(' ');
    const q = scoreSpokenAnswer(long, { maxWords: 90 });
    expect(q.withinWordLimit).toBe(false);
    expect(q.ok).toBe(false);
  });

  it('a sanitized answer scores clean', () => {
    const raw = '## Key points\nPOM разделяет логику и локаторы. Если хотите, могу подробнее рассказать.';
    const q = scoreSpokenAnswer(trimSpokenAnswer(sanitizeLiveAnswer(raw)));
    expect(q.ok).toBe(true);
  });
});
