import type { AppliedCorrection } from './transcriptMetadata';
import { extractExplicitCanonicalTopic } from './topicReset';
import { resolveStandaloneTopic } from './standaloneQuestion';

export function extractCanonicalTopic(
  question: string,
  corrections: AppliedCorrection[] = [],
): string | null {
  return (
    extractExplicitCanonicalTopic(question, corrections) ??
    resolveStandaloneTopic(question, corrections)
  );
}
