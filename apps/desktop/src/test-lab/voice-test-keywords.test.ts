import { findForbiddenPhrases, matchKeywords, normalizeText } from './voice-test-keywords';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function testApiAnswerKeywords(): void {
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
  const { found, missing } = matchKeywords(answer, keywords);
  assert(found.length >= 5, `API answer should match required keywords, got ${found.length}, missing ${missing}`);
  const headers = found.find((item) => item.key === 'headers');
  assert(headers?.matchedAlias === 'заголовки', 'headers should match заголовки alias');
}

function testFlakyTranscript(): void {
  const transcript = 'Что вы делали с нестабильными автотестами в CICD-пайплайне?';
  const keywords = [
    { key: 'нестабильные', aliases: ['нестабильные', 'нестабильными', 'нестабильно'] },
    { key: 'автотесты', aliases: ['автотесты', 'автотестами', 'тесты'] },
    { key: 'CI/CD', aliases: ['ci/cd', 'cicd', 'pipeline', 'пайплайн', 'пайплайне'] },
    { key: 'flaky', aliases: ['flaky', 'флейки', 'флейковые', 'нестабильные'] },
    { key: 'tests', aliases: ['tests', 'тесты', 'автотесты'] },
  ];
  const { found, missing } = matchKeywords(transcript, keywords);
  assert(found.length === 5, `Flaky transcript should match all keywords, missing ${missing.join(', ')}`);
}

function testPomLogicStem(): void {
  const answer = 'Частая ошибка — перенос бизнес-логики в Page Object.';
  const keywords = [{ key: 'логика', aliases: ['логика', 'логики', 'бизнес логика'] }];
  const { found } = matchKeywords(answer, keywords);
  assert(found.length === 1, 'логика should match логики stem');
  assert(['логика', 'логики', 'бизнес логика'].includes(found[0]?.matchedAlias ?? ''), 'logic alias');
}

function testNormalizeCicd(): void {
  assert(normalizeText('CI/CD pipeline') === 'cicd pipeline', 'ci/cd normalize');
  assert(normalizeText('CICD-пайплайне').includes('cicd'), 'cicd hyphen normalize');
}

function testForbiddenNegation(): void {
  const good = findForbiddenPhrases('Я проверяю не только статус-код 200, но и body и schema.', [
    'только статус код',
    'проверяю только статус код',
  ]);
  assert(good.length === 0, `good answer should not match forbidden: ${good.join(', ')}`);

  const bad = findForbiddenPhrases('Я проверяю только статус код и больше ничего.', [
    'проверяю только статус код',
  ]);
  assert(bad.length === 1, 'bad answer should match forbidden phrase');
}

testApiAnswerKeywords();
testFlakyTranscript();
testPomLogicStem();
testNormalizeCicd();
testForbiddenNegation();
console.log('voice-test-keywords.test.ts: ok');
