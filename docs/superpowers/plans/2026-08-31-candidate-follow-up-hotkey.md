# Candidate Follow-up Hotkey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Ctrl+\` as an explicit “use my latest phrase” continuation command and make overlay answer scrolling move by one readable line.

**Architecture:** Keep the existing manual-only live-answer pipeline and STT transport. A candidate-owned force generation always targets the `mic` final, wraps it with the last completed task and answer in one model request, and never routes to screen capture; Electron forwards the shortcut only while the overlay is visible. Scrolling uses a tested fixed one-line offset with instant movement so repeated keypresses cannot accumulate a 180px animation.

**Tech Stack:** Electron 39 global shortcuts and IPC, React 19, TypeScript 5.7, Vitest 3.

**Spec:** User request in the active Codex task dated 2026-08-31.

## Global Constraints

- Preserve all unrelated dirty worktree changes.
- Do not add another LLM call; continuation remains one streaming request.
- `Ctrl+Enter` must continue targeting interviewer/system speech exactly as before.
- `Ctrl+\` must target only the candidate microphone phrase and keep the previous task/answer as context.
- `Ctrl+Shift+Up/Down` must scroll approximately one line and must not use smooth animation.

---

### Task 1: Candidate continuation request

**Files:**
- Create: `apps/desktop/src/lib/candidateFollowUp.ts`
- Test: `apps/desktop/src/lib/candidateFollowUp.test.ts`
- Modify: `apps/desktop/src/hooks/useLiveCopilot.ts`

**Interfaces:**
- Consumes: latest completed `CopilotAnswerEntry`, latest forced `mic` transcript, current force generation.
- Produces: `buildCandidateFollowUpRequest(input): { prompt: string; displayQuestion: string }` and `forceCandidateFollowUp(): ForceAnswerStatus`.

- [ ] **Step 1: Write failing request-builder tests**

```ts
expect(buildCandidateFollowUpRequest({
  previousQuestion: 'Как протестировать окно?',
  previousAnswer: 'Проверю открытие и закрытие.',
  candidatePhrase: 'Надо подумать, какие ещё варианты проверок есть.',
}).prompt).toContain('Надо подумать, какие ещё варианты проверок есть.');
```

- [ ] **Step 2: Run the focused test and verify it fails because the module does not exist**

Run: `pnpm --filter @interview/desktop test -- src/lib/candidateFollowUp.test.ts`

- [ ] **Step 3: Implement the bounded, single-request context builder**

```ts
export function buildCandidateFollowUpRequest(input: CandidateFollowUpInput) {
  return {
    displayQuestion: input.candidatePhrase.trim(),
    prompt: `Текущая задача:\n${input.previousQuestion}\n\nПредыдущий ответ:\n${input.previousAnswer}\n\nУточнение кандидата:\n${input.candidatePhrase}`,
  };
}
```

- [ ] **Step 4: Route a mic-owned force generation through the existing stream**

Add `forceCandidateFollowUp` to `useLiveCopilot`: require an active mic and previous completed answer, call the existing coordinator with source `mic`, preserve the prior topic, bypass screen routing for this owned generation, and display only the candidate phrase while sending the contextual prompt.

- [ ] **Step 5: Run focused unit and behavior tests**

Run: `pnpm --filter @interview/desktop test -- src/lib/candidateFollowUp.test.ts src/pages/OverlayPage.behavior.test.ts`

### Task 2: Electron and renderer shortcut wiring

**Files:**
- Modify: `apps/desktop/electron/overlayShortcutLifecycle.ts`
- Modify: `apps/desktop/electron/overlayShortcutLifecycle.test.ts`
- Modify: `apps/desktop/electron/main.ts`
- Modify: `apps/desktop/electron/preload.ts`
- Modify: `apps/desktop/src/types/electron.d.ts`
- Modify: `apps/desktop/src/pages/OverlayPage.tsx`
- Modify: `apps/desktop/src/pages/SettingsPage.tsx`
- Modify: `apps/desktop/src/lib/i18n/ru.ts`
- Modify: `apps/desktop/src/lib/i18n/en.ts`

**Interfaces:**
- Consumes: Electron accelerator `CommandOrControl+\` and renderer key `Ctrl+\`.
- Produces: `overlay:candidate-follow-up` / `onCandidateFollowUp` and invokes `forceCandidateFollowUp` once per physical keypress.

- [ ] **Step 1: Extend lifecycle and behavior tests first**

Assert that `CommandOrControl+\` registers only while the overlay is shown, invokes the candidate callback, unregisters on hide, and preload exposes the matching IPC event.

- [ ] **Step 2: Run the focused tests and verify the missing shortcut fails**

Run: `pnpm --filter @interview/desktop test -- electron/overlayShortcutLifecycle.test.ts src/pages/OverlayPage.behavior.test.ts`

- [ ] **Step 3: Add main/preload/type/renderer wiring and shortcut documentation**

Register the accelerator in the overlay visibility lifecycle, send `overlay:candidate-follow-up`, handle local `Ctrl+\`, deduplicate renderer/global delivery, and list the command in Settings.

- [ ] **Step 4: Re-run focused tests until green**

Run: `pnpm --filter @interview/desktop test -- electron/overlayShortcutLifecycle.test.ts src/pages/OverlayPage.behavior.test.ts`

### Task 3: One-line overlay scrolling

**Files:**
- Create: `apps/desktop/src/lib/overlayScroll.ts`
- Test: `apps/desktop/src/lib/overlayScroll.test.ts`
- Modify: `apps/desktop/src/pages/OverlayPage.tsx`

**Interfaces:**
- Produces: `overlayScrollOffset(direction): number`, returning `-24` or `24` pixels.

- [ ] **Step 1: Write a failing unit test for the one-line offset**

```ts
expect(overlayScrollOffset(1)).toBe(24);
expect(overlayScrollOffset(-1)).toBe(-24);
```

- [ ] **Step 2: Verify RED, implement the helper, then switch `scrollBy` to `behavior: 'auto'`**

Run: `pnpm --filter @interview/desktop test -- src/lib/overlayScroll.test.ts`

- [ ] **Step 3: Re-run focused tests**

Run: `pnpm --filter @interview/desktop test -- src/lib/overlayScroll.test.ts src/pages/OverlayPage.behavior.test.ts`

### Task 4: Regression and installed-Dev verification

**Files:**
- Verify only; no production deployment requested.

**Interfaces:**
- Confirms: legacy `Ctrl+Enter`, screen shortcut, candidate continuation, IPC, renderer types, build, and one-line scroll.

- [ ] **Step 1: Run desktop tests and typecheck**

Run: `pnpm --filter @interview/desktop test`

Run: `pnpm --filter @interview/desktop typecheck`

- [ ] **Step 2: Build Dev and run the existing installed-overlay verifier**

Run: `pnpm --filter @interview/desktop build:dev`

Run the repository's existing verified Dev installer/overlay check if it does not mutate production or unrelated user data.

- [ ] **Step 3: Inspect the final diff and report exact verification evidence**

Confirm only intended files were added/changed by this task and preserve all pre-existing modifications.
