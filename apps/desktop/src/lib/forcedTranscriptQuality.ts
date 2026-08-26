export type ForcedTranscriptQuality =
  | { eligible: true }
  | {
      eligible: false;
      reason: 'forced_text_empty' | 'forced_text_language_mismatch';
    };

export type ForcedFinalTranscriptPolicy =
  | { action: 'defer-to-coordinator' }
  | { action: 'eligible' }
  | {
      action: 'reject';
      reason: 'forced_text_empty' | 'forced_text_language_mismatch';
    };

const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const CYRILLIC_LETTER_RE = /\p{Script=Cyrillic}/gu;
const CYRILLIC_WORD_RE = /\p{Script=Cyrillic}+/gu;
const LATIN_IDENTIFIER_RE =
  /[.\p{Script=Latin}\p{N}+#]+(?:[/.-][\p{Script=Latin}\p{N}+#]+)*/gu;
const HAS_LATIN_LETTER_RE = /\p{Script=Latin}/u;
const LATIN_LETTER_RE = /\p{Script=Latin}/gu;
const ASCII_TECH_IDENTIFIER_RE = /^[A-Za-z0-9.+#/-]+$/u;
const MAX_TEXT_CAPTURE_AGE_MS = 20_000;
const MAX_UNKNOWN_LATIN_TO_CYRILLIC_RATIO = 1.3;

const FOREIGN_NOISE_COMPONENTS = new Set(['no', 'dobrze']);

const RUSSIAN_SESSION_TECH_TERMS = new Set([
  'c',
  'c#',
  'c++',
  'cicd',
  'net',
  'api',
  'docker',
  'git',
  'go',
  'http',
  'https',
  'json',
  'kubernetes',
  'nodejs',
  'playwright',
  'postgres',
  'postgresql',
  'pytest',
  'python',
  'rest',
  'sql',
  'xml',
  'yield',
]);

function normalizeTechIdentifier(token: string): string {
  return token
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, '');
}

function isKnownTechIdentifier(token: string): boolean {
  if (RUSSIAN_SESSION_TECH_TERMS.has(normalizeTechIdentifier(token))) return true;
  const components = token
    .normalize('NFKC')
    .split(/[/.-]+/u)
    .map(normalizeTechIdentifier)
    .filter(Boolean);
  return components.length > 1 && components.every((component) =>
    RUSSIAN_SESSION_TECH_TERMS.has(component),
  );
}

function latinIdentifierComponents(token: string): string[] {
  return token
    .normalize('NFKC')
    .split(/[/.-]+/u)
    .map(normalizeTechIdentifier)
    .filter(Boolean);
}

/**
 * Conservative gate for a Ctrl+Enter transcript. Russian sessions accept
 * Cyrillic speech and a small set of established technical terms, but do not
 * send unrelated Latin-language STT fragments to the text model.
 */
export function evaluateForcedTranscript(
  transcript: string,
  language: string | null | undefined,
): ForcedTranscriptQuality {
  const text = transcript.trim();
  if (!text) return { eligible: false, reason: 'forced_text_empty' };
  if (!(language || '').toLowerCase().startsWith('ru')) return { eligible: true };
  const latinTokens = (text.match(LATIN_IDENTIFIER_RE) ?? []).filter((token) =>
    HAS_LATIN_LETTER_RE.test(token),
  );
  const unknownLatinTokens = latinTokens.filter((token) => !isKnownTechIdentifier(token));
  const unknownLatinLetters = unknownLatinTokens
    .reduce((count, token) => count + (token.match(LATIN_LETTER_RE)?.length ?? 0), 0);
  if (unknownLatinLetters > 0) {
    const containsForeignNoise = unknownLatinTokens.some((token) =>
      latinIdentifierComponents(token).some((component) => FOREIGN_NOISE_COMPONENTS.has(component)),
    );
    const containsNonAsciiIdentifier = unknownLatinTokens.some(
      (token) => !ASCII_TECH_IDENTIFIER_RE.test(token),
    );
    const cyrillicLetters = text.match(CYRILLIC_LETTER_RE)?.length ?? 0;
    const cyrillicWords = text.match(CYRILLIC_WORD_RE)?.length ?? 0;
    const hasGroundingRussianContext =
      cyrillicWords >= 2 &&
      unknownLatinLetters <= cyrillicLetters * MAX_UNKNOWN_LATIN_TO_CYRILLIC_RATIO;
    if (containsForeignNoise || containsNonAsciiIdentifier || !hasGroundingRussianContext) {
      return { eligible: false, reason: 'forced_text_language_mismatch' };
    }
    return { eligible: true };
  }
  if (latinTokens.length > 0 && unknownLatinLetters === 0) return { eligible: true };

  const cyrillicLetters = text.match(CYRILLIC_LETTER_RE)?.length ?? 0;
  if (CYRILLIC_RE.test(text) && cyrillicLetters >= 2) {
    return { eligible: true };
  }
  return { eligible: false, reason: 'forced_text_language_mismatch' };
}

/** Ignore late finals owned by an older force generation. */
export function evaluateForcedFinalTranscript(
  transcript: string,
  language: string | null | undefined,
  forceRequestId: string | undefined,
  activeForceRequestId: string | null,
  transcriptSource?: 'mic' | 'system',
  activeSource?: 'mic' | 'system' | null,
  capturedAtMs?: number,
  nowMs: number = Date.now(),
): ForcedFinalTranscriptPolicy {
  if (!forceRequestId || forceRequestId !== activeForceRequestId) {
    return { action: 'defer-to-coordinator' };
  }
  if (activeSource && transcriptSource && transcriptSource !== activeSource) {
    return { action: 'defer-to-coordinator' };
  }
  if (
    typeof capturedAtMs === 'number' &&
    Number.isFinite(capturedAtMs) &&
    nowMs - capturedAtMs > MAX_TEXT_CAPTURE_AGE_MS
  ) {
    return { action: 'defer-to-coordinator' };
  }
  const quality = evaluateForcedTranscript(transcript, language);
  return quality.eligible ? { action: 'eligible' } : { action: 'reject', reason: quality.reason };
}
