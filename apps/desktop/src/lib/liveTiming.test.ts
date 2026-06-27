import { describe, it, expect } from 'vitest';
import {
  computeExchangeSttLatencyMs,
  sanitizeSttLatencyMs,
  buildLatencyBreakdown,
  MAX_PLAUSIBLE_STT_LATENCY_MS,
} from './liveTiming';

describe('sanitizeSttLatencyMs', () => {
  it('keeps plausible values', () => {
    expect(sanitizeSttLatencyMs(444)).toBe(444);
    expect(sanitizeSttLatencyMs(0)).toBe(0);
  });
  it('drops implausible/negative/NaN', () => {
    expect(sanitizeSttLatencyMs(MAX_PLAUSIBLE_STT_LATENCY_MS + 1)).toBeUndefined();
    expect(sanitizeSttLatencyMs(113737)).toBeUndefined();
    expect(sanitizeSttLatencyMs(-5)).toBeUndefined();
    expect(sanitizeSttLatencyMs(NaN)).toBeUndefined();
  });
});

describe('computeExchangeSttLatencyMs', () => {
  it('prefers the server speech-end→final value', () => {
    // Even if the client delta is huge (session-anchor bug), the server wins.
    expect(computeExchangeSttLatencyMs(444, 120000, 0)).toBe(444);
  });
  it('falls back to a sane client delta when no server timing', () => {
    expect(computeExchangeSttLatencyMs(undefined, 5000, 4200)).toBe(800);
  });
  it('drops an implausible client fallback (the 24s/56s/113s bug)', () => {
    // questionFinalAt anchored at session start → absurd delta → undefined.
    expect(computeExchangeSttLatencyMs(undefined, 113737, 0)).toBeUndefined();
  });
  it('is undefined when there is nothing to measure', () => {
    expect(computeExchangeSttLatencyMs(undefined, 5000, null)).toBeUndefined();
  });
});

describe('buildLatencyBreakdown', () => {
  it('keeps session-elapsed separate from STT latency', () => {
    const b = buildLatencyBreakdown({
      serverTimings: { speechMs: 1400, speechEndToFinalMs: 444 },
      answerStartedAt: 24000,
      questionFinalAt: 23880,
      llmFirstTokenMs: 1500,
      llmLatencyMs: 3200,
      speechEndedAt: 24009,
      audioCaptureStartAt: 0,
    });
    expect(b.speechEndToFinalMs).toBe(444);
    expect(b.speechStartToFinalMs).toBe(1844);
    expect(b.finalToAnswerStartMs).toBe(120);
    expect(b.llmFirstTokenMs).toBe(1500);
    expect(b.llmTotalMs).toBe(3200);
    expect(b.sessionElapsedToFinalMs).toBe(24009); // diagnostic only
  });
  it('tolerates missing inputs', () => {
    const b = buildLatencyBreakdown({
      serverTimings: null,
      answerStartedAt: 1000,
      questionFinalAt: null,
      llmFirstTokenMs: undefined,
      llmLatencyMs: 2000,
      speechEndedAt: null,
      audioCaptureStartAt: null,
    });
    expect(b.speechEndToFinalMs).toBeUndefined();
    expect(b.llmTotalMs).toBe(2000);
  });
});
