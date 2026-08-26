# Live Session Reliability Specification

## Goal

Make a live SkillCue interview freshness-safe: the answer shown after Ctrl+Enter must use the newest interviewer turn or the current screen, never minutes-old STT work, and the exported report must make degraded audio/STT/vision states explicit.

## Evidence

Session `2957ce46-7f31-4885-86ca-33ac9ea78a6b` produced 366 speech starts and only 337 terminal STT outcomes before session end. Managed gateway outcomes were spaced by at least 7.278 seconds (median 7.696 seconds), while the server created VAD jobs faster and drained 29 jobs for another 216.85 seconds after the call ended. All 703 speaker-tagged diagnostic events were `me`, despite mic and system audio both being enabled. Four persisted text hints were all unusable, and ten screen requests were absent from the exported report.

## Required behavior

1. A live STT WebSocket has at most one in-flight normal transcription and one bounded coalesced pending turn. New normal audio coalesces into the pending turn instead of creating an unbounded FIFO.
2. A manual finalize targets fresh buffered/pending audio. It never binds to an old in-flight job. If a fresh forced result cannot arrive promptly, screen fallback remains authoritative.
3. Disconnect/stop cancels outstanding transcription work and drops pending audio. No STT request is started after the WebSocket has closed.
4. STT events expose stable utterance identity, original capture timestamps, queue depth/wait, and source-aware metadata. Desktop merging uses capture time/identity, not delivery time.
5. Once screen fallback is committed, a late STT final may revise it only inside a short bounded freshness window and before screen output starts. Older finals are persisted for diagnostics/transcript only and cannot cancel or replace the screen answer.
6. Forced one-token/mixed-language garbage in a Russian session is not sent to the text LLM. The flow keeps or starts screen fallback. Normal short Russian questions and known technical tokens remain valid.
7. Screen routing recognizes code/task wording observed in the session, including analysis/order/assert phrasing, and receives the full current question episode.
8. Fast technical answering keeps local domain/knowledge grounding and a low-cost factual constraint path; unclear garbage never gets a confident answer.
9. When system audio is requested, diagnostics distinguish connection-ready from actual signal/speech. Repeated mic activity with no system signal produces a non-fatal visible warning and never silently presents the channel as healthy.
10. Reports include all bounded events (newest retained events with explicit dropped/truncated counts), source/device health, Ctrl+Enter trigger, transcript capture age/queue wait, screen request/result/model/timings, and truthful STT metrics. Screen answers remain diagnostics and are not persisted as candidate answers.
11. No screenshot pixels, API keys, cookies, or raw base64 image data are stored in diagnostics. Existing runtime UI stays production-safe; developer diagnostics do not become a customer-facing test harness.

## Latency and safety budgets

- Normal pending STT queue: maximum one coalesced turn per source.
- Late final replacement window after screen fallback starts: at most 1.5 seconds and never after screen first output.
- Stale text final: capture age over 20 seconds is never eligible to trigger an answer.
- Diagnostic event storage: bounded ring with explicit dropped count; report must not silently truncate.
- Screen diagnostic entries: maximum 40; text fields capped and screenshot bytes never stored.

## Non-goals

- No release, tag, install, push, or live HH action.
- No redesign of the overlay visuals.
- No provider-key or billing-policy change.
