# Qwen live answers and screen follow-ups implementation plan

> **For agent:** execute with `executing-plans`, strict TDD, and `verification-before-completion`.

**Goal:** Use Qwen for all automatic live answers and make screen tasks reliable through a global shortcut, a natural spoken cue, continuity context, and a strict readable-code contract.

**Architecture:** Keep audio and screen actions as separate generations. Extend the existing Electron global-shortcut bridge with a screen-only event, keep the renderer as the owner of capture, and use pure local helpers for spoken-cue/follow-up detection and bounded continuity context. Change only Auto live routing; explicit model overrides remain authoritative.

**Tech stack:** Electron, React, TypeScript/Vitest, FastAPI/Python/Pytest, OpenRouter SSE.

**Spec:** `docs/superpowers/specs/2026-08-30-qwen-screen-followups.md`

---

## Task 1: Lock model and intent behavior

**Files:**
- Modify: `apps/api-py/app/services/model_router.py`
- Modify: `apps/api-py/app/services/question_intent.py`
- Modify: `packages/shared/src/classifyInterviewQuestionIntent.ts`
- Modify: `apps/api-py/app/routers/chat.py`
- Test: `apps/api-py/tests/test_model_router.py`
- Test: `apps/api-py/tests/test_chat_review.py`
- Test: `packages/shared/src/classifyInterviewQuestionIntent.test.ts`

1. Add failing cases proving Russian experience inflections receive resume context and automatic personal answers start Qwen, never GPT-4.1 Mini.
2. Run the focused tests and confirm the expected failures.
3. Make Qwen the Auto fast default and the primary for all fast intents; keep only GPT-4o Mini as reliability fallback.
4. Extend both Python and shared TypeScript classifiers without broadening ordinary theory questions.
5. Re-run focused tests.

## Task 2: Add deterministic screen intent and continuity helpers

**Files:**
- Modify: `apps/desktop/src/lib/visualQuestion.ts`
- Add: `apps/desktop/src/lib/screenTaskContinuity.ts`
- Test: `apps/desktop/src/lib/visualQuestion.test.ts`
- Add: `apps/desktop/src/lib/screenTaskContinuity.test.ts`

1. Add failing table-driven tests for «покажу решение», ordinary non-screen speech, and previous-task modification phrases.
2. Implement conservative local regexes and a bounded context builder.
3. Re-run the helper tests.

## Task 3: Add the global screen shortcut

**Files:**
- Modify: `apps/desktop/electron/buildChannel.ts`
- Modify: `apps/desktop/electron/main.ts`
- Modify: `apps/desktop/electron/preload.ts`
- Modify: `apps/desktop/src/types/electron.d.ts`
- Test: `apps/desktop/electron/buildChannel.test.ts`
- Test: `apps/desktop/electron/persistentGlobalShortcut.test.ts`

1. Add failing tests for a stable/dev `CommandOrControl+Shift+Enter` contract and the `overlay:force-screen-answer` bridge.
2. Register a lifecycle-independent shortcut alongside Ctrl+Enter, including retry and disposal.
3. Expose the event through preload/types and re-run Electron tests.

## Task 4: Wire screen-only generations and previous-task context

**Files:**
- Modify: `apps/desktop/src/hooks/useLiveCopilot.ts`
- Modify: `apps/desktop/src/pages/OverlayPage.tsx`
- Modify: `apps/desktop/src/pages/OverlayPage.behavior.test.ts`
- Modify: `apps/desktop/src/lib/i18n/ru.ts`
- Modify: `apps/desktop/src/lib/i18n/en.ts`

1. Add failing behavior tests proving Shift+Enter is handled before normal Enter, the global event captures the screen, and completed screen answers feed only explicit follow-ups.
2. Add a `forceScreenAnswer` generation path and a small `markScreenTaskAvailable` signal to screen-aware transcript routing.
3. Store only bounded prior question/answer text in the overlay, append it for explicit follow-ups, and update the shortcut guide/menu.
4. Re-run desktop behavior tests.

## Task 5: Enforce interview-readable code output

**Files:**
- Modify: `apps/api-py/app/routers/chat.py`
- Test: `apps/api-py/tests/test_live_technical_task.py`

1. Add failing contract tests for fenced code, a short Russian inline explanation on every meaningful line, no decorative blank lines, and full updated code for follow-ups.
2. Strengthen the system and request-tail instructions without adding another model call or buffering SSE.
3. Re-run API screen-task tests.

## Task 6: Verify and build Dev

1. Run all focused Python and Vitest suites from Tasks 1–5.
2. Run TypeScript checks/build for shared and desktop.
3. Run the existing overlay integration/voice verification with the standard WAV and a mocked screen capture; confirm Ctrl+Enter remains audio-only and Ctrl+Shift+Enter is screen-only.
4. Build the Dev installer/backend and launch the installed Dev app if the local workflow supports it.
5. Record exact commands, pass/fail counts, model-routing evidence, and any remaining external limitation.

