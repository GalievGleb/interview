# HH Auto-Apply Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the HH applications tab discover fresh vacancies incrementally, send at a safe pace, stop globally on persistent HH verification, resume automatically after cooldown, and show truthful queue state.

**Architecture:** Keep HH automation in `HhBrowserAssistant`, but move timing and budget decisions into pure policy helpers. Persist one global verification cooldown, use a dedicated timer to resume it, and distinguish automatic cooldown from manual intervention in state/UI. Search remains newest-first and round-robin across synonyms, with a global page budget and an early stop after a fully known page.

**Tech Stack:** Electron, TypeScript, Playwright, React, Vitest.

**Spec:** Live evidence from `2026-08-25`: one run found 87 known vacancies, retried 22 gated vacancies in about 5–7 seconds each, received 22 persistent HH verifications, and sent 0.

## Global Constraints

- Do not launch HH or submit any live application during development or verification.
- Preserve all existing dirty-tree work and edit only the HH automation/UI files needed by this plan.
- Do not bypass HH verification; pause and retry later.
- Automatic mode must not require the user to babysit cooldown retries.
- Employer questions and unknown personal facts remain fail-closed.

---

### Task 1: Pure reliability policy

**Files:**
- Modify: `apps/desktop/electron/hhAutoApplyPolicy.ts`
- Test: `apps/desktop/electron/hhAutoApplyPolicy.test.ts`

**Interfaces:**
- Produces: `hhDiscoveryPageBudget(queryCount, configuredMaxPages)`, `hhVerificationCooldownUntil(now)`, `isFutureIsoTimestamp(value, now)`.

- [x] **Step 1: Write failing policy tests**

```ts
expect(hhDiscoveryPageBudget(9, 20)).toBe(20);
expect(hhDiscoveryPageBudget(9, 1)).toBe(9);
expect(isFutureIsoTimestamp(hhVerificationCooldownUntil(now), now)).toBe(true);
```

- [x] **Step 2: Run the focused policy test and verify RED**

Run: `pnpm --filter @interview/desktop exec vitest run electron/hhAutoApplyPolicy.test.ts`

- [x] **Step 3: Implement the minimal pure helpers**

Use a two-hour cooldown and a global discovery budget that still visits every query's first page.

- [x] **Step 4: Run the focused policy test and verify GREEN**

### Task 2: Queue circuit breaker, cooldown persistence, and pacing

**Files:**
- Modify: `apps/desktop/electron/hhBrowserAssistant.ts`
- Test: `apps/desktop/electron/hhBrowserAssistantQueueRecovery.test.ts`
- Test: `apps/desktop/src/pages/HhApplicationsPage.behavior.test.ts`

**Interfaces:**
- Consumes: Task 1 policy helpers.
- Produces: `HhAssistantState.verificationCooldownUntil`, persisted state version 10, automatic verification-resume timer.

- [x] **Step 1: Replace the old captcha-continuation test with failing regressions**

```ts
expect(apply).toHaveBeenCalledTimes(1);
expect(stats).toMatchObject({ attempted: 1, blocked: true, cooldown: true });
expect(assistant.getState().verificationCooldownUntil).toBeTruthy();
```

Also assert manual bulk runs exclude `daily`-gated vacancies and queue processing waits between successful/nonfatal attempts.

- [x] **Step 2: Run focused tests and verify RED for the old behavior**

- [x] **Step 3: Implement minimal circuit-breaker behavior**

On persistent verification, gate the current vacancy until a scheduled retry, set the global cooldown, stop the queue, close the immediate run as an automatic pause, and schedule a new automatic run when the cooldown expires. A manual bulk run must not override daily gates; explicit single-vacancy actions remain separately controlled.

- [x] **Step 4: Implement queue pacing**

Call an overridable wait method between vacancy attempts using `delayBetweenSec` plus jitter. Never wait after a blocker, stop, or final item.

- [x] **Step 5: Run focused queue tests and verify GREEN**

### Task 3: Incremental newest-first discovery

**Files:**
- Modify: `apps/desktop/electron/hhBrowserAssistant.ts`
- Test: `apps/desktop/src/pages/HhApplicationsPage.behavior.test.ts`

**Interfaces:**
- Consumes: `hhDiscoveryPageBudget`.
- Produces: round-robin global page budget and known-page early stop.

- [x] **Step 1: Write failing source/behavior regressions**

Assert the scan no longer multiplies queries by `maxPages`, uses the pure global budget, and stops a query when an entire newest page already exists in the prior queue.

- [x] **Step 2: Verify RED**

- [x] **Step 3: Implement incremental scan**

Visit every synonym's first page, spend only the remaining global page budget on deeper pages, and mark a query exhausted after a full page of already-known vacancy IDs. Add a small jittered wait between search pages.

- [x] **Step 4: Verify GREEN**

### Task 4: Truthful applications UI

**Files:**
- Modify: `apps/desktop/src/types/electron.d.ts`
- Modify: `apps/desktop/src/pages/HhApplicationsPage.tsx`
- Test: `apps/desktop/src/pages/HhQueueUiState.test.ts`
- Test: `apps/desktop/src/pages/HhApplicationsPage.behavior.test.ts`

**Interfaces:**
- Consumes: `verificationCooldownUntil`, `lastScanSummary`, queue gates.
- Produces: cooldown banner/status, distinct new/known counts, no manual-action wording for automatic verification pauses.

- [x] **Step 1: Write failing UI-state tests**

Assert daily verification items render as `Пауза HH`, have no manual apply button in automatic mode, and the page exposes the cooldown deadline plus new/known scan counts.

- [x] **Step 2: Verify RED**

- [x] **Step 3: Implement minimal UI changes**

Render an automatic cooldown message, count verification-gated items independently of manual gates, and describe the latest scan as new versus already-known instead of only `found`.

- [x] **Step 4: Verify GREEN**

### Task 5: Integrated verification

**Files:**
- No production changes unless a gate identifies a regression.

- [x] **Step 1: Run all focused HH suites**

Run policy, queue recovery/retry/stop/navigation, assistant policy, queue UI, and page behavior suites.

- [x] **Step 2: Run renderer and Electron typechecks**

- [x] **Step 3: Run desktop lint and `git diff --check`**

- [x] **Step 4: Run the complete desktop test suite**

- [x] **Step 5: Report exact changed files and verification evidence**
