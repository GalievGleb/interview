/**
 * Manual test cases for glossary correction.
 * Run: npx tsx packages/shared/src/correctTranscriptWithGlossary.test.ts
 */
import { normalizeTranscript } from '../../../apps/desktop/src/lib/normalizeTranscript';
import { correctTranscriptWithGlossary } from './correctTranscriptWithGlossary';

interface Case {
  input: string;
  expected: string;
}

const CASES: Case[] = [
  { input: 'Что такое алло report?', expected: 'Что такое Allure Report?' },
  { input: 'Что такое сейчас сиди?', expected: 'Что такое CI/CD?' },
  { input: 'Что такое Pytest-fit Stura?', expected: 'Что такое pytest fixtures?' },
  { input: 'Что такое five job at model?', expected: 'Что такое Page Object Model?' },
  { input: 'Как ты проверял капитал?', expected: 'Как ты проверял Kafka?' },
  {
    input: 'Чем смог отличается от pregration?',
    expected: 'Чем smoke testing отличается от regression testing?',
  },
];

function pipeline(raw: string): string {
  const normalized = normalizeTranscript(raw);
  return correctTranscriptWithGlossary(normalized, { interviewMode: true, isShort: true }).corrected;
}

let failed = 0;
for (const { input, expected } of CASES) {
  const got = pipeline(input);
  const ok = got === expected;
  if (!ok) {
    failed += 1;
    console.error(`FAIL: ${input}\n  expected: ${expected}\n  got:      ${got}`);
  } else {
    console.log(`OK: ${input}`);
  }
}

if (failed > 0) {
  process.exit(1);
}

console.log(`All ${CASES.length} cases passed.`);
