export type UtteranceSpeaker = 'me' | 'interviewer';

export interface UtteranceBufferEntry {
  text: string;
  timestamp: number;
  speaker: UtteranceSpeaker;
  isFinal: boolean;
}

export interface UtteranceWaitResult {
  wait: boolean;
  reason?: string;
  action?: 'wait_for_more_audio' | 'clarification_needed';
  merged?: string;
}

const BUFFER_WINDOW_MS = 5000;
const MAX_BUFFER_ENTRIES = 3;

const INCOMPLETE_HEAD_RES: RegExp[] = [
  /^чем\s+.+\s+отлича[\p{L}]*\s*$/iu,
  /^чем\s+list\s+отлича[\p{L}]*\s*$/iu,
  /^чем\s+лист[\p{L}]*\s+отлича[\p{L}]*\s*$/iu,
  /^(?:а\s+)?чем\s*$/iu,
  /^(?:а\s+)?как\s*$/iu,
  /^и\s+как\s*$/iu,
  /^с\s+помощью\s+чего\s*$/iu,
  /^(?:в\s+)?(?:ч[её]м\s+)?разниц[аи]?(?:\s+между)?\s*$/iu,
  /^что\s+такое\s*$/iu,
];

const ORPHAN_TAIL_RE =
  /^от\s+(?:typo|tuple|type\s*o|типо|тайпо|тупл[\p{L}]*|тапл[\p{L}]*|кортеж[\p{L}]*|list|лист[\p{L}]*|set)\??$/iu;

const MAX_INCOMPLETE_WAITS = 4;

/** After several waits, proceed if text already looks like an interview question. */
export function shouldForceProceedIncomplete(retryCount: number, text: string): boolean {
  if (retryCount < MAX_INCOMPLETE_WAITS) return false;
  const t = text.trim();
  if (t.length >= 18) return true;
  if (/^какие\s+(?:бывают\s+)?\S+/iu.test(t)) return true;
  if (/^что\s+такое\s+\S+/iu.test(t)) return true;
  if (/[?]/.test(t) && t.length >= 12) return true;
  return t.split(/\s+/).filter(Boolean).length >= 4;
}

export function pruneUtteranceBuffer(
  buffer: UtteranceBufferEntry[],
  now = Date.now(),
): UtteranceBufferEntry[] {
  return buffer
    .filter((e) => now - e.timestamp <= BUFFER_WINDOW_MS)
    .slice(-MAX_BUFFER_ENTRIES);
}

export function pushUtteranceBuffer(
  buffer: UtteranceBufferEntry[],
  entry: UtteranceBufferEntry,
): UtteranceBufferEntry[] {
  const trimmed = entry.text.trim();
  if (!trimmed) return buffer;
  const next = [...pruneUtteranceBuffer(buffer, entry.timestamp), { ...entry, text: trimmed }];
  return next.slice(-MAX_BUFFER_ENTRIES);
}

function sameSpeakerChain(buffer: UtteranceBufferEntry[], speaker: UtteranceSpeaker): string {
  return buffer
    .filter((e) => e.speaker === speaker)
    .map((e) => e.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Merge tail utterance with recent buffer (e.g. «Чем лист отличает» + «от typo?»). */
export function mergeTranscriptWithBuffer(
  transcript: string,
  buffer: UtteranceBufferEntry[],
  speaker: UtteranceSpeaker,
): string {
  const trimmed = transcript.trim();
  if (!trimmed) return trimmed;

  const recent = pruneUtteranceBuffer(buffer).filter((e) => e.speaker === speaker);
  if (recent.length === 0) return trimmed;

  const prevCombined = sameSpeakerChain(recent.slice(0, -1), speaker);
  const last = recent[recent.length - 1]?.text ?? '';

  if (ORPHAN_TAIL_RE.test(trimmed) && prevCombined) {
    if (/отлича|разниц|чем\s+/iu.test(prevCombined)) {
      return `${prevCombined} ${trimmed}`.replace(/\s+/g, ' ').trim();
    }
  }

  if (INCOMPLETE_HEAD_RES.some((re) => re.test(last)) && !INCOMPLETE_HEAD_RES.some((re) => re.test(trimmed))) {
    return `${last} ${trimmed}`.replace(/\s+/g, ' ').trim();
  }

  return trimmed;
}

function isCompleteQuestion(text: string): boolean {
  const t = text.trim();
  if (t.length < 12) return false;
  if (INCOMPLETE_HEAD_RES.some((re) => re.test(t))) return false;
  if (ORPHAN_TAIL_RE.test(t)) return false;
  if (/[?]/.test(t)) return true;
  if (/^чем\s+.+\s+отлича[\p{L}]*\s+от\s+.+/iu.test(t)) return true;
  if (/^что\s+такое\s+\S+/iu.test(t)) return true;
  if (/^какие\s+\S+/iu.test(t)) return true;
  return t.split(/\s+/).filter(Boolean).length >= 5;
}

export function shouldWaitForMoreSpeech(
  transcript: string,
  buffer: UtteranceBufferEntry[],
  speaker: UtteranceSpeaker,
): UtteranceWaitResult {
  const merged = mergeTranscriptWithBuffer(transcript, buffer, speaker);
  const t = merged.trim();
  const words = t.split(/\s+/).filter(Boolean);

  if (!t) {
    return { wait: true, reason: 'empty transcript', action: 'wait_for_more_audio' };
  }

  if (isCompleteQuestion(t)) {
    return { wait: false, merged: t };
  }

  if (ORPHAN_TAIL_RE.test(transcript.trim()) && buffer.length === 0) {
    return {
      wait: true,
      reason: 'orphan comparative tail without buffer',
      action: 'clarification_needed',
    };
  }

  if (ORPHAN_TAIL_RE.test(transcript.trim()) && buffer.length > 0 && isCompleteQuestion(merged)) {
    return { wait: false, merged };
  }

  if (words.length < 3 && /^от\s+/iu.test(t)) {
    return {
      wait: true,
      reason: 'incomplete comparative question',
      action: 'wait_for_more_audio',
    };
  }

  if (INCOMPLETE_HEAD_RES.some((re) => re.test(t))) {
    return {
      wait: true,
      reason: 'incomplete comparative question',
      action: 'wait_for_more_audio',
    };
  }

  if (words.length < 3 && buffer.length > 0) {
    return {
      wait: true,
      reason: 'short fragment with active buffer',
      action: 'wait_for_more_audio',
    };
  }

  return { wait: false, merged: t };
}
