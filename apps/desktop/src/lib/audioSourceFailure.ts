import type { AudioSource } from './audioCapture';

export function audioSourceFailureMessage(
  failedSource: AudioSource,
  remainingSources: AudioSource[],
  label: string,
  message: string,
): string {
  if (failedSource === 'system' && remainingSources.includes('mic')) return '';
  return `${label}: ${message}`;
}
