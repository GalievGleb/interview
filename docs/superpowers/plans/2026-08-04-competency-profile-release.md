# Competency Profile Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved competency-profile redesign through the desktop updater as `0.0.22` without regressing the HH changes in `0.0.21`.

**Architecture:** Keep the existing development-profile API unchanged. Render professional scope and evidence in `PersonalProgressPage`, persist voluntary self-assessment under the versioned local key, and keep all new presentation rules in `prepare.css`.

**Tech Stack:** React 19, TypeScript, Vitest, Vite, Electron, electron-builder, GitHub Actions.

## Global Constraints

- Exact `/100` requires `technical.evidenceCount >= 3` and `technical.confidence >= 0.55`.
- Core topics come from the chosen specialization; optional topics count only when explicitly selected.
- Missing or irrelevant topics display as unknown and do not reduce the profile.
- Self-assessment is voluntary and visually separate from interview evidence.
- Release version is `0.0.22`; updater repository remains `GalievGleb/SkillCue`.
- Only profile, CSS, tests, release metadata, specification, and this plan may be staged.

---

### Task 1: Isolate and verify the delegated profile

**Files:**
- Modify: `apps/desktop/src/pages/PersonalProgressPage.tsx`
- Modify: `apps/desktop/src/pages/PersonalProgressPage.behavior.test.ts`
- Modify: `apps/desktop/src/styles/prepare.css`

**Interfaces:**
- Consumes: `api.getDevelopmentProfile()` and `DevelopmentProfile`.
- Produces: consent flow, specialization scope, evidence-gated score, competency map, and session history.

- [x] **Step 1:** Create `codex/release-0.0.22` from public `origin/main` at `v0.0.21`.
- [x] **Step 2:** Transfer only the three delegated profile files and verify their SHA-256 hashes match the shared worktree.
- [x] **Step 3:** Run `pnpm test -- src/pages/PersonalProgressPage.behavior.test.ts` and both TypeScript checks; expect success.
- [x] **Step 4:** Build production assets and visually verify consent, assessment, completed profile, exact score gating, and absence of horizontal overflow.

### Task 2: Release metadata and regression

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `CHANGELOG.md`
- Modify: `apps/desktop/src/lib/releaseNotes.ts`

**Interfaces:**
- Consumes: the verified profile implementation.
- Produces: desktop version `0.0.22` and Russian in-app release notes.

- [x] **Step 1:** Set version `0.0.22` and document the profile rules.
- [x] **Step 2:** Run all desktop tests, lint, renderer/Electron typechecks, and production build.
- [x] **Step 3:** Build the NSIS installer and run smoke against its bundled frozen backend.

### Task 3: Publish and verify updater

**Files:**
- Verify: `apps/desktop/release/latest.yml`

**Interfaces:**
- Consumes: committed `0.0.22` release tree.
- Produces: public installer, blockmap, and updater metadata.

- [x] **Step 1:** Review and commit only the scoped files.
- [ ] **Step 2:** Fast-forward `main`, create annotated tag `v0.0.22`, and wait for the release workflow.
- [ ] **Step 3:** Verify the public release assets and confirm latest `latest.yml` reports `version: 0.0.22`.
