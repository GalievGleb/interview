# Live Session Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure Ctrl+Enter always answers the freshest spoken turn or current screen, eliminate unbounded STT backlog, detect a silent system-audio channel, and export truthful session diagnostics.

**Architecture:** Replace the per-utterance FIFO with one active plus one coalesced pending STT turn, propagate capture identity/timing through the WebSocket, and make the desktop coordinator enforce freshness at the text/vision boundary. Add source health and screen diagnostics to the existing bounded session JSON rather than creating candidate `Answer` rows.

**Tech Stack:** Python 3.12/FastAPI/asyncio/httpx, React 18/TypeScript/Electron, Vitest, pytest.

**Spec:** `docs/superpowers/specs/2026-08-24-live-session-reliability.md`

## Global Constraints

- Preserve all pre-existing dirty-worktree changes; no reset, checkout, cleanup, commit, push, release, install, or live application launch.
- Follow strict RED→GREEN TDD for every behavior change and record the failing command/output before production edits.
- The current user explicitly authorized implementation in the existing `main` workspace; work in place because the uncommitted screen-task fixes cannot be moved safely without mutating user state.
- Do not persist screenshot pixels/base64 or generated screen answers as candidate answers.
- Keep the production runtime free of developer-only test controls.
- No answer older than 20 seconds by source capture time may trigger a text LLM.
- Screen fallback replacement window is 1,500 ms maximum and closes permanently at first screen output.

---

### Task 1: Bounded managed-STT scheduler

**Files:**
- Modify: `apps/api-py/app/services/stt/openai_mini_stream.py`
- Modify: `apps/api-py/app/services/stt/openai_transcribe.py`
- Test: `apps/api-py/tests/test_stt_openai_mini_only.py`

**Interfaces:**
- Produces WebSocket events with `utterance_id`, `captured_at_ms`, and timing fields `queueWaitMs`, `queueDepth`, `speechEndToFinalMs`, `openaiInferenceMs`.
- Consumes the existing `OpenAiMiniTranscribeProvider.transcribe_audio_file()` API unchanged.

- [ ] **Step 1: Write failing scheduler tests**

Add async tests using the real stream scheduler with a controlled provider which blocks its first call. Feed three completed VAD turns while blocked and assert only the first is in flight and the remaining turns become one pending coalesced request. Add a disconnect test asserting pending work is cancelled and no provider call starts after disconnect. Add a forced-final test asserting an old in-flight job is not rebound to a new request id.

- [ ] **Step 2: Run RED**

Run: `python -m pytest tests/test_stt_openai_mini_only.py -q`

Expected: new tests fail because one task is created per utterance, old jobs accept the force id, and disconnect drains every task.

- [ ] **Step 3: Implement the bounded scheduler**

Keep one worker task per WebSocket. Store one active job and one pending job. Merge new normal PCM into the pending job with a short PCM silence separator, earliest speech start, latest speech end, newest utterance id, and current queue depth. Forced fresh buffered audio replaces/augments the pending job and receives priority; never attach it to an active job older than the freshness limit. On disconnect set closed state, clear pending, cancel/await the worker, and never gather/drain queued jobs.

- [ ] **Step 4: Make gateway pacing cancellation-safe**

Ensure cancellation while waiting for the global managed-gateway slot releases the lock and does not advance `_gateway_next_request_at` without a completed request. Keep the upstream ten-starts/minute protection; do not simply remove pacing.

- [ ] **Step 5: Run GREEN**

Run: `python -m pytest tests/test_stt_openai_mini_only.py -q`

Expected: all STT tests pass; controlled provider call count proves the queue is bounded.

---

### Task 2: Freshness-safe Ctrl+Enter and screen authority

**Files:**
- Modify: `apps/desktop/src/lib/liveSession.ts`
- Modify: `apps/desktop/src/lib/latestForcedAnswer.ts`
- Modify: `apps/desktop/src/lib/latestForcedAnswer.test.ts`
- Modify: `apps/desktop/src/hooks/useLiveCopilot.ts`
- Modify: `apps/desktop/src/pages/OverlayPage.tsx`
- Modify: `apps/desktop/src/pages/OverlayPage.behavior.test.ts`

**Interfaces:**
- `LiveHandlers.onTranscript` receives a metadata object containing `utteranceId`, `capturedAtMs`, `queueWaitMs`, and `queueDepth`.
- `ForcedTranscriptLine` carries source capture time separately from delivery time.
- Coordinator exposes a screen-output commit action which permanently closes text replacement for that generation.

