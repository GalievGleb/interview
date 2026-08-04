# HH Find-and-Apply Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the final three-step HH automation setup with multi-resume selection and one enable action through the desktop updater as `0.0.21`.

**Architecture:** Keep setup orchestration in `HhApplicationsPage`: select real resumes, persist filters with `autoRunDaily: true`, enable the schedule, await `scan()`, then call `applyAll()`. Store the new selection in `resumeTitles[]`; `HhBrowserAssistant` ranks only selected resumes by keyword overlap while retaining `resumeTitleContains` as a legacy fallback.

**Tech Stack:** React 19, Electron, TypeScript, Vitest, electron-builder, GitHub Actions.

## Global Constraints

- The only action button label is exactly `Включить автоотклики`.
- The action order is exactly `saveConfig(autoRunDaily: true)` → `setDailySchedule(true)` → `scan()` → `applyAll()`.
- Manual `Найти сейчас`, `Запустить`, and `Найти и откликнуться` controls are absent.
- At least one real HH resume must be selected before enabling automation.
- `resumeTitles[]` is normalized and deduplicated; `resumeTitleContains` remains a migration fallback.
- The release version is `0.0.21`; do not overwrite public `0.0.20`.
- Publish updater assets to the renamed repository `GalievGleb/SkillCue`.
- Do not stage unrelated grant, landing, billing, or support worktree changes.

---

### Task 1: Final HH setup and regression

**Files:**
- Modify: `apps/desktop/src/pages/HhApplicationsPage.behavior.test.ts`
- Modify: `apps/desktop/src/pages/HhApplicationsPage.tsx`
- Modify: `apps/desktop/electron/hhAssistantPolicy.ts`
- Modify: `apps/desktop/electron/hhAssistantPolicy.test.ts`
- Modify: `apps/desktop/electron/hhBrowserAssistant.ts`
- Modify: `apps/desktop/src/types/electron.d.ts`

**Interfaces:**
- Consumes: real HH resumes plus `saveConfig()`, `setDailySchedule()`, `scan()`, and `applyAll()`.
- Produces: a three-step setup, normalized multi-resume configuration, and ranked resume selection.

- [x] **Step 1:** Add tests for the three-step UI, multi-select resume contract, schedule enablement, immediate scan/apply order, legacy migration, and ranked selection.
- [x] **Step 2:** Run the tests against `0.0.20` and confirm failures for missing `resumeTitles`, multi-select UI, and automatic schedule flow.
- [x] **Step 3:** Apply the delegated six-file implementation without restoring manual action buttons.
- [x] **Step 4:** Run the HH policy tests, renderer/Electron typechecks, lint, and visual production check.

### Task 2: Patch release metadata and updater target

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `CHANGELOG.md`
- Modify: `apps/desktop/src/lib/releaseNotes.ts`

**Interfaces:**
- Consumes: verified HH full-cycle action.
- Produces: version `0.0.21` whose embedded updater and CI publish target are `GalievGleb/SkillCue`.

- [x] **Step 1:** Set the desktop version to `0.0.21` and preserve the current `SkillCue` updater repository from `main`.
- [x] **Step 2:** Add Russian `0.0.21` changelog and in-app release notes describing the full-cycle button.
- [x] **Step 3:** Run all desktop tests, lint, and both TypeScript checks.

### Task 3: Build and publication

**Files:**
- Verify: `apps/desktop/release/latest.yml`

**Interfaces:**
- Consumes: committed version `0.0.21`.
- Produces: public installer, blockmap, and `latest.yml` for automatic updates.

- [x] **Step 1:** Build the frozen backend and NSIS installer with `pnpm dist:full` and run `scripts/smoke-packaged.ps1`.
- [x] **Step 2:** Review and commit only the HH fix, regression, release metadata, and plan.
- [ ] **Step 3:** Push the release commit to `main`, create annotated tag `v0.0.21`, and wait for the release workflow.
- [ ] **Step 4:** Verify the public release assets and confirm `releases/latest/download/latest.yml` reports `version: 0.0.21`.
