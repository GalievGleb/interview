export function selectForceTargetSource(
  sources: {
    mic: boolean;
    system: boolean;
  },
  speaking: {
    mic: boolean;
    system: boolean;
  } = { mic: false, system: false },
  unconsumed: {
    mic: number;
    system: number;
  } = { mic: 0, system: 0 },
): 'mic' | 'system' | null {
  const micSpeaking = sources.mic && speaking.mic;
  const systemSpeaking = sources.system && speaking.system;
  if (micSpeaking !== systemSpeaking) return micSpeaking ? 'mic' : 'system';
  if (systemSpeaking) return 'system';
  if (sources.system && unconsumed.system > 0) return 'system';
  if (sources.mic && unconsumed.mic > 0) return 'mic';
  if (sources.system) return 'system';
  if (sources.mic) return 'mic';
  return null;
}