- [ ] **Step 1: Write failing coordinator tests**

Add literal-clock tests for: a tagged final 1,501 ms after screen fallback is ignored; a final inside the window may update the exact question only before screen output; first screen chunk closes replacement; a 21-second-old captured final never submits; unrelated results delivered 7.7 seconds apart are not merged when capture timestamps are outside the semantic turn.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @interview/desktop exec vitest run src/lib/latestForcedAnswer.test.ts src/pages/OverlayPage.behavior.test.ts`

Expected: late finals currently replace screen fallback and merging depends on `receivedAt`.

- [ ] **Step 3: Propagate STT identity/timing**

Parse new server event fields in `liveSession.ts`, append them to the forced ledger in `useLiveCopilot.ts`, and log capture age/queue depth. Preserve compatibility with an older backend by treating absent metadata as unknown; unknown results can update transcripts but cannot replace a committed screen answer.

- [ ] **Step 4: Enforce screen authority**

Track fallback start/deadline and screen-first-output. Allow same-generation question revision only before the deadline and before output. Cancelled/ignored stale finals remain visible in diagnostics but never call `askQuestion` and never cancel the owned screen request.

- [ ] **Step 5: Run GREEN**

Run the Task 2 Vitest command and expect all tests to pass with no added debounce on a fresh ready final.

---

### Task 3: Garbage gate, full question episode, and grounded technical answers

**Files:**
- Create: `apps/desktop/src/lib/forcedTranscriptQuality.ts`
- Create: `apps/desktop/src/lib/forcedTranscriptQuality.test.ts`
- Modify: `apps/desktop/src/lib/visualQuestion.ts`
- Modify: `apps/desktop/src/lib/visualQuestion.test.ts`
- Modify: `apps/desktop/src/hooks/useLiveCopilot.ts`
- Modify: `apps/api-py/app/routers/chat.py`
- Modify: `apps/api-py/app/services/domain_answer_hints.py`
- Test: `apps/api-py/tests/test_chat_review.py`

**Interfaces:**
- `assessForcedTranscript(text, language)` returns `{eligibleForText: boolean, reason?: string}`.
- Rejected forced text routes to the existing screen fallback, not to a text answer.

- [ ] **Step 1: Write failing desktop tests**

Cases: Russian session rejects `Hücum`, `No dobrze`, and a single unknown Latin word; accepts `SQL`, `API`, `Docker`, `Сколько?`, and a normal short Russian question. Visual routing must accept the exact fixture/order/assert wording from the report and a compound episode whose earlier clause mentions visible code.

- [ ] **Step 2: Run desktop RED**

Run: `pnpm --filter @interview/desktop exec vitest run src/lib/forcedTranscriptQuality.test.ts src/lib/visualQuestion.test.ts`

Expected: quality module is missing and exact report phrases are not visual.

- [ ] **Step 3: Implement deterministic forced-text gating**

Use script/language shape plus a small technical-token allowlist; do not reject short Cyrillic questions. Before `askQuestion`, reject stale or implausible forced text, log the reason, and retain/start screen fallback.

- [ ] **Step 4: Write failing API grounding tests**

Assert the fast technical path includes local domain/knowledge hints without a serial correction/model call. Add a regression for `В чём разница между sorted() и list.sort()?` requiring the prompt constraint that `sorted()` returns a new list and `list.sort()` mutates in place and returns `None`.

- [ ] **Step 5: Run API RED, implement, and run GREEN**

Run: `python -m pytest tests/test_chat_review.py -q`

Implement local deterministic hint injection in the fast path while preserving one provider call and current response-length budgets. Run both Task 3 test commands; expect green.

---

### Task 4: System-audio health and source-aware diagnostics

**Files:**
- Create: `apps/desktop/src/lib/liveSourceHealth.ts`
- Create: `apps/desktop/src/lib/liveSourceHealth.test.ts`
- Modify: `apps/desktop/src/lib/audioCapture.ts`
- Modify: `apps/desktop/src/lib/liveSession.ts`
- Modify: `apps/desktop/src/hooks/useLiveCopilot.ts`
- Modify: `apps/desktop/src/pages/OverlayPage.tsx`
- Modify: `apps/desktop/src/lib/i18n/ru.ts`
- Modify: `apps/desktop/src/lib/i18n/en.ts`

**Interfaces:**
- Audio frames expose bounded level samples to the live hook without storing audio.
- `LiveSourceHealth` consumes ready, audio level, and speech events per source and returns a non-fatal warning when mic activity is established but system remains silent.

- [ ] **Step 1: Write failing health tests**

Use a fake clock. Assert no warning during initial silence, warning after at least three mic speech starts and 30 seconds with a ready-but-silent system channel, recovery after a system level/speech event, and no warning when system audio was not requested.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @interview/desktop exec vitest run src/lib/liveSourceHealth.test.ts`

