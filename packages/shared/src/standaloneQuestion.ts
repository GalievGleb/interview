import type { AppliedCorrection } from './transcriptMetadata';

const STANDALONE_DEFINITION_RE =
  /(?:^|\s)(?:что\s+такое|что\s+значит|объясни(?:те)?|расскаж(?:ите|и)\s+(?:про|о))\s+(.+?)\??\s*$/iu;
const PRONOUN_ONLY_RE = /^(?:это|он|она|оно|то|оно\s+такое)$/iu;

export function extractStandaloneDefinitionTerm(question: string): string | null {
  const match = question.trim().match(STANDALONE_DEFINITION_RE);
  const term = match?.[1]?.trim().replace(/[?.!,;:]+$/g, '').trim() ?? '';
  if (term.length < 2 || PRONOUN_ONLY_RE.test(term)) return null;
  return term;
}

export function isStandaloneDefinitionQuestion(
  question: string,
  _corrections: AppliedCorrection[] = [],
): boolean {
  return extractStandaloneDefinitionTerm(question) != null;
}

export function resolveStandaloneTopic(
  question: string,
  _corrections: AppliedCorrection[] = [],
): string | null {
  return extractStandaloneDefinitionTerm(question);
}
