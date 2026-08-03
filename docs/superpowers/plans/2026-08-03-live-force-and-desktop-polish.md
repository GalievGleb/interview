# SkillCue Live Force and Desktop Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a source-aware, delayed-transcript-safe Ctrl+Enter flow and fix the reported desktop UI, theme, persistence, and installer regressions.

**Architecture:** Keep automatic interview triggering on the interviewer channel, but give explicit forced answers a separate source-aware ledger and latest-wins generation. Move packaged SQLite into Electron userData with both runtime and NSIS migration, and make visual behavior deterministic through small pure helpers plus CSS contracts.

**Tech Stack:** React 19, TypeScript, Electron 33, Vitest, FastAPI, pytest, electron-builder NSIS.

## Global Constraints

- Ctrl+Enter must prefer a delayed spoken final over the screen fallback.
- If no final arrives, capture the screen automatically and never show the “no recorded phrase” error.
- The overlay is always dark; the main window still follows the selected theme.
- Existing persistent data must never be overwritten by migration.
- Every production behavior change starts with a failing test.

---

### Task 1: Source-aware forced answer coordination

**Files:**
- Modify: `apps/desktop/src/lib/forceLiveAnswer.test.ts`
- Modify: `apps/desktop/src/lib/forceLiveAnswer.ts`
- Modify: `apps/desktop/src/lib/latestForcedAnswer.test.ts`
- Modify: `apps/desktop/src/lib/latestForcedAnswer.ts`
- Modify: `apps/desktop/src/hooks/useLiveCopilot.ts`
- Modify: `apps/api-py/tests/test_stt_openai_mini_only.py`
- Modify: `apps/api-py/app/services/stt/openai_mini_stream.py`

**Interfaces:**
- Produces: `selectForceTargetSource(sources, speaking, unconsumed)`.
- Produces: `ForcedTranscriptLine.source?: 'mic' | 'system'`.
- Produces: current forced generation stays finalizable after `acceptEmpty()`.

- [ ] **Step 1: Write failing source-selection tests**

```ts
expect(selectForceTargetSource(
  { mic: true, system: true },
  { mic: true, system: false },
  { mic: 0, system: 0 },
)).toBe('mic');
expect(selectForceTargetSource(
  { mic: true, system: true },
  { mic: false, system: false },
  { mic: 4, system: 0 },
)).toBe('mic');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm test -- src/lib/forceLiveAnswer.test.ts`

Expected: FAIL because the selector ignores speaking and unconsumed finals.

- [ ] **Step 3: Implement the minimal selector and source-aware ledger**

```ts
export interface ForceChannelState { mic: number | boolean; system: number | boolean }
export function selectForceTargetSource(
  sources: LiveSources,
  speaking: Record<'mic' | 'system', boolean>,
  unconsumed: Record<'mic' | 'system', number>,
): 'mic' | 'system' | null;
```

Append finals from both live sources, filter immediate candidates by the selected source, and keep normal auto-answer scheduling limited to `triggerSpeakerRef`.

- [ ] **Step 4: Write and run failing delayed-final tests**

```ts
coordinator.press([], 'mic');
expect(coordinator.acceptEmpty('force-1')).toMatchObject({ action: 'wait' });
expect(coordinator.acceptFinal({ sequence: 1, text: 'Что такое тестирование?', source: 'mic' }))
  .toMatchObject({ action: 'submit', question: 'Что такое тестирование?' });
```

Run: `pnpm test -- src/lib/latestForcedAnswer.test.ts`

Expected: FAIL because empty finalization is terminal.

- [ ] **Step 5: Keep the active generation open during the grace window**

Change `acceptEmpty()` to retain the active request and return `wait`; the hook shortens the pending timeout after an empty event. Clear the timeout when either request-bound or id-less matching final arrives.

- [ ] **Step 6: Accept short transcripts only for explicit forced finalization**

Add a pytest stream case where the provider returns `Какие виды?` for a request-bound finalization. Update the server so forced non-empty text bypasses only the minimum-word and duplicate gates, while automatic STT keeps the normal quality gate.

- [ ] **Step 7: Run focused desktop and API tests**

