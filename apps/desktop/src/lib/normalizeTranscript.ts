/** Removes only optional LLM footer phrases from generated answers. */
export function stripExperienceFooter(text: string): string {
  let output = text.trim();
  const patterns = [
    /\n?\s*Если нужно, могу[\s\S]*$/iu,
    /\n?\s*Могу также рассказать[\s\S]*$/iu,
    /\n?\s*Хотите, чтобы я[\s\S]*$/iu,
  ];
  for (const pattern of patterns) output = output.replace(pattern, '');
  return output.trim();
}

/** Whitespace-only normalization. No glossary, aliases, or term rewriting. */
export function normalizeTranscript(rawText: string): string {
  return rawText.trim().replace(/\s{2,}/g, ' ');
}

export function mergeQuestionParts(parts: string[]): string {
  return normalizeTranscript(
    parts
      .map((part) => part.trim())
      .filter((part) => part.length > 2)
      .join(' '),
  );
}

export function mergeRawParts(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 2)
    .join(' ');
}

export function questionChanged(previous: string, next: string): boolean {
  const a = previous.toLowerCase().replace(/\s+/g, ' ').trim();
  const b = next.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!a || !b) return true;
  if (a === b) return false;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  return !(longer.includes(shorter) && shorter.length / longer.length > 0.65);
}

const TECH_ENTITY_RE =
  /(?<![\p{L}\p{N}])(?:docker|ci\/?cd|api|pytest|playwright|allure|gitlab|jenkins|httpx|requests|page\s*object|pom|linux|selenium|kafka|kubernetes|fixture|conftest|smoke|regression|sql|grep)(?![\p{L}\p{N}])/iu;

const NON_INTERROGATIVE_KAK_RE =
  /^как[\s-]*(?:то|бы|раз|будто)(?![\p{L}\p{N}])/iu;

function hasQuestionSignal(text: string): boolean {
  return (
    /^(?:какие|какой|какая|какую|каких|каким|что|чем|зачем|почему|где|когда|расскаж|опиш|назов|перечисл|можно|скажи|принцип)/iu.test(
      text,
    ) ||
    /^как(?![\s-]*(?:то|бы|раз|будто))/iu.test(text) ||
    /что\s+значит|что\s+такое|что\s+это\s+за|автоматиз/iu.test(text) ||
    /(?<![\p{L}\p{N}])ли(?![\p{L}\p{N}])/iu.test(text) ||
    TECH_ENTITY_RE.test(text)
  );
}

export function looksLikeQuestion(text: string): boolean {
  const value = normalizeTranscript(text);
  if (value.length < 8 || NON_INTERROGATIVE_KAK_RE.test(value)) return false;
  return value.includes('?') || hasQuestionSignal(value);
}

export function isNonQuestionFragment(text: string): boolean {
  const value = normalizeTranscript(text).toLowerCase();
  if (!value || NON_INTERROGATIVE_KAK_RE.test(value)) return true;
  const words = value.split(/\s+/).filter(Boolean);
  return words.length <= 4 && !hasQuestionSignal(value);
}

export function countMeaningfulWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((word) => word.replace(/[^\p{L}\p{N}]/gu, '').length > 1).length;
}

function isRepetitionLoop(tokens: string[]): boolean {
  if (tokens.length < 8) return false;
  if (new Set(tokens).size / tokens.length <= 0.25) return true;
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return Math.max(...counts.values()) / tokens.length >= 0.45;
}

/** Detects noise/repetition without changing the transcript. */
export function isGarbageTranscript(text: string): boolean {
  const value = text.trim();
  if (!value) return true;
  if (/(\p{L})\1{5,}/u.test(value)) return true;
  if (countMeaningfulWords(value) < 3) return true;
  const tokens = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length >= 3 && new Set(tokens).size === 1) return true;
  return isRepetitionLoop(tokens);
}
