import { describe, expect, it } from 'vitest';
import { audioSourceFailureMessage } from './audioSourceFailure';

describe('audio source failure presentation', () => {
  it('keeps a microphone-backed call usable when optional system capture fails', () => {
    expect(audioSourceFailureMessage(
      'system',
      ['mic'],
      'Системный звук',
      'Error starting capture',
    )).toBe('');
  });

  it('keeps a fatal message when no other source remains', () => {
    expect(audioSourceFailureMessage(
      'system',
      [],
      'Системный звук',
      'Error starting capture',
    )).toBe('Системный звук: Error starting capture');
  });
});
