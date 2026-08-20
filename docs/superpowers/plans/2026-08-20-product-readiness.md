# Product Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make download, activation, live-overlay readiness, first use, and HH automation reliable enough for a new paying customer.

**Architecture:** Put release validation and installed-app smoke checks in CI/tools, not in the customer UI. Add a small renderer readiness scheduler that calls the existing provider endpoint and uses the existing Electron notification surface only on failure. Keep checkout recovery browser-based and diagnostics privacy-safe by construction.

**Tech Stack:** Electron, React, TypeScript, Vitest, GitHub Actions, static HTML/JavaScript, Python smoke tooling.

**Spec:** `docs/product-readiness-v1.md`

## Global Constraints

- Stable builds contain no debug screens, synthetic questions, test recordings, or diagnostic test buttons.
- Every behavior change follows RED→GREEN TDD.
- Do not create a real payment or publish a release without separate confirmation.
- Do not stage or modify tracked PyInstaller build artifacts under `apps/api-py/build/skillcue-backend`.

---

### Task 1: Fail-fast stable release metadata

**Files:**
- Create: `tools/verify_release_metadata.mjs`
- Create: `tools/verify_release_metadata.test.mjs`
- Modify: `.github/workflows/release.yml`
- Modify: `apps/desktop/package.json`

**Interfaces:**
- Consumes: `GITHUB_REF_NAME`, desktop `package.json`, `releaseNotes.ts`, `CHANGELOG.md`.
- Produces: CLI exit code 0 only for matching `vX.Y.Z` stable metadata.

- [ ] Write Node tests with temporary package/notes/changelog fixtures covering a valid release, a `-dev` package, and tag/version mismatch.
- [ ] Run `node --test tools/verify_release_metadata.test.mjs` and verify RED because the validator does not exist.
- [ ] Implement `verifyReleaseMetadata({ root, tag })` plus a CLI entry point.
- [ ] Run the Node tests and verify GREEN.
- [ ] Add the verifier as the first release workflow step before Python/PyInstaller work.

### Task 2: Silent live readiness before interviews

**Files:**
- Create: `apps/desktop/src/lib/liveReadinessMonitor.ts`
- Create: `apps/desktop/src/lib/liveReadinessMonitor.test.ts`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/electron/main.ts`
- Modify: `apps/desktop/electron/preload.ts`
- Modify: `apps/desktop/src/types/electron.d.ts`

**Interfaces:**
- Consumes: `api.providerReadiness()`, saved `InterviewCalendarEvent[]`, current time.
- Produces: `nextLiveReadinessCheck(events, now)` and a privacy-safe system warning IPC.

- [ ] Test that startup checks once, an interview within 60 minutes schedules a check, completed/past interviews do not, and repeated identical failures are deduplicated.
- [ ] Run the focused Vitest file and verify RED.
- [ ] Implement the pure scheduler/deduper and connect it in `App.tsx` without adding visible debug controls.
- [ ] Expose a main-process notification method accepting only title/body/category, and reject arbitrary URLs or secrets.
- [ ] Run focused tests, renderer/electron typechecks, and verify GREEN.

### Task 3: Checkout recovery without a real charge

**Files:**
- Create: `landing/pay-success.test.mjs`
- Modify: `landing/pay-success.html`

**Interfaces:**
- Consumes: checkout status `{ status, key }`.
- Produces: visible key, copy action, deep link, persistent payment recovery, and explicit manual instructions.

- [ ] Write DOM/source tests asserting the key remains visible, copy fallback works without Clipboard API, payment id persists, polling offers retry, and support remains reachable.
- [ ] Run the test and verify RED on the missing clipboard fallback/retry behavior.
- [ ] Implement a `copyActivationKey()` fallback using a temporary textarea and a retry button that restarts polling without creating a payment.
- [ ] Run the test and verify GREEN.

### Task 4: Compact first-use product path

**Files:**
- Modify: `apps/desktop/src/pages/HomePage.tsx`
- Modify: `apps/desktop/src/pages/HomePage.behavior.test.ts`

**Interfaces:**
- Consumes: existing candidate sources, HH state, and normal overlay launcher.
- Produces: one compact normal-product checklist: resume → HH → live.

- [ ] Add failing source/behavior assertions that the next incomplete product step is primary and completed steps collapse, with no `/onboarding` route or test-overlay action.
- [ ] Run focused tests and verify RED.
- [ ] Implement the minimal Home-page path using existing navigation and `launchLive`; add no diagnostic UI.
- [ ] Run focused tests and renderer typecheck; verify GREEN.

### Task 5: HH discovery and diagnostic reliability

**Files:**
- Modify: `apps/desktop/electron/hhBrowserAssistant.ts`
- Modify: `apps/desktop/electron/hhBrowserAssistantReuse.test.ts`
- Modify: `apps/desktop/electron/hhAutomationDiagnostics.ts`
- Modify: `apps/desktop/electron/hhAutomationDiagnostics.test.ts`

**Interfaces:**
- Consumes: persisted v8 config/queue and scheduler events.
- Produces: automatic 500→5,000 migration, queue restoration through 5,000, and safe findings for transient retry/coverage.

- [ ] Preserve the already-watched RED regressions for legacy 500 and 1,001 restored entries.
- [ ] Verify both regressions GREEN after the minimal migration/normalizer changes.
- [ ] Add a failing diagnostic test that reports coverage (`found/sent/skipped/retry`) without vacancy descriptions or answers.
- [ ] Implement the safe aggregate and run retry/reuse/diagnostic tests plus Electron typecheck.

### Task 6: Privacy-safe optional operational telemetry

**Files:**
- Create: `apps/desktop/electron/operationalTelemetry.ts`
- Create: `apps/desktop/electron/operationalTelemetry.test.ts`
- Modify: `apps/desktop/electron/main.ts`
- Modify: `apps/desktop/src/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: opt-in boolean and allowlisted event `{ category, code, count, version }`.
- Produces: local bounded telemetry buffer/export; network upload remains disabled until a reviewed server endpoint exists.

- [ ] Write failing tests that reject keys/cookies/resume/transcript/answer fields and cap the local buffer.
- [ ] Implement the allowlist and local buffer.
- [ ] Add an explicit off-by-default privacy setting and local export wording; do not add upload code.
- [ ] Run tests/typechecks and verify GREEN.

### Task 7: Release candidate verification and handoff

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `apps/desktop/src/lib/releaseNotes.ts`
- Modify: `docs/HH_AUTOMATION_DIAGNOSTICS.md`

**Interfaces:**
- Consumes: completed tasks and stable version chosen at release time.
- Produces: a verified but unpublished release candidate and exact publication checklist.

- [ ] Run API pytest/Ruff/mypy, shared build, both desktop typechecks, full desktop tests, release metadata fixture tests, and `git diff --check`.
- [ ] Build/install Dev and run `pnpm --filter @interview/desktop verify:dev:overlay`; keep all smoke tooling outside stable package resources.
- [ ] Inspect packaged file list to prove `tools/`, fixtures, reports, and test recordings are absent.
- [ ] Stop before creating a payment, stable tag, or public release and present the exact external actions for confirmation.
