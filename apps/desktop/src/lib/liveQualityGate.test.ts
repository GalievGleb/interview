import { describe, it, expect } from 'vitest';
import { resolveFollowUpQuestion, createEmptySessionContext } from '@interview/shared';
import { buildExchangeLatency } from './interviewSessionExport';

describe('follow-up resolution — explicit entity wins over previousTopic', () => {
  it('resolves «его» to Docker (current question), not previousTopic=API', () => {
    const ctx = createEmptySessionContext();
    ctx.lastCanonicalTopic = 'API';
    const q = 'Хорошо, ты говоришь, что Docker настраивал. Как ты его настраивал?';
    const r = resolveFollowUpQuestion({
      raw: q,
      corrected: q,
      intentCorrected: q,
      sessionContext: ctx,
    });
    expect(r.resolvedQuestion).toContain('Как ты Docker настраивал');
    expect(r.resolvedQuestion).not.toContain('API настраивал');
    expect(r.resolvedTopic).toBe('Docker');
  });

  it('still uses previousTopic when the current question has no explicit entity', () => {
    const ctx = createEmptySessionContext();
    ctx.lastCanonicalTopic = 'полиморфизм';
    const r = resolveFollowUpQuestion({
      raw: 'Как ты его применял в работе?',
      corrected: 'Как ты его применял в работе?',
      intentCorrected: 'Как ты его применял в работе?',
      sessionContext: ctx,
    });
    expect(r.resolvedQuestion.toLowerCase()).toContain('полиморфизм');
    expect(r.usedPreviousContext).toBe(true);
  });
});

describe('exchange latency — real STT latency, never session-elapsed', () => {
  it('persists the value it was given, unchanged (no inflation)', () => {
    // A fast utterance (answer_started showed ~444ms) must stay ~444ms once
    // persisted — never become a session-relative 24009/56622/113737ms.
    for (const fast of [444, 782, 950]) {
      const latency = buildExchangeLatency(fast, 3200);
      expect(latency.sttLatencyMs).toBe(fast);
      expect(latency.sttLatencyMs).toBeLessThan(1000);
    }
  });

  it('carries the optional per-stage breakdown', () => {
    const latency = buildExchangeLatency(444, 3200, {
      speechEndToFinalMs: 444,
      speechStartToFinalMs: 1800,
      finalToAnswerStartMs: 120,
      llmFirstTokenMs: 1500,
      llmTotalMs: 3200,
      sessionElapsedToFinalMs: 24009,
    });
    expect(latency.sttLatencyMs).toBe(444);
    expect(latency.breakdown?.speechEndToFinalMs).toBe(444);
    // The diagnostic session-elapsed lives in breakdown, NOT in sttLatencyMs.
    expect(latency.breakdown?.sessionElapsedToFinalMs).toBe(24009);
    expect(latency.sttLatencyMs).not.toBe(24009);
  });
});
