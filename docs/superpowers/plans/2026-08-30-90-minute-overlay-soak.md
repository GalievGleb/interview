# 90-Minute Overlay Soak Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify and, only where evidence requires it, harden SkillCue so one technical interview remains usable for at least 90 minutes.

**Architecture:** Audit local entitlements, gateway quotas, provider connection lifetime, desktop reconnect state, and Electron/backend lifecycle as one end-to-end session. Model the provider lifetime boundary with deterministic fake-time/forced-close tests, then validate the installed Dev build with a wall-clock soak that periodically exercises STT and answer generation.

**Tech Stack:** Electron/React/TypeScript/Vitest, Python/FastAPI/pytest, NestJS/Jest, OpenAI Realtime WebSocket, installed Dev package.

**Spec:** `docs/superpowers/specs/2026-08-30-90-minute-overlay-soak.md`

## Global Constraints

- Preserve every pre-existing dirty-worktree change; no reset, checkout, cleanup, commit, push, production deploy, or stable release.
- Do not reveal credentials, API keys, license keys, transcript contents, or private audio.
- Do not weaken Trial/Basic/Max product limits or add developer bypasses to stable builds.
- Use strict RED→GREEN TDD for every behavior change.
- Do not claim certainty beyond the evidence: OS, network, and provider outages remain external failure modes.
- Keep the installed Dev overlay behavior and current fast-answer path unchanged unless a reproducible long-session defect requires a fix.

---

### Task 1: Build the lifetime and quota inventory

**Files:**
- Inspect: `apps/api-py/app/services/license.py`
- Inspect: `apps/api-py/app/services/quota.py`
- Inspect: `apps/api/src/gateway/gateway-stt-quota.util.ts`
- Inspect: `apps/api/src/gateway/gateway-stt-realtime.gateway.ts`
- Inspect: `apps/api-py/app/services/stt/openai_realtime_stream.py`
- Inspect: `apps/desktop/src/hooks/useLiveCopilot.ts`
- Inspect: `apps/desktop/electron/main.ts`

- [ ] Enumerate every session-duration timer, idle timer, request timeout, monthly quota, license-expiry check, reconnect delay, and retry cap.
- [ ] Verify the current upstream Realtime session lifetime from the provider's official documentation.
- [ ] Trace one installed-Dev request through local backend, gateway identity, STT quota, and LLM quota.
- [ ] Record the first concrete boundary that can interrupt a 90-minute session.

---

### Task 2: Reproduce the boundary deterministically

**Files:**
- Modify or add only the narrow tests adjacent to the failing reconnect owner.
- Candidate: `apps/api/src/gateway/gateway-stt-realtime.test.ts`
- Candidate: `apps/api-py/tests/test_stt_openai_realtime.py`
- Candidate: `apps/desktop/src/lib/liveSessionReliability.integration.test.ts`

- [ ] Write a failing test that forces the upstream STT connection to close at its lifetime boundary while the SkillCue interview remains active.
- [ ] Advance logical time beyond 60 and 90 minutes and submit another utterance/forced answer.
- [ ] Assert transcript history is retained, exactly one reconnect owner acts, and the fresh question still reaches the answer path.
- [ ] Run the narrow RED command and capture the actual failure before production edits.

---

### Task 3: Harden only the demonstrated failure

**Files:**
- Modify the smallest owner identified in Task 2.
- Add structured diagnostics beside the existing live reliability events.

- [ ] Implement bounded reconnect or proactive rotation without restarting the interview UI.
- [ ] Prevent duplicate sockets, duplicate transcript finals, pending-commit rebinding, and reconnect storms.
- [ ] Preserve accumulated transcript and answer state across the transport replacement.
- [ ] Run the Task 2 test to GREEN plus adjacent STT/live reliability suites.

---

### Task 4: Add a repeatable installed-Dev soak harness

**Files:**
- Create: `tools/verify_long_live_session.py`
- Test: `tools/tests/test_verify_long_live_session.py`

- [ ] Write tests for checkpoint scheduling, maximum allowed gap, latency accounting, reconnect detection, bounded report size, and non-zero exit on a missed checkpoint.
- [ ] Exercise the installed Dev backend/overlay with periodic known audio and answer requests while one interview session remains open.
- [ ] Capture elapsed time, successful transcripts, answer TTFT/total time, reconnect count, process memory, and errors without storing credentials.
- [ ] Support an accelerated fault-injection mode and a real wall-clock mode of at least 95 minutes.

---

### Task 5: Verify the complete 90-minute claim

**Files:**
- No new production files unless verification uncovers another reproducible defect.

- [ ] Run Python, gateway, and desktop narrow reliability suites.
- [ ] Build/install Dev with the current workspace changes.
- [ ] Run accelerated boundary verification through 95 simulated minutes.
- [ ] Run the wall-clock installed-Dev soak, polling without blocking user updates for more than 60 seconds.
- [ ] Report exact proven limits, measured latency/reconnect evidence, and any remaining external risk.
