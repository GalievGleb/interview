# SkillCue Alpha Typed Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and install a separate local `SkillCue Alpha` application that contains the current workspace changes and enables the typed/structured screen pipeline without changing Stable or Dev.

**Architecture:** Add a third signed build identity (`alpha`) with its own Electron app ID, protocol, user-data directory, API port, installer output and renderer build mode. The renderer opts into structured screen only in `alphabuild`, and the Python backend accepts that opt-in only when Electron launches it with `SKILLCUE_BUILD_CHANNEL=alpha`. Stable and Dev remain on the existing legacy screen path.

**Tech Stack:** Electron 39, TypeScript, React/Vite, electron-builder/NSIS, FastAPI/Python, Vitest, pytest, PowerShell.

**Spec:** `AI_HANDOFF_FULL_OPERATIONS.md`

## Global Constraints

- Alpha installs side by side with Stable and Dev; never overwrite their app data, ports, protocol registrations or executables.
- Typed screen is enabled only in the Alpha renderer and Alpha backend channel.
- No GitHub release, public update feed, server deploy, credential copy or secret persistence.
- Keep the typed state memory-only and preserve the existing stable/dev legacy fallback.
- Treat Alpha as experimental until the live structured 3×3 acceptance gate is 9/9.

---

### Task 1: Alpha runtime identity

**Files:**
- Modify: `apps/desktop/electron/buildChannel.test.ts`
- Modify: `apps/desktop/electron/rendererApiUrl.test.ts`
- Modify: `apps/desktop/electron/buildChannel.ts`
- Modify: `apps/desktop/electron/rendererApiUrl.ts`
- Modify: `apps/desktop/src/lib/buildChannel.ts`
- Modify: `apps/desktop/src/types/electron.d.ts`

**Interfaces:**
- Produces: `BuildChannel = 'stable' | 'dev' | 'alpha'` and an Alpha identity on port `8002`.

- [ ] Add failing tests proving packaged `alpha`, display name `SkillCue Alpha`, app ID `com.interview.assistant.alpha`, protocol `skillcue-alpha`, user data `SkillCue Alpha`, port `8002`, and unchanged shortcuts.
- [ ] Run the two Vitest files and confirm they fail because Alpha is not implemented.
- [ ] Add the minimal Alpha identity and renderer mode mapping.
- [ ] Run the tests and TypeScript typechecks.

### Task 2: Alpha-only structured pipeline gate

**Files:**
- Modify: `apps/desktop/src/lib/screenTaskStateMemory.test.ts`
- Modify: `apps/desktop/src/lib/screenTaskStateMemory.ts`
- Modify: `apps/api-py/tests/test_structured_screen_activation.py`
- Modify: `apps/api-py/app/routers/chat.py`

**Interfaces:**
- Produces: renderer opt-in for `alphabuild` only and backend acceptance for `SKILLCUE_BUILD_CHANNEL=alpha` only.

- [ ] Add failing renderer tests: Alpha true; development/devbuild/production false.
- [ ] Add failing backend route matrix: alpha+client true uses structured; dev/stable/production use legacy.
- [ ] Run Vitest and pytest and confirm the failures are caused by the missing Alpha gate.
- [ ] Implement the narrow renderer and backend checks.
- [ ] Run the focused tests and prove Dev/Stable remain legacy.

### Task 3: Private Alpha package

**Files:**
- Create: `apps/desktop/electron-builder.alpha.cjs`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/electron/productSurface.test.ts`

**Interfaces:**
- Produces: `build:alpha`, `dist:alpha:app`, `dist:alpha`, `release-alpha/SkillCue-Alpha-Setup.exe`.

- [ ] Add a failing packaging-source test for the Alpha app ID, name, protocol, metadata channel, output directory and `publish: null`.
- [ ] Run the test and confirm the missing config failure.
- [ ] Add an Alpha builder config based on the private Dev config, with isolated identifiers and no public updater.
- [ ] Add package scripts and run the packaging tests.

### Task 4: Installed Alpha smoke tooling

**Files:**
- Modify: `tools/verify_dev_overlay.py`
- Modify: `tools/tests/test_verify_real_interview_overlay.py`
- Create: `tools/install_and_verify_alpha.ps1`
- Modify: `apps/desktop/package.json`

**Interfaces:**
- Produces: channel-aware installed backend smoke and `release:alpha:verified`.

- [ ] Add failing tests for selecting `%LOCALAPPDATA%\\Programs\\skillcue-alpha`, port isolation and backend channel `alpha` without changing Dev defaults.
- [ ] Run tests and confirm the missing channel behavior.
- [ ] Add bounded `SKILLCUE_E2E_CHANNEL=alpha` support and an Alpha install script that builds, silently installs and runs the installed overlay smoke.
- [ ] Run smoke-tool tests and PowerShell syntax validation.

### Task 5: Build, install and verify

**Files:**
- Build output: `apps/desktop/release-alpha/SkillCue-Alpha-Setup.exe`
- Installed app: `%LOCALAPPDATA%\\Programs\\skillcue-alpha\\SkillCue Alpha.exe`

**Interfaces:**
- Consumes: the Alpha package and installed smoke tooling from Tasks 1–4.

- [ ] Run focused desktop/backend/package tests, Ruff, renderer/Electron typechecks and `git diff --check`.
- [ ] Run `pnpm --filter @interview/desktop dist:alpha` and verify the installer exists.
- [ ] Install the exact Alpha installer silently.
- [ ] Verify the installed executable/resources exist and start the installed backend through the Alpha smoke.
- [ ] Launch Alpha and confirm Stable/Dev data paths and ports were not modified.
- [ ] Record the exact manual typed-screen scenarios and the known experimental 3×3 limitation for the user.
