/**
 * Run: npx tsx packages/shared/src/sanitizeLiveAnswer.test.ts
 */
import { sanitizeLiveAnswer } from './sanitizeLiveAnswer';

const CASES: Array<{ input: string; expected: string }> = [
  {
    input:
      'Похоже, вопрос про то, как я разбирался с проблемами в автоматизации. ' +
      'В своей практике я сначала анализировал логи...',
    expected: 'В своей практике я сначала анализировал логи...',
  },
  {
    input:
      'Похоже, вопрос про разницу между PUT и PATCH. PUT и PATCH оба используются для обновления ресурса...',
    expected: 'PUT и PATCH оба используются для обновления ресурса...',
  },
  {
    input:
      'Похоже, вопрос про Linux-команды. Linux-команды можно разделить на несколько групп...',
    expected: 'Linux-команды можно разделить на несколько групп...',
  },
  {
    input: 'Вероятно, вопрос о Jenkins. Jenkins — это инструмент CI/CD...',
    expected: 'Jenkins — это инструмент CI/CD...',
  },
  {
    input: 'Судя по всему, речь про API-тесты. Я обычно проверял status code...',
    expected: 'Я обычно проверял status code...',
  },
  {
    input: 'PUT и PATCH оба используются для обновления ресурса.',
    expected: 'PUT и PATCH оба используются для обновления ресурса.',
  },
];

let failed = 0;
for (const { input, expected } of CASES) {
  const got = sanitizeLiveAnswer(input);
  if (got !== expected) {
    failed += 1;
    console.error(`FAIL:\n  in:  ${input}\n  exp: ${expected}\n  got: ${got}`);
  } else {
    console.log(`OK: ${expected.slice(0, 50)}...`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log(`\nAll ${CASES.length} passed`);
