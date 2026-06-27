/**
 * Исправляет ошибки STT: только подмена слов, без подмены всего вопроса.
 */

const RULES: { from: string; to: string }[] = [
  { from: 'эй кью эй', to: 'AQA' },
  { from: 'обеспечение качества', to: 'QA' },
  { from: 'аэроэстопе', to: 'REST API' },
  { from: 'аэро стопе', to: 'REST API' },
  { from: 'рест апи', to: 'REST API' },
  { from: 'рест api', to: 'REST API' },
  { from: 'гитлаб си ай', to: 'GitLab CI' },
  { from: 'си ай си ди', to: 'CI/CD' },
  { from: 'о о п', to: 'ООП' },
  { from: 'кью эй', to: 'QA' },
  { from: 'пайтест', to: 'pytest' },
  { from: 'пай тест', to: 'pytest' },
  { from: 'плейврайт', to: 'Playwright' },
  { from: 'селениум', to: 'Selenium' },
  { from: 'постгрес', to: 'PostgreSQL' },
  { from: 'сваггер', to: 'Swagger' },
  { from: 'постман', to: 'Postman' },
  { from: 'джира', to: 'Jira' },
  { from: 'докер', to: 'Docker' },
  { from: 'пингтон', to: 'Python' },
  { from: 'пайтон', to: 'Python' },
  { from: 'питон', to: 'Python' },
  { from: 'кубернетес', to: 'Kubernetes' },
  { from: 'греп', to: 'grep' },
];

