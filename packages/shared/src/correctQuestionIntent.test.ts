/**
 * Manual tests: glossary + question intent pipeline.
 * Run: npx tsx packages/shared/src/correctQuestionIntent.test.ts
 */
import { normalizeTranscript } from '../../../apps/desktop/src/lib/normalizeTranscript';
import { correctTranscriptWithGlossary } from './correctTranscriptWithGlossary';
import { correctQuestionIntent } from './correctQuestionIntent';

interface IntentCase {
  input: string;
  expectedGlossary?: string;
  expectedIntent: string;
  expectedConfidence?: string;
}

const CASES: IntentCase[] = [
  {
    input: 'Чем смог отличается integration?',
    expectedGlossary: 'Чем smoke testing отличается integration?',
    expectedIntent: 'Чем smoke testing отличается от regression testing?',
    expectedConfidence: 'medium',
  },
  {
    input: 'Что такое растапья?',
    expectedIntent: 'Что такое REST API?',
  },
  {
    input: 'Что такое Python с текстуром?',
    expectedIntent: 'Что такое pytest fixtures?',
  },
  {
    input: 'Что-то полинулось.',
    expectedIntent: 'Что такое Linux?',
  },
  {
    input: 'Что-то, как ты запускала, плей-прайд.',
    expectedIntent: 'Как ты запускал Playwright?',
  },
  {
    input: 'Каждый настраивал pipeline.',
    expectedIntent: 'Как ты настраивал pipeline?',
  },
];

function pipeline(input: string) {
  const normalized = normalizeTranscript(input);
  const glossary = correctTranscriptWithGlossary(normalized, { interviewMode: true, isShort: true });
  const intent = correctQuestionIntent({
    raw: normalized,
    corrected: glossary.corrected,
    corrections: glossary.corrections,
  });
  return { glossary, intent };
}

let failed = 0;
for (const { input, expectedGlossary, expectedIntent, expectedConfidence } of CASES) {
  const { glossary, intent } = pipeline(input);
  let ok = intent.intentCorrected === expectedIntent;
  if (expectedGlossary && glossary.corrected !== expectedGlossary) ok = false;
  if (expectedConfidence && intent.confidence !== expectedConfidence) ok = false;

  if (!ok) {
    failed += 1;
    console.error(`FAIL: ${input}`);
    if (expectedGlossary) console.error(`  glossary expected: ${expectedGlossary}`);
    console.error(`  glossary got:      ${glossary.corrected}`);
    console.error(`  intent expected:   ${expectedIntent}`);
    console.error(`  intent got:        ${intent.intentCorrected}`);
    if (expectedConfidence) {
      console.error(`  confidence expected: ${expectedConfidence}, got: ${intent.confidence}`);
    }
  } else {
    console.log(`OK: ${input}`);
  }
}

if (failed > 0) process.exit(1);
console.log(`All ${CASES.length} intent cases passed.`);
