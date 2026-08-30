# Calendar Wheel and HR Drafts Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore page scrolling over the weekly calendar and prefill every pending HR dialog with a safe, candidate-aware draft that the user reviews before sending, then publish the verified release everywhere.

**Architecture:** Keep the calendar grid vertically non-scrollable but allow vertical scroll chaining to its page while containing only horizontal overscroll. Persist an optional `suggestedAnswer` with each HR decision and expose one idempotent Electron IPC operation that backfills missing drafts from the exact selected résumé and confirmed facts; unknown facts use an explicit editable placeholder and are never sent automatically. Release artifacts are built locally, verified, then uploaded/deployed without paid hosted runners.

**Tech Stack:** React 19, TypeScript, Electron IPC, Playwright, Vitest, electron-builder, FastAPI/Node gateway deployment.

**Spec:** `docs/superpowers/specs/2026-08-30-calendar-wheel-hr-drafts-release.md`

## Global Constraints

- Do not send real HH messages or applications during tests.
- Do not expose HH messages, résumé contents, cookies, API keys, or deployment credentials.
- Preserve all unrelated dirty-worktree changes.
- Do not use paid GitHub-hosted build runners; produce release artifacts locally.

---

### Task 1: Let the Calendar page consume vertical wheel gestures

**Files:**
- Modify: `apps/desktop/src/styles/interview-calendar.css`
- Test: `apps/desktop/src/styles/interviewCalendarLayout.test.ts`

**Interfaces:**
- Produces: `.interview-week-scroll` with horizontal containment and vertical scroll chaining.
- Preserves: `overflow-y: hidden` on the weekly grid container.

- [ ] **Step 1: Write the failing test** asserting `overscroll-behavior-x: contain`, `overscroll-behavior-y: auto`, and absence of the all-axis `overscroll-behavior: contain` shorthand.
- [ ] **Step 2: Run** `pnpm --filter @interview/desktop test -- src/styles/interviewCalendarLayout.test.ts` and verify the failure identifies the current all-axis containment.
- [ ] **Step 3: Replace only the overscroll shorthand** while retaining horizontal overflow and vertical clipping.
- [ ] **Step 4: Re-run the focused test** and verify it passes.

### Task 2: Persist and backfill review-only HR answer drafts

**Files:**
- Modify: `apps/desktop/electron/hhChatBrowser.ts`
- Modify: `apps/desktop/electron/hhChatBrowser.test.ts`
- Modify: `apps/desktop/electron/main.ts`
- Modify: `apps/desktop/electron/preload.ts`
- Modify: `apps/desktop/src/types/electron.d.ts`

**Interfaces:**
- Extends: `HhChatPendingDecision` with `suggestedAnswer?: string` and `vacancyUrl?: string`.
- Produces: `HhChatBrowser.prepareDecisionDrafts(): Promise<HhChatState>`.
- Produces IPC: `hh-chat:prepare-decision-drafts` and renderer API `hhChat.prepareDecisionDrafts()`.

- [ ] **Step 1: Write a failing behavior test** that restores a pending personal-fact decision, calls `prepareDecisionDrafts()`, and expects a résumé-grounded draft while no HH send method is called.
- [ ] **Step 2: Write a failing fallback test** that expects a non-empty visibly incomplete draft when the model returns no answer.
- [ ] **Step 3: Run the focused chat tests** and verify both fail because the API and persisted draft do not yet exist.
- [ ] **Step 4: Implement the idempotent draft generator** using the selected résumé, confirmed facts, recruiter message, a bounded LLM call, output sanitization, and a deterministic unresolved-fact fallback.
- [ ] **Step 5: Store vacancy identity on newly created decisions** and expose the new operation through main/preload/types.
- [ ] **Step 6: Re-run the focused chat tests** and verify they pass without an outbound message.

### Task 3: Prefill and review drafts in the HR dialog UI

**Files:**
- Modify: `apps/desktop/src/pages/HhApplicationsPage.tsx`
- Create: `apps/desktop/src/lib/hhChatDecisionDrafts.ts`
- Create: `apps/desktop/src/lib/hhChatDecisionDrafts.test.ts`
- Test: `apps/desktop/src/pages/HhApplicationsPage.behavior.test.ts`

**Interfaces:**
- Consumes: `hhChat.prepareDecisionDrafts()` and `decision.suggestedAnswer`.
- Produces: one editable textarea per pending decision, automatically populated once and never overwritten after the user edits it.

- [ ] **Step 1: Write a failing page behavior test** proving the page requests missing drafts, renders `decision.suggestedAnswer`, and no longer relies on a contract-only hardcoded fallback.
- [ ] **Step 2: Run the focused page test** and verify the expected failure.
- [ ] **Step 3: Add an idempotent loading effect and per-card loading state**; hydrate local textarea state only when the user has not edited that decision.
- [ ] **Step 4: Add concise review/loading copy** and keep send buttons explicit.
- [ ] **Step 5: Re-run the focused page test** and verify it passes.

### Task 4: Functional and visual Electron verification

**Files:**
- Verify only; screenshots/reports may go under `output/`.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: evidence for wheel propagation, populated HR textarea, viewport fit, and no outbound HH side effects.

- [ ] **Step 1: Run the full desktop Vitest suite and TypeScript typecheck.**
- [ ] **Step 2: Build and install the Dev application.**
- [ ] **Step 3: Launch the installed Electron build with Playwright** and verify a vertical wheel over the calendar moves the page while the grid stays vertically fixed.
- [ ] **Step 4: Stage a local pending decision without network sending** and verify the HR draft appears, remains editable, and the card fits the launched and reduced window sizes.
- [ ] **Step 5: Complete a 30–90 second exploratory pass** over calendar navigation, horizontal overflow, HR refresh, draft editing, and return navigation.

### Task 5: Publish and deploy the verified release

**Files:**
- Modify: `package.json`
- Modify: `apps/api/package.json`
- Modify: `apps/desktop/package.json`
- Modify: `packages/shared/package.json`
- Modify: `apps/api-py/pyproject.toml`
- Modify: `apps/api-py/app/main.py`
- Modify: `apps/desktop/src/lib/releaseNotes.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: one consistent patch version in every package and health endpoint.
- Produces: locally built Windows installer/update metadata, updated Dev install, and deployed gateway/site.

- [ ] **Step 1: Bump all release metadata to the next patch version** and add concise Russian release notes/changelog entries.
- [ ] **Step 2: Run release-metadata tests plus all API, desktop, and packaging checks required by the repository.**
- [ ] **Step 3: Build the frozen backend and stable/Dev installers locally; verify installed Dev smoke gates.**
- [ ] **Step 4: Commit the preserved working tree, push the release branch, integrate to `main`, and create the matching version tag without force operations.**
- [ ] **Step 5: Upload the locally built release artifacts and update metadata without a hosted GitHub build.**
- [ ] **Step 6: Deploy the gateway/site over the existing SSH path and run public health/download smoke checks.**