// NOTE: `\w`/`\b` are ASCII-only in JS even with the `u` flag, so against
// Cyrillic they fail to consume word endings — e.g. `дизайн\w*` left the "а" in
// "тест-дизайна" unconsumed and the replacement re-added it ("тест-дизайнаа").
// Use the Unicode letter/number class `[\p{L}\p{N}]` and explicit Unicode word
// boundaries instead.
const FUZZY: { re: RegExp; to: string }[] = [
  { re: /тест\s*[-\s]?дизайн[\p{L}\p{N}]*/giu, to: 'тест-дизайна' },
  { re: /паттерн[\p{L}\p{N}]*\s+по\s+тест[\p{L}\p{N}]*/giu, to: 'паттерны pytest' },
  { re: /по\s+тест(?:у|ам|е)(?![\p{L}\p{N}])/giu, to: 'pytest' },
  { re: /п(?:ai|ай|аи)\s*[-\s]?test/giu, to: 'pytest' },
  { re: /благодаря\s+какой\s+команд[\p{L}\p{N}]*/giu, to: 'с помощью какой команды' },
  { re: /какой\s+команд[\p{L}\p{N}]*\s+можно\s+искать/giu, to: 'с помощью какой команды можно искать' },
  { re: /(?<![\p{L}\p{N}])лин(?:укс|уксе|уз|uxe|uks|зе|за|zе)[\p{L}\p{N}]*(?![\p{L}\p{N}])/giu, to: 'Linux' },
  { re: /(?<![\p{L}\p{N}])(?:g\s*r\s*e\s*p|г\s*р\s*э\s*п)(?![\p{L}\p{N}])/giu, to: 'grep' },
  { re: /так(?:ие|ой)\s*(?:2|два)\s*принцип/giu, to: 'какие принципы' },
  { re: /принцип[\p{L}\p{N}]*\s+(?:ал+[оo]п[\p{L}\p{N}]*|о+[лl]оп[\p{L}\p{N}]*)/giu, to: 'принципы ООП' },
  { re: /принцип[\p{L}\p{N}]*\s+о\s+(?:[ло]{3,}[\p{L}\p{N}]*)+/giu, to: 'принципы ООП' },
  { re: /(?<=принцип[\p{L}\p{N}]*\s+)ал+[оo]п[\p{L}\p{N}]*/giu, to: 'ООП' },
  { re: /т(?:ы|и|е|а)\s*ст[ёеe]рг[\p{L}\p{N}]*/giu, to: 'тестирования' },
  { re: /ст[ёеe]рг[\p{L}\p{N}]*/giu, to: 'тестирования' },
  { re: /принцип[\p{L}\p{N}]*\s+автоматиз[\p{L}\p{N}]*/giu, to: 'принципы автоматизации' },
  { re: /какие\s+бывают\s+принцип[\p{L}\p{N}]*/giu, to: 'какие бывают принципы автоматизации' },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const compiled = RULES.map((rule) => ({
  re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(rule.from)}(?![\\p{L}\\p{N}])`, 'giu'),
  to: rule.to,
}));

const ABBREV: { re: RegExp; to: string }[] = [
  { re: /\b(?:э|е|а)?р\s*э\s*эс\s*т(?:и|e)?\b/giu, to: 'REST' },
  { re: /\br\s*s\s*t\b/giu, to: 'REST' },
  { re: /\bрест\b/giu, to: 'REST' },
  { re: /\b(?:апи|a p i)\b/giu, to: 'API' },
  { re: /\bо\s*о\s*п\b/giu, to: 'ООП' },
];

/** Убирает только хвостовые шаблонные фразы LLM, не тело ответа про опыт. */
export function stripExperienceFooter(text: string): string {
  let out = text.trim();
  const cutPatterns = [
    /\n?\s*Если нужно, могу[\s\S]*$/iu,
    /\n?\s*Могу также рассказать[\s\S]*$/iu,
    /\n?\s*Хотите, чтобы я[\s\S]*$/iu,
  ];
  for (const re of cutPatterns) {
    out = out.replace(re, '');
  }
  return out.trim();
}

export function normalizeTranscript(rawText: string): string {
  let result = rawText.trim();
  for (const { re, to } of compiled) {
    result = result.replace(re, to);
  }
  for (const { re, to } of FUZZY) {
    result = result.replace(re, to);
  }
  for (const { re, to } of ABBREV) {
    result = result.replace(re, to);
  }
  if (/\bREST\b/i.test(result) && /api|апи/i.test(result) && !/REST API/i.test(result)) {
    result = result.replace(/\bREST\b/gi, 'REST API');
  }
  return result.replace(/\s{2,}/g, ' ').trim();
}

export function mergeQuestionParts(parts: string[]): string {
  const cleaned = parts.map((p) => p.trim()).filter((p) => p.length > 2);
  if (cleaned.length === 0) return '';
  return normalizeTranscript(cleaned.join(' '));
}

export function mergeRawParts(parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter((p) => p.length > 2)
    .join(' ');
}

export function questionChanged(prev: string, next: string): boolean {
  const a = prev.toLowerCase().replace(/\s+/g, ' ').trim();
  const b = next.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!a || !b) return true;
  if (a === b) return false;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  if (longer.includes(shorter) && shorter.length / longer.length > 0.65) return false;
  return true;
}

// Technical entities that, when present, mark a phrase as carrying interview
// intent even without a clean interrogative.
const TECH_ENTITY_RE =
  /(?<![\p{L}\p{N}])(?:docker|ci\/?cd|api|pytest|playwright|allure|gitlab|jenkins|httpx|requests|page\s*object|pom|linux|selenium|kafka|kubernetes|fixture|conftest|smoke|regression|sql|grep)(?![\p{L}\p{N}])/iu;

// «как-то / как бы / как раз / как будто» are NOT interrogative — they only look
// like a question because they start with «как».
const NON_INTERROGATIVE_KAK_RE = /^как[\s-]*(?:то|бы|раз|будто)(?![\p{L}\p{N}])/iu;

function hasQuestionSignal(t: string): boolean {
  return (
    /^(?:какие|какой|какая|какую|каких|каким|что|чем|зачем|почему|где|когда|расскаж|опиш|назов|перечисл|можно|благодаря|с\s+помощью|паттерн|скаж|принцип)/iu.test(
      t,
    ) ||
    /^как(?![\s-]*(?:то|бы|раз|будто))/iu.test(t) ||
    /что\s+значит|что\s+такое|что\s+это\s+за|автоматиз/i.test(t) ||
    /(?<![\p{L}\p{N}])ли(?![\p{L}\p{N}])/iu.test(t) ||
    TECH_ENTITY_RE.test(t)
  );
}

export function looksLikeQuestion(text: string): boolean {
  const t = normalizeTranscript(text.trim());
  if (t.length < 8) return false;
  if (NON_INTERROGATIVE_KAK_RE.test(t)) return false;
  return /[?]/u.test(t) || hasQuestionSignal(t);
}

/**
 * A non-question fragment that must NOT trigger an LLM answer even though it may
 * contain «?»: a short fragment with no interrogative word, no «ли», no technical
 * entity (e.g. «Вместе или не?»), or a «как-то/как бы…» filler opener.
 */
export function isNonQuestionFragment(text: string): boolean {
  const t = normalizeTranscript(text.trim()).toLowerCase();
  if (!t) return true;
  if (NON_INTERROGATIVE_KAK_RE.test(t)) return true;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length <= 4 && !hasQuestionSignal(t)) return true;
  return false;
}

export function countMeaningfulWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.replace(/[^\p{L}\p{N}]/gu, '').length > 1).length;
}

/**
 * Detects Whisper repetition-loop hallucinations like
 * "я не буду но я не буду но я буду..." — a tiny set of words cycling for
 * dozens of tokens. These are produced on music/noise/silence and must never
 * reach the LLM. We look at how few distinct words make up a long utterance.
 */
function isRepetitionLoop(tokens: string[]): boolean {
  if (tokens.length < 8) return false;
  const uniqueRatio = new Set(tokens).size / tokens.length;
  // A genuine question rarely repeats words this aggressively; a loop collapses
  // to a handful of distinct words no matter how long it gets.
  if (uniqueRatio <= 0.25) return true;
  // Catch a single dominant word ("буду буду буду ...") even with some filler.
  const counts = new Map<string, number>();
  for (const tok of tokens) counts.set(tok, (counts.get(tok) ?? 0) + 1);
  const topCount = Math.max(...counts.values());
  if (topCount / tokens.length >= 0.45) return true;
  return false;
}

/** Too short or obviously broken STT — do not send to LLM yet. */
export function isGarbageTranscript(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (countMeaningfulWords(t) < 3) return true;
  const tokens = t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length >= 3 && new Set(tokens).size === 1) return true;
  if (isRepetitionLoop(tokens)) return true;
  return false;
}
