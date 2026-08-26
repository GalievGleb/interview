# Overlay Launch and Voice Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task by task.

**Goal:** Reliably open the overlay from the app, prevent accidental screen analysis on `Ctrl+Enter`, and make live startup immediately ready through background warmup.

**Architecture:** Align all native overlay-open entry points on the already-working show path. Keep the forced-answer coordinator pending while STT finishes, with a non-destructive delay notice instead of a screen fallback. Add a small retryable warmup coordinator invoked from app health initialization; live start no longer awaits readiness.

**Tech Stack:** Electron, React, TypeScript, Vitest, Python/FastAPI installed-backend verification, PowerShell dev installer.

**Spec:** `docs/superpowers/specs/2026-08-25-overlay-launch-voice-routing.md`

## Global constraints

- Use test-driven development: observe every new behavior test fail before implementation.
- Preserve unrelated dirty files and do not reset the worktree.
- Screen analysis remains available only through explicit screen intent.
- Keep diagnostic/report drafts.

### Task 1: Make the UI launch path match the working hotkey

**Files:**
- Modify: `apps/desktop/electron/windowLifecycle.test.ts`
- Modify: `apps/desktop/electron/windowLifecycle.ts`

1. Change the lifecycle test to require showing the overlay without hiding the active main window.
2. Run the focused test and confirm it fails because `main.hide()` is called.
3. Remove the pre-show main-window hide from the shared UI launch helper.
4. Run the focused lifecycle/privacy tests and confirm they pass.

### Task 2: Separate conversation forcing from screen assistance

**Files:**
- Modify: `apps/desktop/src/lib/liveSessionReliability.integration.test.ts`
- Modify: `apps/desktop/src/lib/latestForcedAnswer.test.ts`
- Modify: `apps/desktop/src/lib/latestForcedAnswer.ts`
- Modify: `apps/desktop/src/hooks/useLiveCopilot.ts`
- Modify: `apps/desktop/src/pages/OverlayPage.behavior.test.ts`
- Modify: `apps/desktop/src/pages/OverlayPage.tsx`
- Modify: `apps/desktop/src/lib/i18n/ru.ts`
- Modify: `apps/desktop/src/lib/i18n/en.ts`

1. Add a delayed-final integration test: after the old timeout boundary, no screen request occurs; the coordinator remains pending; a late finalized test-design question is submitted once through text.
2. Add focused policy tests for the timeout notification and run them red against current automatic screen fallback behavior.
3. Implement a pending-safe delayed-transcript notification and wire it into `useLiveCopilot` instead of `beginScreenFallback`.
4. Change the immediate unavailable path in `OverlayPage` to display the conversation notice rather than call `runScreenAssist`.
5. Keep explicit visual-question routing unchanged and update the keyboard guide copy.
6. Run the focused coordinator, quality, visual-question, behavior, and reliability tests.

### Task 3: Prewarm live dependencies without blocking start

**Files:**
- Create: `apps/desktop/src/lib/liveStartupWarmup.test.ts`
- Create: `apps/desktop/src/lib/liveStartupWarmup.ts`
- Modify: `apps/desktop/src/context/AppContext.tsx`
- Modify: `apps/desktop/src/pages/OverlayPage.behavior.test.ts`
- Modify: `apps/desktop/src/pages/OverlayPage.tsx`

1. Add tests proving concurrent warmups deduplicate and failed warmups can retry.
2. Run the focused test and confirm failure because the coordinator does not exist.
3. Implement the coordinator around provider readiness and STT warmup.
4. Trigger it after backend health succeeds, and fire it best-effort on overlay start without awaiting it.
5. Remove the blocking readiness notice/check from the live start path.
6. Run focused startup and page behavior tests.

### Task 4: Verify and install the dev build

**Files:**
- Modify if needed: `tools/verify_dev_overlay.py`
- Modify if needed: `apps/desktop/src/lib/liveSessionReliability.integration.test.ts`

1. Ensure the deterministic integration scenario uses the spoken question “Какие техники тест-дизайна ты применяешь?” and asserts text submission, zero automatic screen requests, and a bounded response.
2. Run all desktop tests and desktop typecheck.
3. Run relevant Python reliability tests.
4. Build, silently install, and run `tools/install_and_verify_dev.ps1` against the installed dev backend.
5. Inspect the installed SkillCue app: click **Открыть помощника** and verify the overlay is raised while the main app remains available.