Expected: module is missing.

- [ ] **Step 3: Implement health tracking and visible warning**

Calculate frame RMS locally at a throttled cadence, never persist PCM in health state, tag every ready/speech/error diagnostic with `source`, and show a concise non-fatal overlay warning with recovery. Do not stop the session or auto-switch to the candidate mic.

- [ ] **Step 4: Run GREEN**

Run the Task 4 Vitest command plus renderer typecheck.

---

### Task 5: Persist screen diagnostics and export a truthful report

**Files:**
- Create: `apps/desktop/src/lib/screenAssistDiagnostics.ts`
- Create: `apps/desktop/src/lib/screenAssistDiagnostics.test.ts`
- Modify: `apps/desktop/src/hooks/useLiveCopilot.ts`
- Modify: `apps/desktop/src/pages/OverlayPage.tsx`
- Modify: `apps/desktop/src/lib/api.ts`
- Modify: `apps/desktop/src/lib/sessionDebugReport.ts`
- Modify: `apps/desktop/src/lib/sessionDebugReport.test.ts`
- Modify: `apps/desktop/src/components/interview/SessionReportModal.tsx`
- Modify: `apps/api-py/app/routers/chat.py`
- Modify: `apps/api-py/tests/test_chat_review.py`

**Interfaces:**
- `ScreenAssistDiagnosticEntry` stores request/effective question, mode, status, model/source, answer/error, capture/first-token/total timing, and image mime/encoded byte count; it never stores image data.
- Session `diagnostics.extra.screenAssists` is a last-40 bounded list.
- SSE `onDone` exposes model metadata exactly once.

- [ ] **Step 1: Write failing diagnostics/report tests**

Assert a completed and failed screen call each record once; model and timings appear in the report; base64/data URLs do not. Assert more than 500 events results in a report section showing retained/dropped counts rather than silent `slice(0, 500)`. Assert STT queue/capture age is labeled separately from final→LLM dispatch.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @interview/desktop exec vitest run src/lib/screenAssistDiagnostics.test.ts src/lib/sessionDebugReport.test.ts`

Expected: screen diagnostics are absent and event truncation is silent.

- [ ] **Step 3: Implement one-shot SSE settlement and central persistence**

Forward screen `done` metadata once, record capture/request/first-token/done/error timestamps, keep screen answers out of candidate answers, and serialize diagnostic snapshot writes through the hook-owned session state to prevent last-write-wins loss.

- [ ] **Step 4: Make report health claims evidence-based**

Render all retained ring events or the newest bounded set with explicit total/dropped counts. Distinguish connection-ready from signal-observed, count low-quality/degraded events, list silent requested sources, include screen assists, and never call final→LLM dispatch time STT latency.

- [ ] **Step 5: Run GREEN**

Run the Task 5 Vitest command and `python -m pytest tests/test_chat_review.py -q`; expect green.

---

### Task 6: Integrated adversarial verification

**Files:**
- Modify only test fixtures if an integration gap is proven by a failing test.

**Interfaces:**
- Consumes all prior tasks; produces no new runtime API.

- [ ] **Step 1: Add a session-shaped integration fixture**

Simulate rapid VAD turns, managed pacing, Ctrl+Enter, screen fallback, a delayed foreign garbage final, silent system source, stop, and report export. Literal assertions: no unbounded provider calls, screen answer remains authoritative, no post-stop calls, warning present, and report contains queue/source/screen evidence.

- [ ] **Step 2: Run focused verification**

Run all test files named in Tasks 1–5.

- [ ] **Step 3: Run full gates**

Run:

```text
python -m pytest -q
python -m ruff check app tests
python -m mypy app
pnpm --filter @interview/shared build
pnpm --filter @interview/desktop test
pnpm --filter @interview/desktop typecheck
pnpm --filter @interview/desktop exec tsc --noEmit -p tsconfig.electron.json
pnpm --filter @interview/desktop lint
git diff --check
```

Expected: all commands exit zero. No application, installer, audio device, payment, HH, release, or deployment action is performed.
