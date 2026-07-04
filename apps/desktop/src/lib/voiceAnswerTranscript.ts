export interface VoiceAnswerTranscript {
  accept(text: string, isFinal: boolean): string;
  flush(): string;
  reset(): void;
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const LONG_FILLER_RE = /(^|[\s.,!?;:])(?:м{4,}|э{4,}|е{4,}|m{4,}|uh{3,}|um{3,})(?=$|[\s.,!?;:])/gi;
const RECORDING_COMPLAINT_RE =
  /(меня\s+не\s+записыва|не\s+записыва(?:ет|лось)|запись\s+не\s+ид[её]т|микрофон\s+не\s+работ|не\s+слышно|всем\s+проблем|в\s*ч[её]м\s+проблем)/i;

function isMicCheckChunk(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[.,!?;:()[\]{}"«»]/g, ' ')
    .replace(/[-–—]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < 2) return false;
  const micTokens = words.filter((w) => w === 'раз' || /^(?:м{3,}|э{3,}|е{3,}|m{3,})$/.test(w));
  return micTokens.length === words.length && words.length >= 2;
}

function cleanChunk(chunk: string): string {
  const value = compact(chunk.replace(LONG_FILLER_RE, '$1'));
  if (!value) return '';
  if (RECORDING_COMPLAINT_RE.test(value)) return '';
  if (isMicCheckChunk(value)) return '';
  return value;
}

export function cleanVoiceAnswerTranscriptText(text: string): string {
  const value = compact(text);
  if (!value) return '';
  const chunks = value.split(/(?<=[.!?])\s+/);
  return compact(chunks.map(cleanChunk).filter(Boolean).join(' ')).replace(/\s+([.,!?;:])/g, '$1');
}

export function createVoiceAnswerTranscript(): VoiceAnswerTranscript {
  let committed = '';
  let partial = '';

  const visible = () => cleanVoiceAnswerTranscriptText([committed, partial].filter(Boolean).join(' '));

  return {
    accept(text: string, isFinal: boolean): string {
      const value = compact(text);
      if (!value) return visible();

      if (isFinal) {
        committed = cleanVoiceAnswerTranscriptText([committed, value].filter(Boolean).join(' '));
        partial = '';
        return committed;
      }

      partial = value;
      return visible();
    },

    flush(): string {
      if (partial) {
        committed = cleanVoiceAnswerTranscriptText([committed, partial].filter(Boolean).join(' '));
        partial = '';
      }
      committed = cleanVoiceAnswerTranscriptText(committed);
      return committed;
    },

    reset(): void {
      committed = '';
      partial = '';
    },
  };
}

export function flushVoiceAnswerTranscript(acc: VoiceAnswerTranscript): string {
  return acc.flush();
}
