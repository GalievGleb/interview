/**
 * Deterministic quality checks for a live "Say aloud" answer. Used by regression
 * tests (and available to the Test Lab) to assert answers are spoken-ready:
 * within length, no ChatGPT tails, no leaked internal labels, a direct opening.
 *
 * This is heuristic and language-aware (Russian live answers) — it does not judge
 * factual correctness, only the structural "does it sound like a candidate" rules.
 */

/** Phrases that must never appear in a live/Say-aloud answer. */
export const FORBIDDEN_LIVE_PHRASES: string[] = [
  'если хотите, могу подробнее',
  'если хотите, могу разложить',
  'важно отметить',
  'в заключение',
  'давайте рассмотрим',
  'main answer',
  'key points',
  'short answer',
  'я не совсем понял вопрос. если говорить в общем',
  'в разных контекстах могут быть разные подходы',
  'это позволило мне углубить',
  'существуют различные инструменты и методы',
];

/** Internal section labels that should be stripped before display. */
export const INTERNAL_LABELS: string[] = [
  'main answer',
  'key points',
  'short answer',
  'detailed',
];

/** Filler openings that make the first sentence non-direct. */
const FILLER_OPENINGS = [
  /^похоже,/i,
  /^вероятно,/i,
  /^судя\s+по\s+всему,/i,
  /^я\s+понял\s+вопрос\s+как/i,
  /^вопрос\s+(?:про|касается)/i,
  /^можно\s+сказать,/i,
  /^в\s+целом,/i,
  /^давайте\s+разберём/i,
  /^важно\s+отметить/i,
  /^я\s+не\s+совсем\s+понял/i,
];

export interface SpokenAnswerQuality {
  wordCount: number;
  withinWordLimit: boolean;
  forbiddenPhrases: string[];
  internalLabels: string[];
  startsWithFiller: boolean;
  hasMarkdownHeader: boolean;
  /** Overall: spoken-ready (within limit, clean, direct opening). */
  ok: boolean;
}

export function countWords(text: string): number {
  const t = (text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

export function scoreSpokenAnswer(
  answer: string,
  opts: { maxWords?: number; requiredTerms?: string[] } = {},
): SpokenAnswerQuality {
  const maxWords = opts.maxWords ?? 90;
  const text = (answer || '').trim();
  const low = text.toLowerCase();

  const forbiddenPhrases = FORBIDDEN_LIVE_PHRASES.filter((p) => low.includes(p));
  const internalLabels = INTERNAL_LABELS.filter((l) =>
    new RegExp(`(?:^|\\n|[.?!]\\s)\\s*\\*{0,2}\\s*${l}\\s*\\*{0,2}\\s*:`, 'i').test(low),
  );
  const wordCount = countWords(text);
  const withinWordLimit = wordCount <= maxWords;
  const startsWithFiller = FILLER_OPENINGS.some((re) => re.test(text));
  const hasMarkdownHeader = /(?:^|\n)\s*#{1,6}\s/.test(text);

  const ok =
    wordCount > 0 &&
    withinWordLimit &&
    forbiddenPhrases.length === 0 &&
    internalLabels.length === 0 &&
    !startsWithFiller &&
    !hasMarkdownHeader;

  return {
    wordCount,
    withinWordLimit,
    forbiddenPhrases,
    internalLabels,
    startsWithFiller,
    hasMarkdownHeader,
    ok,
  };
}
