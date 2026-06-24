/**
 * Run: npx tsx packages/shared/src/pythonUtterance.test.ts
 */
import { applyPythonPhraseCorrections, isOrphanComparativeTail } from './correctPythonPhrases';
import { correctTranscriptWithGlossary } from './correctTranscriptWithGlossary';
import { correctQuestionIntent } from './correctQuestionIntent';
import {
  mergeTranscriptWithBuffer,
  pushUtteranceBuffer,
  shouldWaitForMoreSpeech,
} from './utteranceBuffer';

function pipeline(raw: string): string {
  const g = correctTranscriptWithGlossary(raw, { interviewMode: true, isShort: true });
  const py = applyPythonPhraseCorrections(g.corrected);
  const intent = correctQuestionIntent({
    raw,
    corrected: py.corrected,
    corrections: [...g.corrections, ...py.corrections],
  });
  return intent.intentCorrected;
}

let failed = 0;

function assertEq(label: string, got: string, expected: string) {
  if (got !== expected) {
    failed += 1;
    console.error(`FAIL ${label}\n  expected: ${expected}\n  got:      ${got}`);
  } else {
    console.log(`OK ${label}`);
  }
}

function assertWait(label: string, wait: boolean, expected: boolean) {
  if (wait !== expected) {
    failed += 1;
    console.error(`FAIL ${label}: wait=${wait}, expected=${expected}`);
  } else {
    console.log(`OK ${label}`);
  }
}

assertEq(
  'list vs typo full',
  pipeline('Чем лист отличает от typo?'),
  'Чем list отличается от tuple?',
);

let buf = pushUtteranceBuffer([], {
  text: 'Чем лист отличает',
  timestamp: Date.now(),
  speaker: 'interviewer',
  isFinal: true,
});

const part1Wait = shouldWaitForMoreSpeech('Чем лист отличает', buf, 'interviewer');
assertWait('part1 waits', part1Wait.wait, true);

buf = pushUtteranceBuffer(buf, {
  text: 'от typo?',
  timestamp: Date.now() + 100,
  speaker: 'interviewer',
  isFinal: true,
});

const merged = mergeTranscriptWithBuffer('от typo?', buf, 'interviewer');
assertEq('merge parts', pipeline(merged), 'Чем list отличается от tuple?');

const part2Wait = shouldWaitForMoreSpeech('от typo?', buf, 'interviewer');
assertWait('part2 merged no wait', part2Wait.wait, false);

const orphanWait = shouldWaitForMoreSpeech('от typo?', [], 'interviewer');
assertWait('orphan tail waits', orphanWait.wait, true);
assertWait('is orphan tail', isOrphanComparativeTail('от typo?'), true);

assertEq(
  'list vs set',
  pipeline('Чем list отличается от set?'),
  'Чем list отличается от set?',
);

assertEq(
  'tuple vs set',
  pipeline('Чем tuple отличается от set?'),
  'Чем tuple отличается от set?',
);

if (failed > 0) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nAll python utterance tests passed');
