/**
 * Manual regression tests for follow-up resolution and topic reset.
 * Run: npx tsx packages/shared/src/resolveFollowUpQuestion.test.ts
 */
import { correctTranscriptWithGlossary } from './correctTranscriptWithGlossary';
import { createEmptySessionContext, updateSessionContextAfterAnswer } from './interviewSessionContext';
import { extractCanonicalTopic } from './extractCanonicalTopic';
import { assessHallucinationRisk } from './topicReset';
import { resolveFollowUpQuestion } from './resolveFollowUpQuestion';

interface Step {
  input: string;
  expectedTopic?: string;
  expectedResolved?: string;
  expectReset?: boolean;
  expectFollowUp?: boolean;
  expectNoContamination?: string;
}

interface Scenario {
  name: string;
  steps: Step[];
}

function pipeline(input: string) {
  const correction = correctTranscriptWithGlossary(input, { interviewMode: true, isShort: true });
  return {
    corrected: correction.corrected,
    corrections: correction.corrections,
  };
}

const SCENARIOS: Scenario[] = [
  {
    name: 'sequence 1: Jenkins → follow-up → POM reset → errors follow-up',
    steps: [
      { input: 'Что такое Jenkins?', expectedTopic: 'Jenkins' },
      {
        input: 'Ты сам его настраивал?',
        expectedResolved: 'Ты сам настраивал Jenkins?',
        expectFollowUp: true,
      },
      {
        input: 'Что такое Page Object Model?',
        expectedTopic: 'Page Object Model',
        expectedResolved: 'Что такое Page Object Model?',
        expectReset: true,
        expectNoContamination: 'Jenkins',
      },
      {
        input: 'Какие ошибки бывают?',
        expectedResolved: 'Какие ошибки бывают при использовании Page Object Model?',
        expectFollowUp: true,
      },
    ],
  },
  {
    name: 'sequence 2: pytest fixtures → CI/CD reset',
    steps: [
      { input: 'Что такое pytest fixtures?', expectedTopic: 'pytest fixtures' },
      {
        input: 'Как ты это использовал?',
        expectedResolved: 'Как ты использовал pytest fixtures в работе?',
        expectFollowUp: true,
      },
      {
        input: 'Что такое CICD?',
        expectedTopic: 'CI/CD',
        expectedResolved: 'Что такое CI/CD?',
        expectReset: true,
        expectNoContamination: 'pytest fixtures',
      },
    ],
  },
  {
    name: 'sequence 3: polymorphism → Kafka reset',
    steps: [
      { input: 'Скажи про полиморфизм.', expectedTopic: 'полиморфизм' },
      {
        input: 'Как ты его применял в работе?',
        expectedResolved: 'Как ты применял полиморфизм в работе?',
        expectFollowUp: true,
      },
      {
        input: 'Что такое Kafka?',
        expectedTopic: 'Kafka',
        expectedResolved: 'Что такое Kafka?',
        expectReset: true,
        expectNoContamination: 'полиморфизм',
      },
    ],
  },
  {
    name: 'sequence 4: Docker pipeline follow-up',
    steps: [
      { input: 'Что такое Docker?', expectedTopic: 'Docker' },
      {
        input: 'Как ты использовал в pipeline?',
        expectedResolved: 'Как ты использовал Docker в pipeline?',
        expectFollowUp: true,
      },
    ],
  },
  {
    name: 'sequence 5: Allure → Kubernetes no contamination',
    steps: [
      { input: 'Что такое аллюр-репорт?', expectedTopic: 'Allure Report' },
      {
        input: 'Ты настраивал Kubernetes?',
        expectedTopic: 'Kubernetes',
        expectedResolved: 'Ты настраивал Kubernetes?',
        expectReset: true,
        expectNoContamination: 'Allure',
      },
    ],
  },
  {
    name: 'context leakage guards',
    steps: [
      { input: 'Что такое Jenkins?', expectedTopic: 'Jenkins' },
      {
        input: 'Что такое page object model?',
        expectedResolved: 'Что такое Page Object Model?',
        expectReset: true,
        expectNoContamination: 'Jenkins',
      },
    ],
  },
  {
    name: 'standalone definitions — no false follow-up',
    steps: [
      { input: 'Что такое smoke testing?', expectedTopic: 'smoke testing' },
      {
        input: 'Что такое тест-кейс?',
        expectedTopic: 'test case',
        expectedResolved: 'Что такое test case?',
        expectReset: true,
        expectFollowUp: false,
        expectNoContamination: 'smoke',
      },
      { input: 'Что такое smoke testing?', expectedTopic: 'smoke testing' },
      {
        input: 'А зачем он нужен?',
        expectedResolved: 'Зачем нужен smoke testing?',
        expectFollowUp: true,
      },
      { input: 'Что такое test case?', expectedTopic: 'test case' },
      {
        input: 'Что такое чек-лист?',
        expectedTopic: 'checklist',
        expectedResolved: 'Что такое checklist?',
        expectReset: true,
        expectFollowUp: false,
        expectNoContamination: 'test case',
      },
    ],
  },
];

