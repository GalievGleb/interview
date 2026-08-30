# HH Daily Auto-Apply Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore reliable daily HH discovery for the selected QA Automation Python résumé without short-loop retries of unreadable vacancy pages.

**Architecture:** Keep billing access tri-state until the licence request finishes, so an unknown licence can never mutate persisted automation settings. Treat an unreadable HH vacancy as a deferred daily retry, not a 30-minute queue item. Repair the current account through the existing Electron HH assistant API: explicitly select the QA Automation Python résumé, run a non-sending discovery check, then restore the authorised daily automatic mode.

**Tech Stack:** React 19, TypeScript, Electron IPC, Vitest, Playwright browser assistant.

**Spec:** `docs/HH_AUTOMATION_DIAGNOSTICS.md` and the persisted-state audit from 2026-08-30.

## Global Constraints

- Do not submit real HH applications during regression or dry-run verification.
- Preserve the dirty worktree and all unrelated user changes.
- Do not expose HH cookies, credentials, résumé bodies, or other secrets.
- Keep the existing `remote` search filter and all existing queue history.

---

### Task 1: Prevent licence loading from disabling the daily schedule

**Files:**
- Modify: `apps/desktop/src/lib/billing.ts`
- Modify: `apps/desktop/src/lib/billing.test.ts`
- Modify: `apps/desktop/src/pages/HhApplicationsPage.tsx`

**Interfaces:**
- Produces: `shouldDisableHhDailySchedule(loading, license): boolean`.
- Consumes: the existing `hhAutomationAllowed(license)` billing decision.

- [x] **Step 1: Write a failing test** proving that a pending licence never disables a saved daily schedule, while a loaded Basic licence does.
- [x] **Step 2: Run** `pnpm --filter @interview/desktop test -- src/lib/billing.test.ts` and verify the expected missing-export/behavior failure.
- [x] **Step 3: Implement** the tri-state helper and use `loading` in `HhApplicationsPage` before calling `saveConfig({ autoRunDaily: false })`.
- [x] **Step 4: Re-run the targeted test** and verify it passes.

### Task 2: Stop unreadable vacancies from retrying every 30 minutes

**Files:**
- Modify: `apps/desktop/electron/hhBrowserAssistantRetry.test.ts`
- Modify: `apps/desktop/electron/hhBrowserAssistantQueueRecovery.test.ts`
- Modify: `apps/desktop/electron/hhBrowserAssistant.ts`

**Interfaces:**
- Produces: an `opened` queue item with `autoRetryBlockedUntil: 'daily'` when HH page state is unknown.
- Preserves: manual retries and the next scheduled daily retry.

- [x] **Step 1: Write failing tests** for both a live `unknown` decision and a restored legacy unknown item.
- [x] **Step 2: Run the two targeted test files** and verify failures show the missing daily gate/remaining short timer.
- [x] **Step 3: Add the minimal daily gate** to the live skip branch and persisted-state migration.
- [x] **Step 4: Re-run the targeted tests** and verify they pass.

### Task 3: Verify the complete HH regression set and desktop build

**Files:**
- Verify only.

**Interfaces:**
- Consumes: Task 1 and Task 2 behavior.
- Produces: fresh test/build evidence.

- [x] **Step 1: Run all HH-related Vitest files.**
- [x] **Step 2: Run desktop TypeScript typecheck.**
- [x] **Step 3: Run the desktop production build.**
- [x] **Step 4: Inspect `git diff`** and confirm only intended HH files plus this plan changed in this task.

### Task 4: Repair and verify the current Dev HH configuration safely

**Files:**
- Update through the running Electron HH assistant API; do not edit persisted JSON directly.

**Interfaces:**
- Consumes: authenticated HH résumés returned by `hhAssistant.getResumes()`.
- Produces: one explicitly confirmed QA Automation Engineer Python résumé, `autoRunDaily: true`, and the existing search/filter settings retained.

- [x] **Step 1: Back up the current HH state** to the existing recoverable backup directory.
- [x] **Step 2: Install/start the verified Dev build** without changing production builds.
- [x] **Step 3: Select exactly one QA Automation Engineer Python résumé** through `saveConfig(..., resumeSelectionExplicitlyConfirmed: true)`; abort if selection is ambiguous.
- [x] **Step 4: Temporarily set `autoSend: false` and run one discovery**; assert that a scan completes and no `sentAt` count changes.
- [x] **Step 5: Restore `autoSend: true` and `autoRunDaily: true`** only after the dry-run evidence is clean.
- [x] **Step 6: Confirm the daily-search timer exists and the stale unknown vacancy is daily-blocked rather than queue-eligible.**
