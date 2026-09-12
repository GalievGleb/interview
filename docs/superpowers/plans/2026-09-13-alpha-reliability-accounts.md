# Alpha reliability and accounts implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an isolated, tested Alpha update with bounded voice requests, useful personal continuity, and a staged, real account/subscription implementation.

**Architecture:** Preserve the existing Electron/Python architecture and experimental typed screen ledger. Reliability changes are independently testable before packaging. Account ownership must be server-authoritative; do not substitute local profiles or a fake login for cross-device subscriptions.

**Tech Stack:** Electron/React/TypeScript/Vitest, Python/FastAPI/pytest, NestJS gateway, PostgreSQL/Prisma, Redis.

**Spec:** `docs/2026-09-13-accounts-reliability-audit.md`, with current user amendment: 10 successive voice questions with answers; install Alpha only, keep Dev and Stable installations untouched. User mentioned 0.1.12 although installed Alpha is 0.1.13; clarification pending; existing Alpha build derives next patch (0.1.14).

## Global Constraints

- Work in `C:/Users/gleb/Projects/SkillCue`, branch `codex/bravo-overlay-reliability`, never main; preserve all pre-existing uncommitted work.
- Install Alpha only. Do not publish Stable or modify the shared production gateway/payment flow.
- Test 10 successive voice questions with answers, plus delayed/missing final-event recovery.
- Never log personal transcripts, license keys, email codes, cookies or payment secrets in diagnostics or reports.
- Keep typed screen rollout Alpha-only. New account enforcement must not lock out legacy paying users.
- Account policy: two registered computers and one concurrent live interview; all preparations within one account share the subscription.
- Shared production changes, missing mail delivery credentials or a missing isolated account service are deployment gates, not grounds to ship fake functioning account UI.

## Task 1: Bounded force finalization

**Files:** Modify `apps/desktop/src/lib/latestForcedAnswer.ts`, `apps/desktop/src/hooks/useLiveCopilot.ts`; test `apps/desktop/src/lib/latestForcedAnswer.test.ts`; add a narrowly named lifecycle test if needed. Do not edit candidate context code in the hook.

**Interfaces:** Keep `notifyDelayedForcedTranscript` as a soft notification for late final ownership. Add `expireDelayedForcedTranscript(coordinator, generation, onExpired): boolean`, accepting coordinator snapshot/setPhase, that terminalizes only the current `finalizing-transcript` generation. Add a separately cancellable hard-deadline scheduler in the hook; preserve existing candidate follow-up behavior. Soft notice remains 3500 ms, hard deadline is 12000 ms from the original request and never extended by repeated scheduling. All cancellation/reset paths release both schedulers. Deadline must not steal a streamed answer or screen request.

- [ ] Write red tests: first question done, second flush, soft notice still owns request, hard expiration gives `phase: 'error', requestId: null, pendingRequestCount: 0`; a late tagged final after expiry cannot submit; expiry of generation 1 cannot cancel generation 2; successful final before deadline is not cancelled. Example core assertion:
```ts
expect(expireDelayedForcedTranscript(coordinator, generation, () => {})).toBe(true);
expect(coordinator.snapshot()).toMatchObject({ phase: 'error', pendingRequestCount: 0, requestId: null });
```
- [ ] Run `pnpm --filter @interview/desktop exec vitest run src/lib/latestForcedAnswer.test.ts`; confirm missing behavior before implementation, not a broken import harness.
- [ ] Implement the minimal phase-guarded expiration and hook integration. On hard expiry clear candidate owner, prefix timer and current partial bookkeeping where owned; publish the phase and a retryable error. No unrelated final or last answer used as fallback. Record metadata-only diagnostics if an existing recorder fits.
- [ ] Add a real coordinator/ledger/stream lifecycle test of ten sequential question/final/answer completions with no pending owner after each, and a lost-final interruption followed by a recoverable subsequent answer. This is deterministic orchestration evidence, not an acoustic acceptance claim.
- [ ] Run targeted voice/coordinator/source-reliability tests and desktop typecheck. Record RED/GREEN and self-review; commit only task-owned files after checking staged diff.

## Task 2: Bounded candidate and conversation continuity

**Files:** `apps/desktop/src/hooks/useLiveCopilot.ts`, `apps/desktop/src/lib/api.ts`, new `apps/desktop/src/lib/liveAnswerMemory.ts` and test; `apps/api-py/app/routers/chat.py`, new `apps/api-py/app/services/fast_candidate_context.py` and test, `apps/api-py/tests/test_chat_review.py`.

