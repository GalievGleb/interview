import { describe, it, expect } from 'vitest';
import { findForbiddenPhrases, matchKeywords, normalizeText } from './voice-test-keywords';

describe('voice-test-keywords', () => {
  it('matches API answer keywords via aliases', () => {
    const answer =
      'Проверял status code, заголовки, схемам данных, валидации, auth по токену, JSON и время отклика.';
    const keywords = [
      { key: 'status code', aliases: ['status code', 'статус код', 'статус-код'] },
      { key: 'schema', aliases: ['schema', 'схема', 'схемам', 'схемы данных'] },
      { key: 'headers', aliases: ['headers', 'заголовки', 'header'] },
      { key: 'negative', aliases: ['negative', 'негативные', 'негативных'] },
      { key: 'JSON', aliases: ['json', 'джейсон'] },
      { key: 'validation', aliases: ['validation', 'валидация', 'валидации'] },
    ];
    const { found } = matchKeywords(answer, keywords);
    expect(found.length).toBeGreaterThanOrEqual(5);
    const headers = found.find((item) => item.key === 'headers');
    expect(headers?.matchedAlias).toBe('заголовки');
  });

  it('matches flaky transcript keywords', () => {
    const transcript = 'Что вы делали с нестабильными автотестами в CICD-пайплайне?';
    const keywords = [
      { key: 'нестабильные', aliases: ['нестабильные', 'нестабильными', 'нестабильно'] },
      { key: 'автотесты', aliases: ['автотесты', 'автотестами', 'тесты'] },
      { key: 'CI/CD', aliases: ['ci/cd', 'cicd', 'pipeline', 'пайплайн', 'пайплайне'] },
      { key: 'flaky', aliases: ['flaky', 'флейки', 'флейковые', 'нестабильные'] },
      { key: 'tests', aliases: ['tests', 'тесты', 'автотесты'] },
    ];
    const { found } = matchKeywords(transcript, keywords);
    expect(found.length).toBe(5);
  });

  it('matches Russian stems (логика → логики)', () => {
    const answer = 'Частая ошибка — перенос бизнес-логики в Page Object.';
    const keywords = [{ key: 'логика', aliases: ['логика', 'логики', 'бизнес логика'] }];
    const { found } = matchKeywords(answer, keywords);
    expect(found.length).toBe(1);
    expect(['логика', 'логики', 'бизнес логика']).toContain(found[0]?.matchedAlias ?? '');
  });

  it('normalizes CI/CD variants', () => {
    expect(normalizeText('CI/CD pipeline')).toBe('cicd pipeline');
    expect(normalizeText('CICD-пайплайне')).toContain('cicd');
  });

  it('respects negation for forbidden phrases', () => {
    const good = findForbiddenPhrases('Я проверяю не только статус-код 200, но и body и schema.', [
      'только статус код',
      'проверяю только статус код',
    ]);
    expect(good.length).toBe(0);

    const bad = findForbiddenPhrases('Я проверяю только статус код и больше ничего.', [
      'проверяю только статус код',
    ]);
    expect(bad.length).toBe(1);
  });
});
