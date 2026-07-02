import { questionChanged } from './normalizeTranscript';

export function shouldQueueIncomingAnswer(activeQuestion: string, incomingQuestion: string): boolean {
  const active = activeQuestion.trim();
  const incoming = incomingQuestion.trim();
  if (!active || !incoming) return false;
  return questionChanged(active, incoming);
}
