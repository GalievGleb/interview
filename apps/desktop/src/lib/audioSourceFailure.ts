import type { AudioSource } from './audioCapture';

export function audioSourceFailureMessage(
  failedSource: AudioSource,
  remainingSources: AudioSource[],
  label: string,
  message: string,
): string {
  if (failedSource === 'system' && remainingSources.includes('mic')) return '';
  const explanation = /^error starting capture$/i.test(message.trim())
    ? 'Не удалось начать захват звука. Проверьте разрешение на запись экрана и системного звука, затем перезапустите SkillCue.'
    : message;
  return `${label}: ${explanation}`;
}
