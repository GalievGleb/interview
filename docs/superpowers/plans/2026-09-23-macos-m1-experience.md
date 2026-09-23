# SkillCue macOS M1 Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the SkillCue Alpha main window start cleanly and responsively on Apple-silicon Macs, and make macOS audio-permission recovery actionable.

**Architecture:** Keep the main renderer independent from backend cold start, create the overlay renderer lazily behind a readiness boundary, and expose a small platform/permission bridge from Electron main to the renderer. Apply macOS-only layout rules through a synchronous platform data attribute so Windows stays unchanged.

**Tech Stack:** Electron 39, React 19, TypeScript, Vitest, Tailwind/CSS, GitHub Actions macOS runners

**Spec:** `docs/superpowers/specs/2026-09-23-macos-m1-experience.md`

## Global Constraints

- Preserve the untracked `apps/api-py/$db` file.
- Keep Windows overlay shortcuts and click-through behavior unchanged.
- Do not publish a macOS build unless both `arm64` and `x64` packaged smoke tests pass.
- Treat a physical-Mac audio/TCC check as separate from CI process smoke tests.

---

### Task 1: Native-titlebar safe area

**Files:**
- Modify: `apps/desktop/electron/preload.ts`
- Modify: `apps/desktop/src/types/electron.d.ts`
- Modify: `apps/desktop/src/main.tsx`
- Modify: `apps/desktop/src/index.css`
- Test: `apps/desktop/src/lib/runtimePlatform.test.ts`
- Create: `apps/desktop/src/lib/runtimePlatform.ts`

**Interfaces:**
- Produces: `applyRuntimePlatform(root, platform): void`, and `window.electronAPI.platform`.

- [ ] **Step 1: Write the failing test** proving `darwin` is written to `documentElement.dataset.platform` and other supported values are normalized.
- [ ] **Step 2: Run** `pnpm --filter @interview/desktop test -- runtimePlatform.test.ts` and verify the missing implementation fails.
- [ ] **Step 3: Implement** the platform bridge and call `applyRuntimePlatform(document.documentElement, window.electronAPI?.platform)` before React mounts.
- [ ] **Step 4: Add** macOS-only expanded/collapsed sidebar safe-area CSS so traffic lights never share the brand's rectangle.
- [ ] **Step 5: Run** the focused test and `pnpm --filter @interview/desktop typecheck`.

### Task 2: No startup overlay and no blank first-open window

**Files:**
- Create: `apps/desktop/electron/lazyWindow.ts`
- Test: `apps/desktop/electron/lazyWindow.test.ts`
- Modify: `apps/desktop/electron/main.ts`

**Interfaces:**
- Produces: `LazyWindow<T>.peek(): T | null`, `getOrCreate(): T`, and `showWhenReady(show): Promise<void>`.

- [ ] **Step 1: Write the failing test** proving the factory is not called at construction/startup, is called once on demand, and visibility waits for the renderer-ready promise.
- [ ] **Step 2: Run** `pnpm --filter @interview/desktop test -- lazyWindow.test.ts` and verify RED.
- [ ] **Step 3: Implement** the minimal lazy window holder and replace eager `overlayWindow = createOverlayWindow()` startup creation.
- [ ] **Step 4: Ensure** overlay IPC and global shortcuts call the lazy holder and show only after `did-finish-load` on the first open.
- [ ] **Step 5: Run** focused lifecycle/shortcut tests.

### Task 3: Immediate application shell and concurrent startup probes

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/context/AppContext.tsx`
- Test: `apps/desktop/src/AppStartup.test.tsx`
- Test: `apps/desktop/src/context/AppContextStartup.test.tsx`

**Interfaces:**
- The shell renders while `loading === true`; backend-dependent controls continue consuming `backendOnline`, `keys`, `license`, and `loading` independently.

- [ ] **Step 1: Write a failing component test** proving the sidebar/main shell is present while startup data is pending.
- [ ] **Step 2: Write a failing context test** proving key/STT/license probes are launched concurrently after health succeeds.
- [ ] **Step 3: Run the tests** and confirm both fail for the current blocking/serial behavior.
- [ ] **Step 4: Remove the full-window Gate wait**, retain granular status values, and parallelize independent requests with `Promise.allSettled`.
- [ ] **Step 5: Prefetch route chunks after the first rendered frame** instead of waiting for an idle callback that may occur after the first click.
- [ ] **Step 6: Run** both focused tests and typecheck.

### Task 4: macOS audio permission recovery

**Files:**
- Create: `apps/desktop/electron/mediaPermissions.ts`
- Test: `apps/desktop/electron/mediaPermissions.test.ts`
- Modify: `apps/desktop/electron/main.ts`
- Modify: `apps/desktop/electron/preload.ts`
- Modify: `apps/desktop/src/types/electron.d.ts`
- Modify: `apps/desktop/src/pages/OverlayPage.tsx`
- Modify: `apps/desktop/src/lib/i18n/ru.ts`
- Modify: `apps/desktop/src/lib/i18n/en.ts`

**Interfaces:**
- Produces renderer bridge `mediaPermissions.get()`, `requestMicrophone()`, and `openSettings(kind)`.

- [ ] **Step 1: Write failing policy tests** for `granted`, `denied`, `restricted`, and non-macOS behavior.
- [ ] **Step 2: Run** the policy tests and verify RED.
- [ ] **Step 3: Implement** Electron `systemPreferences` checks and safe `x-apple.systempreferences` navigation.
- [ ] **Step 4: Add** an overlay action beside audio permission/silence errors; do not open System Settings without a user click.
- [ ] **Step 5: Run** focused tests and typecheck.

### Task 5: Cross-platform verification and release candidate

**Files:**
- Modify only if tests expose a defect: `.github/workflows/alpha-macos.yml`

**Interfaces:**
- Consumes all preceding behavior and produces two verified DMGs.

- [ ] **Step 1: Run** `pnpm --filter @interview/shared build`.
- [ ] **Step 2: Run** `pnpm --filter @interview/desktop typecheck`.
- [ ] **Step 3: Run** `pnpm --filter @interview/desktop test`.
- [ ] **Step 4: Run** `pnpm --filter @interview/desktop build:alpha`.
- [ ] **Step 5: Push the branch**, run the macOS Alpha workflow for both architectures, and inspect failed logs rather than bypassing smoke checks.
- [ ] **Step 6: On a physical M1 Mac**, verify launch, traffic-light spacing, first overlay open, microphone prompt/recovery, system-audio signal, and three consecutive live answers before publication.
