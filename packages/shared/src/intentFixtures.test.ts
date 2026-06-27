/**
 * Cross-language drift guard for question-intent classification. The SAME
 * fixtures (packages/shared/fixtures/intent-cases.json) are asserted here and in
 * apps/api-py/tests/test_intent_fixtures.py — if the TS and Python classifiers
 * diverge, one of the two suites fails.
 *
 * Run: npx tsx packages/shared/src/intentFixtures.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyInterviewQuestionIntent } from './classifyInterviewQuestionIntent';

interface Case {
  question: string;
  intent: string;
}

const fixturesPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'intent-cases.json',
);
const cases: Case[] = JSON.parse(readFileSync(fixturesPath, 'utf-8'));

let failed = 0;
for (const c of cases) {
  const got = classifyInterviewQuestionIntent({ question: c.question }).questionIntent;
  if (got !== c.intent) {
    failed += 1;
    console.error(`FAIL: "${c.question}" expected ${c.intent}, got ${got}`);
  } else {
    console.log(`OK: ${c.intent} <- ${c.question}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length} intent fixtures failed`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} intent fixtures passed`);
