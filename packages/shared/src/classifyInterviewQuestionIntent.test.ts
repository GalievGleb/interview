/**
 * Run: npx tsx packages/shared/src/classifyInterviewQuestionIntent.test.ts
 */
import { classifyInterviewQuestionIntent } from './classifyInterviewQuestionIntent';

interface Case {
  name: string;
  input: Parameters<typeof classifyInterviewQuestionIntent>[0];
  expectIntent?: string;
}

const CASES: Case[] = [
  {
    name: 'PUT vs PATCH clear',
    input: { question: 'В чем разница PUT и PATCH?' },
    expectIntent: 'technical_comparison',
  },
  {
    name: 'Jenkins clear',
    input: { question: 'Что такое Jenkins?' },
    expectIntent: 'technical_definition',
  },
  {
    name: 'Linux commands clear',
    input: { question: 'Какие бывают Linux команды?' },
    expectIntent: 'technical_list',
  },
  {
    name: 'Linux ASR corrected high confidence',
    input: {
      question: 'Какие бывают Linux команды?',
      rawQuestion: 'Какие бывают линици команды?',
      glossaryCorrected: 'Какие бывают Linux команды?',
      correctionMaxConfidence: 'high',
    },
    expectIntent: 'technical_list',
  },
];

let failed = 0;
for (const c of CASES) {
  const result = classifyInterviewQuestionIntent(c.input);
  const ok =
    result.suggestUnclearPrefix === false &&
    (c.expectIntent == null || result.questionIntent === c.expectIntent);
  if (!ok) {
    failed += 1;
    console.error(
      `FAIL: ${c.name}\n  expected prefix=false intent=${c.expectIntent ?? 'any'}\n` +
        `  got prefix=${result.suggestUnclearPrefix} intent=${result.questionIntent}`,
    );
  } else {
    console.log(`OK: ${c.name} → intent=${result.questionIntent}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log(`\nAll ${CASES.length} passed`);
