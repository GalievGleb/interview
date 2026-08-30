# Real Interview Regression Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SkillCue recognize screen-dependent interview tasks, suppress leaked STT guidance, and keep unclear live questions responsive when the quality model stalls.

**Architecture:** Keep each correction at the boundary where the bad decision originates. Extend the pure desktop screen-intent classifier, normalize prompt echoes at both managed-gateway and Python STT response boundaries, and hedge only stalled `unclear` fast answers without changing personal-experience routing.

**Tech Stack:** React/TypeScript/Vitest desktop, NestJS/TypeScript node:test gateway, FastAPI/Python/pytest backend, OpenAI-compatible streaming providers.

**Spec:** `docs/superpowers/plans/2026-08-27-ozon-interview-replay.md`

## Global Constraints

- Do not use Whisper or another transcription engine.
- Keep `Ctrl+Enter` manual-only; recognition alone must not start an answer.
- Screen capture is automatic only for language that refers to visible material.
- Preserve explicit model overrides and the no-hedge personal-experience route.
- Do not commit interview recordings, frames, transcripts, names, or other personal data.

---

### Task 1: Route visible API tasks to screen assist

**Files:**
- Modify: `apps/desktop/src/lib/visualQuestion.ts`
- Test: `apps/desktop/src/lib/visualQuestion.test.ts`

**Interfaces:**
- Consumes: `requiresScreenContext(question: string): boolean`
- Produces: `true` for deictic phrases such as «Здесь представлен пример запроса и пример ответа» while preserving `false` for self-contained API questions.

- [x] **Step 1: Write the failing test** with literal Lamoda replay variants and a self-contained negative control.
- [x] **Step 2: Run** `pnpm --filter @interview/desktop test -- src/lib/visualQuestion.test.ts` and confirm only the new visible-task cases fail.
- [x] **Step 3: Add a targeted deictic-artifact matcher** for `здесь/тут/вот + представлен/показан + example/request/response/table/schema/code`.
- [x] **Step 4: Rerun the focused test** and confirm all cases pass.

### Task 2: Remove robust variants of the private STT prompt

**Files:**
- Modify: `apps/api-py/app/services/stt/openai_transcribe.py`
- Test: `apps/api-py/tests/test_stt_openai_mini_only.py`
- Modify: `apps/api/src/gateway/gateway-stt.service.ts`
- Test: `apps/api/src/gateway/gateway-stt.service.test.ts`

**Interfaces:**
- Consumes: `strip_live_prompt_echo(text: str) -> str` and `stripLiveSttPromptEcho(text: string): string`
- Produces: empty text for the observed prompt-only echo, preserved trailing real speech for prompt-plus-speech, and unchanged ordinary interview speech.

- [x] **Step 1: Add the observed no-«Русское» prompt echo as failing Python and TypeScript tests.**
- [x] **Step 2: Run both focused suites** and confirm the new cases fail against exact-string stripping.
- [x] **Step 3: Implement equivalent normalized prompt-family stripping** in both runtime boundaries without rewriting ordinary transcripts.
- [x] **Step 4: Rerun both focused suites** and confirm the new cases and existing exact-string cases pass.

### Task 3: Hedge stalled unclear live answers

**Files:**
- Modify: `apps/api-py/app/routers/chat.py`
- Test: `apps/api-py/tests/test_chat_review.py`

**Interfaces:**
- Consumes: fast-answer intent classification and `select_hedged_stream(...)`
- Produces: `gpt-4.1-mini` as quality-first primary for `unclear`, with `gpt-4o-mini` starting only after the first-token budget expires.

- [x] **Step 1: Add a failing route test** where an `unclear` 4.1-mini stream stalls and the 4o-mini hedge wins.
- [x] **Step 2: Run the single pytest case** and confirm only 4.1-mini is currently called.
- [x] **Step 3: Add the minimal unclear-intent hedge branch** while leaving theory nano hedging, personal experience, and explicit overrides unchanged.
- [x] **Step 4: Run the hedge and reliability route tests** and confirm winner/model-source metadata remains accurate.

### Task 4: Full verification and real replay

**Files:**
- No production files created.
- Keep generated replay artifacts under ignored `output/interview-replay/`.

**Interfaces:**
- Consumes: repository tests, dev build, installed SkillCue Dev, local interview recordings.
- Produces: fresh pass/fail evidence for screen routing, prompt suppression, first-token latency, and regressions.

- [x] **Step 1: Run desktop tests/typecheck, gateway tests/build, and Python tests/ruff for changed boundaries.**
- [x] **Step 2: Build the dev desktop/backend artifacts.**
- [x] **Step 3: Replay the Lamoda visible API task and one PositiveTech voice question through installed SkillCue Dev.**
- [x] **Step 4: Confirm the Lamoda exchange records a screen assist, no prompt echo is persisted, and a stalled unclear request has a responsive fallback path.**
- [x] **Step 5: Inspect `git diff --check` and `git status --short`; report evidence and any remaining limitation.**

Verification note: all changed-boundary tests and builds pass. The complete desktop
suite remains at 1297/1298 because the pre-existing product-surface assertion still
expects a tag-triggered GitHub Actions release while the repository intentionally uses
manual `workflow_dispatch` to avoid hosted-runner billing.
