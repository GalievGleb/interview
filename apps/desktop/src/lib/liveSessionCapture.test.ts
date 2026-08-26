import { describe, expect, it } from 'vitest';
import {
  AUDIO_SIGNAL_SAMPLE_INTERVAL_MS,
  PCM16_SIGNAL_RMS_THRESHOLD,
  analyzePcm16Signal,
  createAudioSignalSampler,
} from './audioCapture';
import {
  captureIsStale,
  parseSttTranscriptMetadata,
  recoverableSttErrorMessage,
  sendFinalizeControl,
} from './liveSession';

// Захват из ws.onopen осиротеет, если за время асинхронного startCapture
// сессию остановили или ws пересоздали при реконнекте. Такой захват (микрофон/
// экран) обязан быть погашен, иначе останется включён навсегда.
const OPEN = 1; // WebSocket.OPEN
const CLOSED = 3;
const openWs = (state = OPEN) => ({ readyState: state }) as unknown as WebSocket;

describe('captureIsStale', () => {
  it('НЕ устарел: та же открытая ws, сессия жива', () => {
    const ws = openWs();
    expect(captureIsStale(false, ws, ws)).toBe(false);
  });

  it('устарел: сессию остановили за время await', () => {
    const ws = openWs();
    expect(captureIsStale(true, ws, ws)).toBe(true);
  });

  it('устарел: ws пересоздан (реконнект) — currentWs !== myWs', () => {
    const myWs = openWs();
    const newWs = openWs();
    expect(captureIsStale(false, newWs, myWs)).toBe(true);
  });

  it('устарел: моя ws уже закрылась', () => {
    const ws = openWs(CLOSED);
    expect(captureIsStale(false, ws, ws)).toBe(true);
  });

  it('устарел: currentWs стал null (cleanup)', () => {
    const myWs = openWs();
    expect(captureIsStale(false, null, myWs)).toBe(true);
  });

  it('устарел: пользователь поставил live-захват на паузу', () => {
    const ws = openWs();
    expect(captureIsStale(false, ws, ws, true)).toBe(true);
  });

  it('устарел: кадр относится к предыдущей эпохе захвата', () => {
    const ws = openWs();
    expect(captureIsStale(false, ws, ws, false, 2, 1)).toBe(true);
  });
});

describe('recoverable STT errors', () => {
  it('keeps a transient provider 500 out of the fatal socket path', () => {
    expect(
      recoverableSttErrorMessage(
        'OpenAI Mini STT 500: {"statusCode":500,"message":"Internal server error"}',
      ),
    ).toContain('Продолжаю слушать');
  });

  it('does not hide authentication or configuration errors', () => {
    expect(recoverableSttErrorMessage('SkillCue license is unavailable')).toBeNull();
  });
});

describe('sendFinalizeControl', () => {
  it('returns true only when finalize was sent to an open socket', () => {
    const sent: string[] = [];
    const ws = {
      readyState: OPEN,
      send: (value: string) => sent.push(value),
    } as unknown as WebSocket;

    expect(sendFinalizeControl(ws, 'force-1')).toBe(true);
    expect(sent).toEqual([JSON.stringify({ type: 'finalize', request_id: 'force-1' })]);
  });

  it('returns false for a closed or missing socket', () => {
    expect(sendFinalizeControl(openWs(CLOSED), 'force-1')).toBe(false);
    expect(sendFinalizeControl(null, 'force-1')).toBe(false);
  });
});

describe('transcript metadata', () => {
  it('maps the server freshness fields into the client transcript contract', () => {
    expect(
      parseSttTranscriptMetadata({
        force_request_id: 'force-7',
        utterance_id: 'utterance-9',
        captured_at_ms: 123_456,
        queueWaitMs: 780,
        queueDepth: 2,
        speechEndToFinalMs: 910,
        openaiInferenceMs: 640,
      }),
    ).toEqual({
      forceRequestId: 'force-7',
      utteranceId: 'utterance-9',
      capturedAtMs: 123_456,
      queueWaitMs: 780,
      queueDepth: 2,
      speechEndToFinalMs: 910,
      openaiInferenceMs: 640,
    });
  });

  it('keeps legacy transcript events working and drops invalid numeric metadata', () => {
    expect(parseSttTranscriptMetadata({ force_request_id: 'legacy-force' })).toEqual({
      forceRequestId: 'legacy-force',
      utteranceId: undefined,
      capturedAtMs: undefined,
      queueWaitMs: undefined,
      queueDepth: undefined,
      speechEndToFinalMs: undefined,
      openaiInferenceMs: undefined,
    });
    expect(
      parseSttTranscriptMetadata({
        captured_at_ms: Number.POSITIVE_INFINITY,
        queueWaitMs: 'not-a-number',
        queueDepth: Number.NaN,
        speechEndToFinalMs: 'wrong',
        openaiInferenceMs: Number.NEGATIVE_INFINITY,
      }),
    ).toMatchObject({
      capturedAtMs: undefined,
      queueWaitMs: undefined,
      queueDepth: undefined,
      speechEndToFinalMs: undefined,
      openaiInferenceMs: undefined,
    });
  });
});

describe('PCM16 signal metadata', () => {
  it('distinguishes literal silence from a non-silent frame with normalized levels', () => {
    const silence = analyzePcm16Signal(new Int16Array([0, 0, 0, 0]), 10_000);
    const signal = analyzePcm16Signal(
      new Int16Array([0, 16_384, -16_384, 0]),
      10_250,
    );

    expect(silence).toEqual({
      capturedAtMs: 10_000,
      rms: 0,
      peak: 0,
      hasSignal: false,
    });
    expect(signal.capturedAtMs).toBe(10_250);
    expect(signal.rms).toBeCloseTo(Math.sqrt(0.125), 6);
    expect(signal.peak).toBeCloseTo(0.5, 6);
    expect(signal.rms).toBeGreaterThan(PCM16_SIGNAL_RMS_THRESHOLD);
    expect(signal.hasSignal).toBe(true);
  });

  it('uses the literal PCM value below, at, and above the named RMS threshold', () => {
    const below = analyzePcm16Signal(new Int16Array([511, -511]), 30_000);
    const exact = analyzePcm16Signal(new Int16Array([512, -512]), 30_001);
    const above = analyzePcm16Signal(new Int16Array([513, -513]), 30_002);
    const empty = analyzePcm16Signal(new Int16Array(), 30_003);

    expect(PCM16_SIGNAL_RMS_THRESHOLD).toBe(512 / 32_768);
    expect(below.hasSignal).toBe(false);
    expect(exact.rms).toBe(PCM16_SIGNAL_RMS_THRESHOLD);
    expect(exact.hasSignal).toBe(true);
    expect(above.hasSignal).toBe(true);
    expect(empty).toEqual({ capturedAtMs: 30_003, rms: 0, peak: 0, hasSignal: false });
  });

  it('samples level computation immediately and then at the named throttle interval', () => {
    const sample = createAudioSignalSampler();
    const pcm = new Int16Array([0, 16_384, -16_384, 0]);

    expect(sample(pcm, 20_000)?.hasSignal).toBe(true);
    expect(sample(pcm, 20_000 + AUDIO_SIGNAL_SAMPLE_INTERVAL_MS - 1)).toBeUndefined();
    expect(sample(pcm, 20_000 + AUDIO_SIGNAL_SAMPLE_INTERVAL_MS)?.capturedAtMs).toBe(
      20_000 + AUDIO_SIGNAL_SAMPLE_INTERVAL_MS,
    );
  });
});
