import type { VoiceTestKeywordInput, VoiceTestKeywordMatch, VoiceTestKeywordSpec } from './voice-test-types';

const RU_ENDINGS = [
  'ами',
  'ями',
  'ого',
  'его',
  'ной',
  'ную',
  'ные',
  'ными',
  'ием',
  'ать',
  'ить',
  'ции',
  'ии',
  'ов',
  'ам',
  'ах',
  'ом',
  'ем',
  'ы',
  'и',
  'а',
  'е',
  'у',
  'ю',
  'о',
];

export function normalizeText(text: string): string {
  let t = text.toLowerCase().replace(/ё/g, 'е');

  t = t.replace(/ci\s*\/\s*cd/gi, ' cicd ');
  t = t.replace(/\bci\s+cd\b/gi, ' cicd ');
  t = t.replace(/\bcicd\b/gi, ' cicd ');
  t = t.replace(/ui[\s-]*тестирован(?:ие|ия|ии)/gi, ' uitesting ');
  t = t.replace(/ui[\s-]*автотест(?:ы|ов|ам|ами|ах)?/gi, ' uitesting ');
  t = t.replace(/ui[\s-]*testing/gi, ' uitesting ');

  t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

export function tokenize(text: string): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  return normalized.split(' ').filter(Boolean);
}

export function parseKeywordSpec(input: VoiceTestKeywordInput): VoiceTestKeywordSpec {
  if (typeof input === 'string') {
    return { key: input, aliases: [input] };
  }
  const aliases = input.aliases.includes(input.key) ? [...input.aliases] : [input.key, ...input.aliases];
  return { key: input.key, aliases };
}

export function parseKeywordSpecs(inputs: VoiceTestKeywordInput[]): VoiceTestKeywordSpec[] {
  return inputs.map(parseKeywordSpec);
}

export function keywordKeys(inputs: VoiceTestKeywordInput[]): string[] {
  return parseKeywordSpecs(inputs).map((spec) => spec.key);
}

function russianStem(word: string): string {
  let stem = word.toLowerCase();
  if (stem.length <= 4) return stem;

  for (const ending of RU_ENDINGS) {
    if (stem.length > ending.length + 3 && stem.endsWith(ending)) {
      stem = stem.slice(0, -ending.length);
      break;
    }
  }
  return stem.length >= 3 ? stem : word.toLowerCase();
}

function stemsMatch(a: string, b: string): boolean {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const sa = russianStem(na);
  const sb = russianStem(nb);
  if (sa === sb) return true;

  const minLen = Math.min(sa.length, sb.length);
  if (minLen < 4) return false;
  const rootLen = Math.max(4, minLen - 1);
  return sa.slice(0, rootLen) === sb.slice(0, rootLen);
}

function aliasMatches(haystack: string, tokens: string[], alias: string): boolean {
  const normAlias = normalizeText(alias);
  if (!normAlias) return false;

  if (haystack.includes(normAlias)) return true;

  const aliasTokens = normAlias.split(' ').filter(Boolean);
  if (aliasTokens.length > 1) {
    return haystack.includes(normAlias);
  }

  for (const token of tokens) {
    if (token === normAlias) return true;
    if (stemsMatch(token, normAlias)) return true;
    if (normAlias.length >= 4 && token.length >= 4) {
      if (token.startsWith(normAlias) || normAlias.startsWith(token)) return true;
    }
  }

  return false;
}

export function matchKeywords(
  source: string,
  specs: VoiceTestKeywordInput[],
): { found: VoiceTestKeywordMatch[]; missing: string[] } {
  const parsed = parseKeywordSpecs(specs);
  const haystack = normalizeText(source);
  const tokens = tokenize(source);
  const found: VoiceTestKeywordMatch[] = [];
  const missing: string[] = [];

  for (const spec of parsed) {
    let matchedAlias: string | null = null;
    for (const alias of spec.aliases) {
      if (aliasMatches(haystack, tokens, alias)) {
        matchedAlias = alias;
        break;
      }
    }
    if (matchedAlias) {
      found.push({ key: spec.key, matchedAlias });
    } else {
      missing.push(spec.key);
    }
  }

  return { found, missing };
}

export function findForbiddenPhrases(answer: string, phrases: string[]): string[] {
  const haystack = normalizeText(answer);
  return phrases.filter((phrase) => isForbiddenPhraseMatch(haystack, phrase));
}

function isForbiddenPhraseMatch(haystack: string, phrase: string): boolean {
  const normPhrase = normalizeText(phrase);
  if (!normPhrase) return false;

  let idx = 0;
  while (idx <= haystack.length) {
    const found = haystack.indexOf(normPhrase, idx);
    if (found === -1) return false;
    if (!isNegatedBefore(haystack, found)) return true;
    idx = found + 1;
  }
  return false;
}

function isNegatedBefore(haystack: string, phraseStart: number): boolean {
  const before = haystack.slice(0, phraseStart).trimEnd();
  if (!before) return false;
  return before.endsWith('не') || before.endsWith('не только');
}
