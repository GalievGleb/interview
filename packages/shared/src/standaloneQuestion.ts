import type { AppliedCorrection } from './correctTranscriptWithGlossary';
import { QA_GLOSSARY } from './qaGlossary';

const STANDALONE_DEFINITION_RE =
  /(?:^|\s)(?:что\s+такое|что\s+значит|объясни(?:те)?|расскаж(?:ите|и)\s+(?:про|о))\s+(.+?)\??\s*$/iu;

const PRONOUN_ONLY_RE = /^(?:это|он|она|оно|то|оно\s+такое)$/iu;

const INCIDENTAL_PIPELINE_RE = /\s(?:в|in)\s+pipeline(?:[?.!,]|$|\s)/iu;

function isIncidentalPipeline(text: string): boolean {
  return (
    INCIDENTAL_PIPELINE_RE.test(text) &&
    !/(?:что\s+такое|расскаж\w*\s+про)\s+pipeline/i.test(text)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termInText(term: string, text: string): boolean {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, 'iu');
  return pattern.test(text);
}

/** Term after «что такое X» / «расскажи про X», before glossary normalization. */
export function extractStandaloneDefinitionTerm(question: string): string | null {
  const q = question.trim();
  const match = q.match(STANDALONE_DEFINITION_RE);
  if (!match?.[1]) return null;
  const term = match[1].trim().replace(/[?.!,;:]+$/g, '').trim();
  if (!term || term.length < 2 || PRONOUN_ONLY_RE.test(term)) return null;
  return term;
}

function glossaryCanonicalForText(text: string): string | null {
  const sorted = [...QA_GLOSSARY].sort((a, b) => b.canonical.length - a.canonical.length);
  for (const entry of sorted) {
    if (termInText(entry.canonical, text)) return entry.canonical;
    for (const alias of entry.aliases) {
      if (termInText(alias, text)) return entry.canonical;
    }
  }
  return null;
}

/** True when question names a new topic explicitly (e.g. «Что такое тест-кейс?»). */
export function isStandaloneDefinitionQuestion(
  question: string,
  corrections: AppliedCorrection[] = [],
): boolean {
  const q = question.trim();
  if (!STANDALONE_DEFINITION_RE.test(q)) return false;

  const correctionTarget = corrections
    .map((c) => c.to.trim())
    .find((t) => termInText(t, q) || q.toLowerCase().includes(t.toLowerCase()));
  if (correctionTarget) return true;

  if (glossaryCanonicalForText(q)) return true;

  const standalone = extractStandaloneDefinitionTerm(q);
  return Boolean(standalone && !PRONOUN_ONLY_RE.test(standalone));
}

export function resolveStandaloneTopic(
  question: string,
  corrections: AppliedCorrection[] = [],
): string | null {
  const fromGlossary = glossaryCanonicalForText(question);
  if (fromGlossary && !(fromGlossary === 'pipeline' && isIncidentalPipeline(question))) {
    return fromGlossary;
  }

  const fromCorrection = corrections
    .map((c) => c.to.trim())
    .sort((a, b) => b.length - a.length)
    .find((t) => termInText(t, question));
  if (fromCorrection) return fromCorrection;

  const raw = extractStandaloneDefinitionTerm(question);
  if (!raw) return null;
  return glossaryCanonicalForText(raw) ?? raw;
}
