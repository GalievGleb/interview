import { describe, it, expect } from 'vitest';
import { LiveDebugRecorder, encodeWav, sanitizeDebugBundle } from './liveDebugRecorder';

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
  it('retains the newest 1,000 events and reports exact dropped and total counts', () => {
    const rec = new LiveDebugRecorder();
    rec.start(16000);
    for (let index = 0; index < 1005; index += 1) {
      rec.event('partial', { reason: `event-${index}` });
    }

    const bundle = rec.buildJson(null);
    expect(bundle.schemaVersion).toBe(2);
    expect(bundle.events).toHaveLength(1000);
    expect(bundle.events[0].reason).toBe('event-5');
    expect(bundle.events.at(-1)?.reason).toBe('event-1004');
    expect(bundle.retention?.events).toEqual({
      limit: 1000,
      retained: 1000,
      dropped: 6,
      total: 1006,
    });
  });

  it('recursively removes unsafe payloads and secret-like keys from schema-v2 JSON', () => {
    const rec = new LiveDebugRecorder();
    rec.start(16000);
    rec.event('error', {
      reason: 'Bearer abc.def.ghi',
      meta: {
        screenshot: 'data:image/png;base64,QUJD',
        XSkillCueToken: 'transport-secret',
        requestContext: 'event-context-secret',
        queueDepth: 2,
        nested: {
          cookie: 'sid=secret',
          authorization: 'Bearer top-secret',
          apiKey: 'sk-or-v1-1234567890abcdefghijklmnopqrstuvwxyz',
        },
      },
    });

    const serialized = JSON.stringify(rec.buildJson(null, {
      context: 'raw interview context',
      image: 'data:image/jpeg;base64,QUJD',
      requestContext: 'must not survive',
      cookieJar: { sid: 'cookie-value' },
      authHeaders: { authorization: 'Basic abc123' },
      unknownNested: { surprise: 'must not survive either' },
      token: 'generic-token-value',
      privateKey: 'private-key-value',
      licenseKey: 'license-key-value',
      rawPayload: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=',
      safe: { queueDepth: 1 },
    }));
    const lowered = serialized.toLowerCase();
    expect(lowered).not.toContain('data:image');
    expect(lowered).not.toContain(';base64,');
    expect(lowered).not.toContain('screenshot');
    expect(lowered).not.toContain('"cookie"');
    expect(lowered).not.toContain('"authorization"');
    expect(lowered).not.toContain('"apikey"');
    expect(lowered).not.toContain('raw interview context');
    expect(lowered).not.toContain('must not survive');
    expect(lowered).not.toContain('cookie-value');
    expect(lowered).not.toContain('abc123');
    expect(lowered).not.toContain('generic-token-value');
    expect(lowered).not.toContain('private-key-value');
    expect(lowered).not.toContain('license-key-value');
    expect(lowered).not.toContain('qujdrevgr0hjsktmtu5puffsu1rvvldywvo');
    expect(lowered).not.toContain('abc.def.ghi');
    expect(lowered).not.toContain('transport-secret');
    expect(lowered).not.toContain('event-context-secret');
    expect(lowered).not.toContain('unknownnested');
    expect(serialized).toContain('"queueDepth":2');
    expect(serialized).not.toContain('"safe"');
  });

  it('recomputes retained counters from the sanitized arrays without trusting claimed counts', () => {
    const sanitized = sanitizeDebugBundle({
      schemaVersion: 2,
      events: [
        { tMs: 1, type: 'partial', text: 'kept' },
        { tMs: 2, type: 'unknown-event', text: 'rejected' },
      ],
      extra: { screenAssists: [{ id: 'screen-1', status: 'done' }, { screenshot: 'bad' }] },
      retention: {
        events: { retained: 999, dropped: 4, total: 1003 },
        screenAssists: { retained: 40, dropped: 2, total: 42 },
      },
    });

    expect(sanitized.retention).toEqual({
      events: { limit: 1000, retained: 1, dropped: 5, total: 1003 },
      screenAssists: { limit: 40, retained: 1, dropped: 3, total: 42 },
    });
  });

  it('counts sanitizer trimming while retaining the newest 1000 events and 40 screens', () => {
    const sanitized = sanitizeDebugBundle({
      schemaVersion: 2,
      events: Array.from({ length: 1005 }, (_, index) => ({
        tMs: index, type: 'partial', reason: `event-${index}`,
      })),
      extra: {
        screenAssists: Array.from({ length: 45 }, (_, index) => ({
          id: `screen-${index}`, generation: index, status: 'done',
        })),
      },
      retention: {
        events: { retained: 1005, dropped: 0, total: 1005 },
        screenAssists: { retained: 45, dropped: 0, total: 45 },
      },
    });

    expect(sanitized.events[0].reason).toBe('event-5');
    expect(sanitized.events.at(-1)?.reason).toBe('event-1004');
    expect((sanitized.extra?.screenAssists as Array<{ id: string }>)[0].id).toBe('screen-5');
    expect(sanitized.retention).toEqual({
      events: { limit: 1000, retained: 1000, dropped: 5, total: 1005 },
      screenAssists: { limit: 40, retained: 40, dropped: 5, total: 45 },
    });
  });

  it('redacts arbitrary MIME data URLs from allowed diagnostic text fields', () => {
    const rec = new LiveDebugRecorder();
    rec.start(16000);
    rec.event('error', { reason: 'data:text/plain;base64,c2VjcmV0LXRleHQ=' });
    const serialized = JSON.stringify(rec.buildJson(null, {
      screenAssists: [{
        id: 'screen-data', generation: 1, status: 'done',
        answer: 'data:application/json;base64,eyJ0b2tlbiI6InNlY3JldCJ9',
      }],
    }));
    expect(serialized).not.toMatch(/data:text|data:application|c2VjcmV0|eyJ0b2tlbi/i);
    expect(serialized).toContain('[OMITTED_DATA_URL]');
  });

  it('redacts complete data URLs regardless of encoding or MIME type', () => {
    const payloads = [
      'data:text/plain,secret-token',
      'data:image/svg+xml,%3Csvg%20onload%3Dalert(1)%3E',
      'data:application/json,%7B%22token%22%3A%22secret%22%7D',
    ];
    const sanitized = sanitizeDebugBundle({
      schemaVersion: 2,
      events: payloads.map((reason, index) => ({ tMs: index, type: 'error', reason })),
      extra: {
        screenAssists: payloads.map((answer, index) => ({
          id: `data-screen-${index}`, generation: index, status: 'done', answer,
        })),
      },
    });
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toMatch(/data:|secret-token|%3Csvg|%7B%22token/i);
    expect(serialized.match(/\[OMITTED_DATA_URL\]/g)).toHaveLength(6);
  });

  it('preserves ordinary words containing data colon when no data URL comma exists', () => {
    const ordinary = 'metadata:model=actual userdata:value ordinary data science';
    const sanitized = sanitizeDebugBundle({
      schemaVersion: 2,
      events: [{ tMs: 1, type: 'error', reason: ordinary }],
      extra: {
        screenAssists: [{
          id: 'ordinary-data', generation: 1, status: 'done', answer: ordinary,
        }],
      },
    });
    expect(sanitized.events[0].reason).toBe(ordinary);
    expect((sanitized.extra?.screenAssists as Array<{ answer: string }>)[0].answer)
      .toBe(ordinary);
  });

  it('validates all screen records before retaining the newest 40 valid entries', () => {
    const valid = Array.from({ length: 45 }, (_, index) => ({
      id: `valid-screen-${index}`, generation: index, status: 'done',
    }));
    const invalidTail = Array.from({ length: 5 }, (_, index) => ({
      generation: 45 + index, status: 'done', screenshot: `invalid-${index}`,
    }));
    const sanitized = sanitizeDebugBundle({
      schemaVersion: 2,
      events: [],
      extra: { screenAssists: [...valid, ...invalidTail] },
      retention: {
        events: { retained: 0, dropped: 0, total: 0 },
        screenAssists: { retained: 50, dropped: 0, total: 50 },
      },
    });
    const screens = sanitized.extra?.screenAssists as Array<{ id: string }>;
    expect(screens).toHaveLength(40);
    expect(screens[0].id).toBe('valid-screen-5');
    expect(screens.at(-1)?.id).toBe('valid-screen-44');
    expect(sanitized.retention?.screenAssists).toEqual({
      limit: 40, retained: 40, dropped: 10, total: 50,
    });
  });

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

  it('stores physical source at the top level for source health transitions', () => {
    const rec = new LiveDebugRecorder();
    rec.start(16000);
    rec.event('source_warning', {
      source: 'system',
      reason: 'system_no_signal_after_mic_speech',
    });
    rec.event('source_recovered', { source: 'system' });

    expect(rec.buildJson(null).events.slice(-2)).toMatchObject([
      { type: 'source_warning', source: 'system' },
      { type: 'source_recovered', source: 'system' },
    ]);
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
