import type { Speaker, TranscriptLine } from './interviewSessionExport';
import { mergeRawParts } from './normalizeTranscript';

function questionFingerprint(text: string): string {
  return text
    .toLocaleLowerCase('ru')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function selectForcedQuestion(
  pendingParts: string[],
  lines: TranscriptLine[],
  triggerSpeaker: Speaker,
  lastCompletedQuestion = '',
  lastCompletedRawQuestion = '',
): string {
  const pending = mergeRawParts(pendingParts);
  if (pending) return pending;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line?.isFinal && line.speaker === triggerSpeaker) {
      const text = line.text.trim();
      const fingerprint = questionFingerprint(text);
      const isCompleted =
        fingerprint === questionFingerprint(lastCompletedQuestion) ||
        fingerprint === questionFingerprint(lastCompletedRawQuestion);
      return text && !isCompleted ? text : '';
    }
  }
  return '';
}

export function selectForceTargetSource(sources: {
  mic: boolean;
  system: boolean;
}): 'mic' | 'system' | null {
  if (sources.system) return 'system';
  if (sources.mic) return 'mic';
  return null;
}
