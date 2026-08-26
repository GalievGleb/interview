# macOS Overlay Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the sidebar hide control and make the packaged macOS overlay start cleanly, remain usable when system-audio capture is unavailable, and ship with the permissions/runtime needed for supported macOS audio capture.

**Architecture:** Keep platform behavior behind small pure helpers so Windows and macOS branches are independently testable. Treat microphone and system audio as independent live sources: a failed optional system source must not poison a working microphone session. Make the transparent native window correct before React's first paint, and validate the packaged Info.plist in release CI.

**Tech Stack:** Electron, React, TypeScript, Vitest, electron-builder, GitHub Actions.

**Spec:** User report and macOS v0.0.40 screenshot supplied on 2026-08-25.

## Global Constraints

- Preserve all unrelated dirty-tree work.
- Do not publish or tag a release without explicit authorization.
- Keep Windows overlay and audio behavior working.
- macOS must fall back to microphone-only operation instead of showing a fatal system-audio error.
- Every runtime change follows RED → GREEN TDD.

---

### Task 1: Restore the hide control with platform-correct behavior

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.tsx`
- Modify: `apps/desktop/src/components/Sidebar.test.ts`
- Create: `apps/desktop/electron/appVisibility.ts`
- Create: `apps/desktop/electron/appVisibility.test.ts`
- Modify: `apps/desktop/electron/main.ts`

**Interfaces:**
- Produces: `setAppHiddenFromSwitcher(platform, skip, window, dock)`.

- [ ] Write failing tests proving the sidebar exposes the taskbar/Dock hide action and macOS uses `app.dock.hide/show` while Windows uses `BrowserWindow.setSkipTaskbar`.
- [ ] Run focused tests and observe the missing behavior.
- [ ] Add the sidebar state/action and platform helper; wire the IPC handler.
- [ ] Re-run focused tests.

### Task 2: Make dual-source audio fail soft and enable modern macOS capture

**Files:**
- Create: `apps/desktop/src/lib/audioSourceFailure.ts`
- Create: `apps/desktop/src/lib/audioSourceFailure.test.ts`
- Modify: `apps/desktop/src/hooks/useLiveCopilot.ts`
- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `audioSourceFailureMessage(failedSource, activeSources, label, message)` returning an empty string only when microphone capture remains active after system capture fails.

- [ ] Write failing tests for system-failure-with-mic and sole-source failure.
- [ ] Run focused tests and observe RED.
- [ ] Implement fail-soft source removal and retain diagnostics.
- [ ] Upgrade the pinned Electron runtime to a macOS CoreAudio-capable supported version and add `NSAudioCaptureUsageDescription`.
- [ ] Re-run focused tests and typechecks.

### Task 3: Remove overlay first-paint artifacts and cover the app behind it

**Files:**
- Modify: `apps/desktop/electron/windowLifecycle.ts`
- Modify: `apps/desktop/electron/windowLifecycle.test.ts`
- Modify: `apps/desktop/electron/main.ts`
- Modify: `apps/desktop/src/components/OverlayAppIcon.tsx`
- Create or modify: `apps/desktop/src/components/OverlayAppIcon.test.ts`

**Interfaces:**
- Produces: `openOverlayOverWorkspace(main, showOverlay)`.

- [ ] Write failing tests proving explicit overlay opening hides the main app and icon dimensions exist before CSS.
- [ ] Run focused tests and observe RED.
- [ ] Add transparent native background/no-shadow, explicit image dimensions, and lifecycle wiring.
- [ ] Re-run focused tests.

### Task 4: Strengthen macOS release verification

**Files:**
- Modify: `apps/desktop/electron/macPlatform.test.ts`
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: packaged `SkillCue.app/Contents/Info.plist`.

- [ ] Write a failing distribution test for audio permissions and packaged plist verification.
- [ ] Run it and observe RED.
- [ ] Add `plutil` assertions for microphone/audio-capture descriptions alongside the existing packaged-app launch smoke.
- [ ] Re-run distribution tests.

### Task 5: Verification and dev handoff

**Files:**
- No production files.

- [ ] Run focused suites, full desktop tests, renderer/Electron typechecks, ESLint, and `git diff --check`.
- [ ] Build the Windows dev artifact to ensure cross-platform packaging still succeeds.
- [ ] Report that public v0.0.40 remains unchanged until a new authorized release, and distinguish CI evidence from physical macOS audio evidence.
