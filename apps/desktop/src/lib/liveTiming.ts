/**
 * Pure timing/latency helpers for the live copilot. Extracted from
 * useLiveCopilot so the logic that caused two subtle latency bugs (session-anchor
 * inflation; clobbered snapshots) is unit-testable in isolation.
 */

import type { SttTimings } from './liveSession';
import type { ExchangeLatency } from './interviewSessionExport';

// On-device STT (even large-v3 on CPU) finalises within a few seconds. A client
// fallback latency far above this is an anchoring artifact (silence gaps,
// filtered hallucinations), not a real measurement — drop it instead of logging
// a misleading 30–70s value.
export const MAX_PLAUSIBLE_STT_LATENCY_MS = 20000;

export function sanitizeSttLatencyMs(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  if (value > MAX_PLAUSIBLE_STT_LATENCY_MS) return undefined;
  return value;
}

/**
 * The REAL per-utterance STT latency (speech-end → final). Prefer the server's
 * measurement. A client final-arrival → LLM-dispatch delta is a different stage
 * and must never be relabelled as STT.
 */
export function computeExchangeSttLatencyMs(
  serverSpeechEndToFinalMs: number | undefined,
  _answerStartedAt: number,
  _questionFinalAt: number | null,
): number | null {
  if (serverSpeechEndToFinalMs == null) return null;
  return sanitizeSttLatencyMs(serverSpeechEndToFinalMs) ?? null;
}

/** Per-stage breakdown for the exchange (all relative to the utterance). */
export function buildLatencyBreakdown(input: {
  serverTimings: SttTimings | null;
  answerStartedAt: number;
  questionFinalAt: number | null;
  llmFirstTokenMs: number | undefined;
  llmLatencyMs: number;
  speechEndedAt: number | null;
  audioCaptureStartAt: number | null;
}): NonNullable<ExchangeLatency['breakdown']> {
  const st = input.serverTimings;
  return {
    speechEndToFinalMs: st?.speechEndToFinalMs,
    speechStartToFinalMs:
      st?.speechMs != null && st?.speechEndToFinalMs != null
        ? st.speechMs + st.speechEndToFinalMs
        : undefined,
    finalToAnswerStartMs:
      input.questionFinalAt != null ? input.answerStartedAt - input.questionFinalAt : undefined,
    llmFirstTokenMs: input.llmFirstTokenMs,
    llmTotalMs: input.llmLatencyMs,
    // Diagnostic only — wall-clock since the session started. Never STT latency.
    sessionElapsedToFinalMs:
      input.speechEndedAt != null && input.audioCaptureStartAt != null
        ? input.speechEndedAt - input.audioCaptureStartAt
        : undefined,
  };
}
