import type { AppliedCorrection } from './correctTranscriptWithGlossary';
import { QA_GLOSSARY, QA_GLOSSARY_CANONICAL_TERMS } from './qaGlossary';
import { QA_QUESTION_BANK } from './qaQuestionBank';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termInText(term: string, text: string): boolean {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, 'iu');
  return pattern.test(text);
}

const BANK_TOPIC_BY_QUESTION: Record<string, string> = {
  'Чем smoke testing отличается от regression testing?': 'smoke testing vs regression testing',
};

for (const q of QA_QUESTION_BANK) {
  if (BANK_TOPIC_BY_QUESTION[q]) continue;
  for (const entry of QA_GLOSSARY) {
    if (termInText(entry.canonical, q)) {
      BANK_TOPIC_BY_QUESTION[q] = entry.canonical;
      break;
    }
  }
}

/** Выделяет canonical topic из вопроса после correction. */
export function extractCanonicalTopic(
  question: string,
  corrections: AppliedCorrection[] = [],
): string | null {
  const q = question.trim();
  if (!q) return null;

  const lower = q.toLowerCase();
  if (lower.includes('smoke') && lower.includes('regression') && lower.includes('отлича')) {
    return 'smoke testing vs regression testing';
  }

  const correctionTargets = corrections
    .map((c) => c.to.trim())
    .filter((t) => QA_GLOSSARY_CANONICAL_TERMS.includes(t))
    .sort((a, b) => b.length - a.length);
  for (const term of correctionTargets) {
    return term;
  }

  const sorted = [...QA_GLOSSARY].sort((a, b) => b.canonical.length - a.canonical.length);
  for (const entry of sorted) {
    if (termInText(entry.canonical, q)) {
      return entry.canonical;
    }
  }

  for (const bankQ of QA_QUESTION_BANK) {
    if (q === bankQ || lower === bankQ.toLowerCase()) {
      return BANK_TOPIC_BY_QUESTION[bankQ] ?? null;
    }
  }

  return null;
}