Run: `pnpm test -- src/lib/forceLiveAnswer.test.ts src/lib/latestForcedAnswer.test.ts`

Run: `apps/api-py/.venv/Scripts/python.exe -m pytest apps/api-py/tests/test_stt_openai_mini_only.py -q`

Expected: PASS.

### Task 2: Automatic screen fallback

**Files:**
- Modify: `apps/desktop/src/hooks/useLiveCopilot.ts`
- Modify: `apps/desktop/src/pages/OverlayPage.tsx`
- Modify: `apps/desktop/src/pages/OverlayPage.behavior.test.ts`
- Modify: `apps/desktop/src/lib/liveOverlaySync.test.ts`

**Interfaces:**
- Produces: `forceScreenFallbackGeneration: number` from `useLiveCopilot()`.
- Consumes: existing `runScreenAssist('', mode)`.

- [ ] **Step 1: Add a failing behavior contract**

Assert that an async forced fallback invokes screen assistance once per generation and that immediate `unavailable` routes directly to screen assistance rather than constructing `overlay.forceUnavailable` text.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm test -- src/pages/OverlayPage.behavior.test.ts`

Expected: FAIL because the page still renders the unavailable warning.

- [ ] **Step 3: Implement generation-based fallback**

On forced timeout/empty grace expiry, publish a new fallback generation without user-facing error text. In the overlay, consume each fallback generation exactly once and call `runScreenAssist('', smart ? 'deep' : 'general')` before the generic live-exchange effect can overwrite it.

- [ ] **Step 4: Verify latest-wins cancellation**

Add a test that a second Ctrl+Enter supersedes a pending fallback generation and does not restore the previous exchange.

- [ ] **Step 5: Run focused tests**

Run: `pnpm test -- src/pages/OverlayPage.behavior.test.ts src/lib/liveOverlaySync.test.ts`

Expected: PASS.

### Task 3: Stable overlay input and permanent dark theme

**Files:**
- Modify: `apps/desktop/src/styles/overlay-cockpit.css`
- Modify: `apps/desktop/src/styles/desktopPolish.test.ts`
- Create: `apps/desktop/src/lib/theme.test.ts`
- Modify: `apps/desktop/src/lib/theme.ts`

**Interfaces:**
- Produces: sticky renderer-local `forceDarkTheme()` behavior.

- [ ] **Step 1: Add failing CSS and theme tests**

Require `.ovl-input` to have one fixed height, require `.ovl-input:focus-visible { outline: none; }`, reject `.ovl-input:focus { height: ... }`, and simulate a light-theme storage event after `forceDarkTheme()`.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm test -- src/styles/desktopPolish.test.ts src/lib/theme.test.ts`

Expected: FAIL on focus growth and one-shot forced theme.

- [ ] **Step 3: Remove the layout-changing focus behavior**

Keep the wrapper border constant, remove the focus height transition, and explicitly suppress the textarea's focus-visible ring. This prevents the ellipsis button from moving between pointer down and pointer up.

- [ ] **Step 4: Make dark forcing sticky**

Store a renderer-local `forcedDark` flag and make every later `apply()` resolve to dark when it is active.

- [ ] **Step 5: Run focused tests**

Expected: PASS.

### Task 4: Light title bar, larger context rail, unclipped preparation row

**Files:**
- Create: `apps/desktop/electron/titleBarTheme.ts`
- Create: `apps/desktop/electron/titleBarTheme.test.ts`
- Modify: `apps/desktop/electron/main.ts`
- Modify: `apps/desktop/electron/preload.ts`
- Modify: `apps/desktop/src/types/electron.d.ts`
- Modify: `apps/desktop/src/lib/theme.ts`
- Modify: `apps/desktop/src/pages/HomePage.tsx`
- Modify: `apps/desktop/src/components/Sidebar.tsx`
- Modify: `apps/desktop/src/styles/prepare.css`
- Modify: `apps/desktop/src/styles/prepareHistoryLayout.test.ts`

**Interfaces:**
- Produces: `window.electronAPI.window.setTitleBarTheme('dark' | 'light')`.

- [ ] **Step 1: Add failing title-bar token tests**

