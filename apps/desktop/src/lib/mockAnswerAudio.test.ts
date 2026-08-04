import { describe, expect, it, vi } from 'vitest';
import {
  MAX_MOCK_ANSWER_HINTS,
  MAX_MOCK_ANSWER_SECONDS,
  buildMockAnswerGuidance,
  encodePcm16MonoWav,
  mockAnswerMicConstraints,
  startMockAnswerRecording,
} from './mockAnswerAudio';

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return new TextDecoder('ascii').decode(bytes.slice(start, start + length));
}

describe('mock answer audio', () => {
  it('captures mock audio without browser speech processing', () => {
    expect(mockAnswerMicConstraints('')).toMatchObject({
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
    expect(MAX_MOCK_ANSWER_SECONDS).toBe(120);
  });

  it('keeps the native sample rate and combines every PCM chunk into one WAV', async () => {
    const pcmA = new Int16Array([100, -100, 200]);
    const pcmB = new Int16Array([-200, 300]);

    const blob = encodePcm16MonoWav(
      [pcmA.buffer as ArrayBuffer, pcmB.buffer as ArrayBuffer],
      48_000,
    );
    const wav = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(wav.buffer);

    expect(blob.type).toBe('audio/wav');
    expect(ascii(wav, 0, 4)).toBe('RIFF');
    expect(ascii(wav, 8, 4)).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(pcmA.byteLength + pcmB.byteLength);
    expect(Array.from(wav.slice(44))).toEqual([
      ...Array.from(new Uint8Array(pcmA.buffer)),
      ...Array.from(new Uint8Array(pcmB.buffer)),
    ]);
  });

  it('deduplicates question terms and supplies bounded QA keywords', () => {
    const result = buildMockAnswerGuidance(
      'Что проверяете в API JSON-ответе кроме status code 200 и schema?',
      ['Python', 'API', 'JSON'],
    );

    expect(result.question).toBe(
      'Что проверяете в API JSON-ответе кроме status code 200 и schema?',
    );
    expect(result.hints).toEqual(
      expect.arrayContaining(['API', 'JSON', 'status', 'code', 'schema', 'Python', 'pytest']),
    );
    expect(new Set(result.hints.map((value) => value.toLocaleLowerCase())).size).toBe(
      result.hints.length,
    );
    expect(result.hints.length).toBeLessThanOrEqual(MAX_MOCK_ANSWER_HINTS);
    expect(result.hints.every((value) => value.length <= 64)).toBe(true);
  });

  it('compacts and bounds question context without altering its words', () => {
    const longQuestion = `  Как   тестируете API? ${'x'.repeat(2_000)}  `;

    const result = buildMockAnswerGuidance(longQuestion, []);

    expect(result.question.startsWith('Как тестируете API? ')).toBe(true);
    expect(result.question.length).toBe(1_000);
    expect(result.question).not.toContain('  ');
  });

  it('releases the microphone if AudioContext creation fails', async () => {
    const stop = vi.fn();
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }),
      },
    });
    vi.stubGlobal('localStorage', { getItem: vi.fn().mockReturnValue(null) });
    vi.stubGlobal(
      'AudioContext',
      class BrokenAudioContext {
        constructor() {
          throw new Error('audio context unavailable');
        }
      },
    );

    try {
      await expect(startMockAnswerRecording()).rejects.toThrow('audio context unavailable');
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
