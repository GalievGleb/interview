# Realtime STT Latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream live interview audio to OpenAI during speech so `Ctrl+Enter` commits an already-uploaded turn instead of uploading and retranscribing a WAV file.

**Architecture:** The desktop keeps its existing local `/stt/stream` contract. A feature-flagged Python runner forwards PCM to a licensed NestJS WebSocket gateway, which holds the OpenAI key, relays only the allowed Realtime transcription events, and meters received audio. The current HTTP/WAV provider remains the automatic fallback. Realtime became the default only after the real-audio acceptance gates passed.

**Tech Stack:** Python 3.11+, FastAPI, asyncio, `websockets`, NestJS 11, `@nestjs/platform-ws`, `ws`, OpenAI Realtime transcription, pytest, Node test runner, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-28-realtime-stt-latency.md`

## Global Constraints

- Feature flag is exactly `SKILLCUE_REALTIME_STT`; its accepted dev default is enabled and it can still be set to `0` for immediate fallback.
- The selected Realtime model is `gpt-4o-mini-transcribe`; it beat `gpt-live-transcribe` and `gpt-4o-transcribe` on the same real PCM benchmark.
- OpenAI credentials remain only on the gateway.
- The existing `gpt-4o-mini-transcribe` HTTP/WAV path is retained without destructive refactoring.
- The Ozon four-second p95 gate is not relaxed.

---

### Task 1: Gateway Realtime protocol and quota-safe WebSocket

**Files:**
- Create: `apps/api/src/gateway/gateway-stt-realtime.gateway.ts`
- Create: `apps/api/src/gateway/gateway-stt-realtime.protocol.ts`
- Create: `apps/api/src/gateway/gateway-stt-realtime.test.ts`
- Modify: `apps/api/src/gateway/gateway.module.ts`
- Modify: `apps/api/src/gateway-main.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: signed license from `GatewayService.authorize`, quota methods from `GatewaySttQuotaService`, OpenAI API key/base URL from `resolveManagedSttCredentials`.
- Produces: `/gateway/stt/stream`; binary PCM input plus `commit`/`bind_force` controls; `ready`, `turn_committed`, `transcript_delta`, `transcript_completed`, and sanitized `error` output events.

- [x] Write tests asserting the exact `session.update` transcription payload, allowed client controls, commit-to-`item_id` correlation, and byte-derived duration.
- [x] Run the focused protocol test red before implementation.
- [x] Implement the pure protocol helpers and rerun the focused test to green.
- [x] Write a failing gateway lifecycle test using fake downstream/upstream sockets.
- [x] Implement the WebSocket gateway with license authentication, quota admission, upstream cleanup, sanitized errors, and duration recording.
- [x] Register the `WsAdapter`, gateway provider, and explicit dependencies; regenerate the lockfile mechanically.
- [x] Run all compiled gateway tests (29/29) and `pnpm --dir apps/api build`.

### Task 2: Python Realtime runner with exact fallback boundary

**Files:**
- Create: `apps/api-py/app/services/stt/openai_realtime_stream.py`
- Create: `apps/api-py/tests/test_stt_openai_realtime.py`
- Modify: `apps/api-py/app/config.py`
- Modify: `apps/api-py/app/routers/stt.py`
- Modify: `apps/api-py/requirements.txt`

**Interfaces:**
- Consumes: local desktop WebSocket frames, `Endpointer`, `quality_gate`, gateway license/root helpers, and `SKILLCUE_REALTIME_STT`.
- Produces: the unchanged desktop events `ready`, `speech_started`, `transcript`, `utterance_end`, `low_quality`, `force_empty`, and `transcription_error`; raises `RealtimeUnavailable` only when the router should start the legacy runner.

- [x] Write failing tests for stateful 16/44.1/48 kHz to 24 kHz resampling, audio transmission before commit, automatic commit, forced commit, binding a force id to an in-flight turn, and `item_id` reconciliation.
- [x] Run the focused Realtime test red before implementation.
- [x] Implement the transport/turn tracker/runner and make the focused tests green.
- [x] Test router selection, explicit opt-out, and setup-failure fallback to `run_openai_mini_stream` on the same client WebSocket.
- [x] Add config and router selection, then rerun the focused tests.
- [x] Run the complete targeted STT/router/chat test set (94/94) plus Ruff.

### Task 3: Build, real-audio A/B, and safe decision

**Files:**
- Modify only if required by observed failures: `tools/real_interview_acceptance.py`
- Create ignored reports under: `output/interview-replay/`

**Interfaces:**
- Consumes: installed dev backend, private real-interview manifest, deployed feature-flagged gateway.
- Produces: privacy-safe latency/quality reports containing no transcripts, answers, source paths, or credentials.

- [x] Build the gateway and frozen dev backend without changing the public release version.
- [x] Deploy the gateway only after unit/build checks passed; verify `/health` and the legacy STT endpoint remain healthy.
- [x] Run Ozon once as a smoke test, then ten Realtime repetitions and preserve a separate report.
- [x] Run Lamoda and PositiveTech screen cases to confirm no routing regression.
- [x] Compare transcript concepts, answer concepts, empty/truncated counts, p50/p95 latency, and fallback events against the preserved baseline.
- [x] Enable Realtime by default only after all gates passed; retain `SKILLCUE_REALTIME_STT=0` and the legacy transport as rollback/fallback.

## Accepted result

- Ozon: 10/10 correct; p95 trigger-to-first-answer 3,375 ms (baseline 5,203 ms).
- User-provided test-design WAV: 10/10 during tuning, then 3/3 through the final installed frozen backend with no enabling environment variable; final p95 3,437 ms.
- Screen regressions: Lamoda API and PositiveTech Python cases passed.
- Installed dev backend backup: `C:\Users\gleb\AppData\Local\Programs\skillcue-dev\resources\backend-before-realtime-20260828-223447`.