```ts
expect(titleBarTheme('light')).toEqual({ color: '#f7fafd', symbolColor: '#142033', height: 44 });
expect(titleBarTheme('dark')).toEqual({ color: '#0c1726', symbolColor: '#c7d3e2', height: 44 });
```

- [ ] **Step 2: Implement sender-scoped IPC**

Only requests originating from `mainWindow.webContents` may change `mainWindow.setTitleBarOverlay(...)`; overlay theme forcing must not affect the main title bar.

- [ ] **Step 3: Add failing layout contracts**

Require a context column of at least `360px`, remove the two-line clamp from context details, and require vertical padding on the sidebar navigation scroll container.

- [ ] **Step 4: Implement the layout changes**

Widen the context rail, increase row padding/min-height, allow three detail lines, and add `py-1` to the navigation element.

- [ ] **Step 5: Run focused tests**

Run: `pnpm test -- electron/titleBarTheme.test.ts src/styles/prepareHistoryLayout.test.ts src/styles/desktopPolish.test.ts`

Expected: PASS.

### Task 5: Persistent resume data and one-click installer

**Files:**
- Create: `apps/desktop/electron/backendData.ts`
- Create: `apps/desktop/electron/backendData.test.ts`
- Modify: `apps/desktop/electron/main.ts`
- Create: `apps/desktop/build/installer.nsh`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src/lib/installerAssets.test.ts`

**Interfaces:**
- Produces: `preparePersistentBackendData(userData, resourcesPath)` returning the persistent SQLite path.
- Produces: `DATABASE_URL=sqlite:///.../backend-data/copilot.sqlite` for packaged backend spawn.

- [ ] **Step 1: Add failing migration tests**

Create temporary legacy and persistent directories. Assert legacy database/WAL files copy only when the persistent database is absent, and assert a second call never overwrites existing persistent content.

- [ ] **Step 2: Run test and verify RED**

Run: `pnpm test -- electron/backendData.test.ts`

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement runtime migration and database URL**

Create `<userData>/backend-data`, copy legacy files from `resources/backend/_internal/data` or `resources/backend/data`, and set the packaged backend spawn environment to the resulting SQLite URL.

- [ ] **Step 4: Add failing NSIS contract**

Require `oneClick: true`, `allowToChangeInstallationDirectory: false`, `deleteAppDataOnUninstall: false`, and an installer include that migrates from `$INSTDIR` and `$DESKTOP\Skillcue` after `_CHECK_APP_RUNNING` but before old-version uninstall.

- [ ] **Step 5: Implement one-click installer and pre-uninstall migration**

Use `customCheckAppRunning` to wait for the app to stop, copy the legacy database plus WAL/SHM only when the persistent destination is empty, and let the standard one-click progress UI continue.

- [ ] **Step 6: Run focused tests**

Run: `pnpm test -- electron/backendData.test.ts src/lib/installerAssets.test.ts`

Expected: PASS.

### Task 6: Release verification

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src/lib/releaseNotes.ts`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump the desktop release and add Russian release notes**

Set the next patch version consistently and describe the forced-answer, overlay, persistence, theme, and installer fixes.

- [ ] **Step 2: Run complete regressions**

Run: `pnpm test`, `pnpm lint`, `pnpm typecheck`, and `pnpm exec tsc --noEmit -p tsconfig.electron.json` in `apps/desktop`.

Run: `.venv/Scripts/python.exe -m pytest -q` and `.venv/Scripts/ruff.exe check app tests` in `apps/api-py`.

- [ ] **Step 3: Request code review**

Review all files changed by this plan for P0-P2 defects. Fix confirmed findings and rerun focused tests.

- [ ] **Step 4: Build and smoke-test the package**

Run: `pnpm dist:full` in `apps/desktop`.

Run: `scripts/smoke-packaged.ps1` from the repository root with the built backend.

- [ ] **Step 5: Publish safely**

Upload `latest.yml`, `SkillCue-Setup.exe`, and its blockmap to a draft release, compare local SHA-256 values with GitHub asset digests, publish only after all match, and verify the public latest manifest reports the new version.