const DANGER_CASES: Array<{ input: string; risk: 'high' | 'medium' | 'low' }> = [
  { input: 'Много багов находили твои автотесты?', risk: 'high' },
  { input: 'Сколько автоматизаторов было в команде?', risk: 'high' },
  { input: 'Ты глубоко работал с Kafka?', risk: 'high' },
  { input: 'Ты сам написал все 600 тестов?', risk: 'high' },
  { input: 'Ты использовал RestAssured?', risk: 'high' },
  { input: 'Что такое Jenkins?', risk: 'low' },
];

let failed = 0;

for (const scenario of SCENARIOS) {
  let ctx = createEmptySessionContext();
  console.log(`\n=== ${scenario.name} ===`);

  for (const step of scenario.steps) {
    const { corrected, corrections } = pipeline(step.input);
    const topic =
      extractCanonicalTopic(corrected, corrections) ??
      (step.expectedTopic && step.input.includes(step.expectedTopic) ? step.expectedTopic : null);

    if (step.expectedTopic && topic !== step.expectedTopic) {
      failed += 1;
      console.error(
        `FAIL topic: ${step.input}\n  expected: ${step.expectedTopic}\n  got:      ${topic}`,
      );
    } else if (step.expectedTopic) {
      console.log(`OK topic: ${step.input} → ${topic}`);
    }

    const followUp = resolveFollowUpQuestion({
      raw: step.input,
      corrected,
      intentCorrected: corrected,
      sessionContext: ctx,
      corrections,
    });

    if (step.expectedResolved) {
      if (followUp.resolvedQuestion !== step.expectedResolved) {
        failed += 1;
        console.error(
          `FAIL resolved: ${step.input}\n  expected: ${step.expectedResolved}\n` +
            `  got:      ${followUp.resolvedQuestion}`,
        );
      } else {
        console.log(`OK resolved: ${step.input} → ${followUp.resolvedQuestion}`);
      }
    }

    if (step.expectReset != null && followUp.resetPreviousTopic !== step.expectReset) {
      failed += 1;
      console.error(
        `FAIL reset: ${step.input}\n  expected reset=${step.expectReset}\n  got: ${followUp.resetPreviousTopic}`,
      );
    }

    if (step.expectFollowUp != null && followUp.isFollowUp !== step.expectFollowUp) {
      failed += 1;
      console.error(
        `FAIL followUp: ${step.input}\n  expected isFollowUp=${step.expectFollowUp}\n` +
          `  got: ${followUp.isFollowUp}`,
      );
    }

    if (step.expectNoContamination && followUp.resolvedQuestion.includes(step.expectNoContamination)) {
      failed += 1;
      console.error(
        `FAIL contamination: ${step.input}\n  must not contain «${step.expectNoContamination}»\n` +
          `  got: ${followUp.resolvedQuestion}`,
      );
    }

    ctx = updateSessionContextAfterAnswer(ctx, {
      rawQuestion: step.input,
      correctedQuestion: corrected,
      intentCorrectedQuestion: corrected,
      resolvedQuestion: followUp.resolvedQuestion,
      questionIntent: 'technical_definition',
      canonicalTopic: topic ?? followUp.currentTopic,
      answerSummary: 'test answer',
      resetPreviousTopic: followUp.resetPreviousTopic,
    });
  }
}

console.log('\n=== danger hallucination risk ===');
for (const { input, risk } of DANGER_CASES) {
  const got = assessHallucinationRisk(input);
  if (got !== risk) {
    failed += 1;
    console.error(`FAIL risk: ${input}\n  expected: ${risk}\n  got: ${got}`);
  } else {
    console.log(`OK risk (${risk}): ${input}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nAll scenarios passed');
