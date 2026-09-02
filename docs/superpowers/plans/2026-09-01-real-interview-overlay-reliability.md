# Real Interview Overlay Reliability Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Make screen assistance and candidate-directed follow-ups reliable during a long technical interview, preserve task context across scrolled screenshots and corrections, and always render complete readable code.

**Architecture:** Keep the fast live-answer path, but attach a bounded rolling screen-task context to it. Treat repeated screenshots as frames in one short-lived task, make duplicate screen hotkeys idempotent, keep the SSE connection alive while the vision model is thinking, and repair incomplete Markdown fences at the renderer boundary. Candidate-directed `Ctrl+\\` becomes valid even before the first interviewer answer and waits briefly for the current microphone final instead of consuming a stale fragment.

**Tech Stack:** Electron, React, TypeScript/Vitest, FastAPI/Pydantic, pytest, OpenRouter streaming SSE.

---

### Task 1: Protect slow first screen tokens and duplicate hotkeys

- [ ] Add failing API tests for a screen model whose first token arrives after the client idle window; assert periodic SSE keepalive frames and eventual answer.
- [ ] Add a failing desktop test proving a second identical screen command does not cancel the request already in progress.
- [ ] Implement server keepalives and client-side request coalescing without hiding genuinely dead connections.
- [ ] Verify first press succeeds and repeated press is idempotent.

### Task 2: Preserve a multi-frame screen task

- [ ] Add failing tests for a rolling two-frame memory with deduplication, TTL/reset, and bounded payload size.
- [ ] Extend the desktop/API payload with previous viewport frames and prior solution summary.
- [ ] Feed ordered prior/current frames to the vision model, with the current frame authoritative.
- [ ] Reset memory only on a genuinely new task/session, not on scroll or refinement.

### Task 3: Carry screen context into interviewer and candidate follow-ups

- [ ] Add failing tests proving the fast interview path receives the latest screen solution without an extra model call.
- [ ] Add failing tests for `Ctrl+\\` before any prior answer and while a microphone phrase is still finalizing.
- [ ] Implement bounded screen-task context in `useLiveCopilot` and bootstrap candidate follow-ups.
- [ ] Add hotkey diagnostics for received/queued/ignored/selected utterance so future failures are observable.

### Task 4: Prefer canonical solutions and guarantee readable code

- [ ] Add behavior tests for the screen prompt contract: simplest requirement-complete solution first, no invented architecture, Russian explanation/comments, preserve prior interfaces on refinement.
- [ ] Increase the completion budget enough for full code and surface `finish_reason=length` as an incomplete result rather than silent success.
- [ ] Add a failing renderer test for one unmatched triple-backtick fence.
- [ ] Repair an unmatched final fence for display and keep code wrapped within the fixed overlay width.

### Task 5: Real-interview regression and long-session verification

- [ ] Build sanitized deterministic fixtures from the supplied report: delayed first token, multi-scroll CI/CD, simple SQL correction, repeated checklist refinement, early `Ctrl+\\`, and code fence truncation.
- [ ] Run desktop unit/behavior tests, API pytest tests, typecheck/build, and the existing long-session overlay verifier.
- [ ] Run multiple live-model evaluations on representative report prompts; record latency and semantic checks without claiming replay of unavailable screenshot pixels/audio.
- [ ] Visually inspect the fixed-size overlay in light/dark backgrounds and verify no horizontal scroll.