**Interfaces:** A small in-memory list of the last two completed turns (`question`, `answer`) for the active interview, max 800 chars per question and 1800 per answer. Send as `recent_turns` only on live fast requests; backend validates size/count. Profile facts and conversation answers are separate prompt blocks: prior generated answers are not confirmed experience. Never persist this memory outside the active session. Build a bounded context combining selected resume and actual local profile/legend facts with explicit source labels, never letting nonempty resume suppress all project facts. Preserve the separately labelled selected resume budget (3200 chars) and project/profile budget (3200 chars); use raw legend and/or user-edited profile, never a stale generated pack as authoritative facts. A fresh generated pack may be used only when it demonstrably matches the source selection, otherwise omit it. Include personal data for a follow-up about the prior project even if this question alone classifies as general; unrelated theory should not receive it. No new profile/account UI required in this task. Any existing content-source change signal must invalidate live memory; refresh at session start and guard async preload against older session results.

- [ ] RED: test 2-turn bounding/reset and exclusion of failed/partial answers; test fast payload includes history; test backend personal prompt includes project facts even with a nonempty resume and labels untrusted prior answers. Theory without a follow-up must not acquire personal context. Use synthetic resume/project fixtures only.
- [ ] Run the new Vitest and pytest cases and observe the missing behavior.
- [ ] Implement the bounded memory, reset on start/stop/profile switch, send context on request, and append only successful current-generation complete answers. Combine independently budgeted resume/profile blocks in fast personal/follow-up prompts without another model request.
- [ ] GREEN: run `pnpm --filter @interview/desktop test`, desktop typecheck and `.venv/Scripts/python.exe -m pytest tests/test_chat_review.py tests/test_candidate_profile.py tests/test_fast_candidate_context.py -q` from api-py.
- [ ] Review and commit only this task's changes. Keep user's screen pipeline changes untouched.

## Task 3: Update diagnostics and channel identity

**Files:** new `apps/desktop/electron/updateError.ts` and test; `apps/desktop/electron/main.ts`; `SKILLCUE_ALPHA_TEST_GUIDE.md`, `RELEASE_BUILD_GUIDE.md`.

**Interfaces:** `describeUpdateError(error: unknown): string` maps DNS, connection timeout, missing manifest and integrity failures to safe Russian messages, never includes raw URL query/token. Unknown returns a generic error. Use it for updater events/check promises. Disabled Alpha updater must say Alpha and explain the separate installer, not claim Dev. No feed migration to unconfigured hosting.

- [ ] RED: behavioral tests using Error('net::ERR_NAME_NOT_RESOLVED'), ENOTFOUND, timeout, checksum mismatch, 404 and an error URL with a secret; require useful retry/install guidance and absence of secret.
- [ ] Implement helper and integrate every updater catch/event. Run focused tests, Electron compilation and desktop typecheck.
- [ ] Update channel docs with actual Alpha metadata, existing screen features, ten-question acceptance instructions, and manual-only Alpha delivery. Distinguish build source version from installed version; do not rewrite Stable package version for Alpha.

## Task 4: Isolated account deployment prerequisites and implementation gate

**Files:** audit/account architecture docs, `apps/api/src/gateway-main.ts`, `apps/api/prisma/schema.prisma`, existing deploy configuration (inspection before implementation).

**Interfaces:** Account authority needs durable PostgreSQL, verified email delivery, separately scoped Alpha endpoint/config, safe session storage and account-aware authorization on every paid route. Legacy bearer verification is synchronous today; integration must cover HTTP and both STT paths, not just checkout.

- [ ] Inventory configured services by presence/names only; inspect Alpha gateway routing, local Docker availability and existing deployment entrypoints.
- [ ] Verify whether separate Alpha account authority, database, mail delivery and test payments can run without modifying shared production. If missing a user-owned service/secret/approval, record the exact gate and ask for it; do not pretend accounts work in the installed app.
- [ ] Once these are available, write a dedicated account subproject plan with exact endpoints/DTOs/migrations and tests before implementation. Required contract: verified-email account ownership, per-device rotating sessions, transactional two-device cap, live lease with reconnect grace, unique durable payment application, shared usage, non-destructive old purchase claim. No recurring charges without explicit enablement.

## Task 5: Alpha packaging and acceptance

**Files:** `tools/verify_dev_voice_overlay.py`, `tools/install_and_verify_alpha.ps1`, associated tests, Alpha guide.

- [ ] Read existing verifier and extend its actual voice suite to ten successive questions with nonempty completed answers in one session. Preserve each case's own force request identity. Verify old Alpha screen/recording fixes with their existing tests.
- [ ] Record Dev/Stable EXE hashes before packaging and compare after installation. Backup Alpha settings/data before any migration; do not overwrite Dev/Stable data or stop their processes.
- [ ] Build Alpha backend + Electron from the reviewed branch; installer must remain separate and monotonic. Install only the exact `SkillCue-Alpha-Setup.exe`; verify installed version and backend health.
- [ ] Run packaged recording/hotkey smoke, ten-question voice acceptance and typed screen acceptance with synthetic fixtures. Report acoustic/live checks separately from deterministic tests, and do not silently consume unlimited provider budget on retries.
- [ ] Final review of the actual task diff, report what is implemented/installed and what remains gated. No claim that accounts, DNS, HH student environment or Stable rollout are fixed without corresponding evidence.
