export interface VoiceAnswerSubmission {
  text: string;
  source: 'voice' | 'text';
}

export function resolveVoiceAnswerSubmission(
  voiceText: string | null,
  typedText: string,
): VoiceAnswerSubmission | null {
  if (voiceText === null) return null;
  if (voiceText.trim()) return { text: voiceText, source: 'voice' };
  if (typedText.trim()) return { text: typedText, source: 'text' };
  return null;
}
