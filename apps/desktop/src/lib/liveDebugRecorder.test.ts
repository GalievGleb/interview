import { describe, it, expect } from 'vitest';
import { LiveDebugRecorder, encodeWav } from './liveDebugRecorder';

function pcmFrame(values: number[]): ArrayBuffer {
  return new Int16Array(values).buffer;
}

describe('encodeWav', () => {
  it('writes a valid 16-bit mono WAV header', async () => {
    const blob = encodeWav(new Int16Array([0, 1000, -1000, 32767]), 16000);
    const buf = new DataView(await blob.arrayBuffer());
    const str = (pos: number, n: number) =>
      String.fromCharCode(...Array.from({ length: n }, (_, i) => buf.getUint8(pos + i)));
    expect(str(0, 4)).toBe('RIFF');
    expect(str(8, 4)).toBe('WAVE');
    expect(buf.getUint16(22, true)).toBe(1); // mono
    expect(buf.getUint32(24, true)).toBe(16000); // sample rate
    expect(buf.getUint16(34, true)).toBe(16); // bits/sample
    expect(buf.getUint32(40, true)).toBe(8); // data bytes = 4 samples * 2
  });
});

describe('LiveDebugRecorder', () => {
  it('records a timeline and exposes hasData', () => {
    const rec = new LiveDebugRecorder();
    expect(rec.hasData()).toBe(false);
    rec.start(16000);
    rec.event('speech_started', { speaker: 'me' });
    rec.event('final', { text: 'Что такое тестирование?', speaker: 'me' });
    expect(rec.hasData()).toBe(true);
    const bundle = rec.buildJson(null);
    expect(bundle.events[0].type).toBe('session_start');
    expect(bundle.events.some((e) => e.type === 'final')).toBe(true);
    expect(bundle.events.every((e) => typeof e.tMs === 'number' && e.tMs >= 0)).toBe(true);
  });

  it('accumulates audio into a WAV', () => {
    const rec = new LiveDebugRecorder();
    rec.start(16000);
    rec.audioFrame(pcmFrame([1, 2, 3]));
    rec.audioFrame(pcmFrame([4, 5]));
    const wav = rec.buildWav();
    expect(wav).not.toBeNull();
    expect(wav!.type).toBe('audio/wav');
    // 44-byte header + 5 samples * 2 bytes
    expect(wav!.size).toBe(44 + 10);
  });

  it('returns null WAV when no audio captured', () => {
    const rec = new LiveDebugRecorder();
    rec.start(16000);
    rec.event('final', { text: 'hi' });
    expect(rec.buildWav()).toBeNull();
  });

  it('ignores events before start', () => {
    const rec = new LiveDebugRecorder();
    rec.event('final', { text: 'orphan' });
    expect(rec.hasData()).toBe(false);
  });
});
