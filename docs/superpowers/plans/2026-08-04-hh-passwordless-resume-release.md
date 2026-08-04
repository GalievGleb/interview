# HH Passwordless Resume Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the post-`0.0.19` HH passwordless and real-resume fixes through the desktop updater without mutating the already published release.

**Architecture:** Keep HH browser automation inside `HhBrowserAssistant`, expose resume discovery through the existing preload/IPC boundary, and render search settings only after a browser-authenticated HH session. Publish the changes as `0.0.20` because updater clients compare semantic versions and cannot receive overwritten `0.0.19` assets.

**Tech Stack:** Electron, Playwright Core, React 19, TypeScript, Vitest, electron-builder, GitHub Actions.

## Global Constraints

- Preserve all five shared-worktree HH changes; do not revert or replace them.
- Passwordless login uses `backurl=/applicant/resumes` and must avoid a second submit after automatic code completion.
- Search filters remain hidden until HH authentication is confirmed.
- Resume selection comes from the authenticated browser session, not free text.
- Release through the existing GitHub updater as `0.0.20`.

---

### Task 1: HH integration contract

**Files:**
- Modify: `apps/desktop/src/pages/HhApplicationsPage.behavior.test.ts`
- Verify: `apps/desktop/electron/hhBrowserAssistant.ts`
- Verify: `apps/desktop/electron/main.ts`
- Verify: `apps/desktop/electron/preload.ts`
- Verify: `apps/desktop/src/types/electron.d.ts`

**Interfaces:**
- Consumes: `requestLoginCode(email)`, `confirmLoginCode(code)`.
- Produces: `getResumes(): Promise<Array<{ id: string; title: string; url: string }>>`.

- [x] **Step 1:** Add source-contract assertions for the applicant-resumes back URL, `/404` recovery, no generic second submit, resume IPC wiring, authenticated gating, and real resume `<select>`.
- [x] **Step 2:** Run `pnpm test -- src/pages/HhApplicationsPage.behavior.test.ts` and confirm the shared changes satisfy the contract.
- [x] **Step 3:** Run the HH policy suites and both renderer/Electron typechecks.

### Task 2: Full regression and release metadata

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `CHANGELOG.md`
- Modify: `apps/desktop/src/lib/releaseNotes.ts`

**Interfaces:**
- Consumes: the verified HH integration from Task 1.
- Produces: updater-visible desktop version `0.0.20`.

- [x] **Step 1:** Update release metadata to `0.0.20` and describe only the HH follow-up changes.
- [x] **Step 2:** Run all desktop tests, ESLint, renderer typecheck, Electron typecheck, and production build.
- [x] **Step 3:** Build the frozen backend and NSIS installer, then smoke-test the packaged backend.

### Task 3: Publication

**Files:**
- Verify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: commit with package version `0.0.20`.
- Produces: public `v0.0.20` release assets and `latest.yml`.

- [ ] **Step 1:** Commit all verified HH changes and release metadata while excluding generated `apps/api-py/build/` output.
- [ ] **Step 2:** Push `main`, create and push annotated tag `v0.0.20`.
- [ ] **Step 3:** Wait for GitHub Actions and verify `SkillCue-Setup.exe`, blockmap, and public `latest.yml` all report `0.0.20`.
