export interface VoiceAnswerTranscript {
  accept(text: string, isFinal: boolean): string;
  flush(): string;
  reset(): void;
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function createVoiceAnswerTranscript(): VoiceAnswerTranscript {
  let committed = '';
  let partial = '';

  const visible = () => compact([committed, partial].filter(Boolean).join(' '));

  return {
    accept(text: string, isFinal: boolean): string {
      const value = compact(text);
      if (!value) return visible();

      if (isFinal) {
        committed = compact([committed, value].filter(Boolean).join(' '));
        partial = '';
        return committed;
      }

      partial = value;
      return visible();
    },

    flush(): string {
      if (partial) {
        committed = compact([committed, partial].filter(Boolean).join(' '));
        partial = '';
      }
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
