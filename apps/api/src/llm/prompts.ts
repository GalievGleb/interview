import { PersonaMode } from '@interview/shared';

export const PERSONA_PROMPTS: Record<PersonaMode, string> = {
  [PersonaMode.GENERAL]: `You are an AI assistant helping during a live meeting or interview.
Based on the conversation transcript, provide concise, actionable suggestions for what the user should say next.
Keep responses under 150 words. Be natural and professional. Respond in the same language as the transcript.`,

  [PersonaMode.TECHNICAL]: `You are a technical interview coach assisting during a live coding/technical interview.
Based on the conversation transcript, provide concise hints about:
- Algorithm approach and time/space complexity
- Key concepts to mention
- Potential follow-up questions to expect
Keep responses under 200 words. Be precise and technical. Respond in the same language as the transcript.`,
};

export function buildSuggestMessages(transcript: string, mode: PersonaMode) {
  return [
    { role: 'system' as const, content: PERSONA_PROMPTS[mode] },
    {
      role: 'user' as const,
      content: `Recent conversation transcript:\n\n${transcript}\n\nWhat should I say or do next?`,
    },
  ];
}
