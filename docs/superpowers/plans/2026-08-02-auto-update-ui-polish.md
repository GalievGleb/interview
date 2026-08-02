# Silent Auto-Update and Desktop Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Download each update once, install and relaunch automatically without interrupting live interviews, and fix the reported title-bar, focus, sidebar, and resume-loading presentation defects.

**Architecture:** An injected Electron update coordinator owns a single check promise, downloaded state, live-session gate, and one silent-install call. Renderer components consume the same status store but render only one progress surface; visual fixes stay in focused CSS/component changes.

**Tech Stack:** Electron 33, electron-updater 6, TypeScript, Vitest, React 19, Tailwind/CSS.

## Global Constraints

- A startup check and manual check must reuse one in-flight download/check operation.
- `quitAndInstall(true, true)` runs only after download completion and outside an active live session.
- Normal flow has no install or restart button.
- The currently installed 0.0.15 build cannot execute new 0.0.16 auto-install code before it upgrades; it will still install the downloaded update on normal app exit because `autoInstallOnAppQuit` is already enabled. Every update after 0.0.16 uses immediate silent relaunch.
- Ordinary input focus is indigo/neutral, never green; success states may stay green.
- Preserve unrelated dirty-worktree changes and stage only task files.

---

### Task 1: Single-flight updater coordinator and live-session gate

**Files:**
- Create: `apps/desktop/electron/autoUpdateCoordinator.ts`
- Create: `apps/desktop/electron/autoUpdateCoordinator.test.ts`
- Modify: `apps/desktop/electron/updaterStatusStore.ts`
- Modify: `apps/desktop/electron/updaterStatusStore.test.ts`
- Modify: `apps/desktop/src/types/electron.d.ts`

**Interfaces:**
- Consumes: injected `checkForUpdates`, `installSilently`, and `publish` functions plus live/downloaded events.
- Produces: `createAutoUpdateCoordinator(deps)` with `check()`, `setLive(active)`, `markDownloaded(version)`, and `resetAfterError(message)`.

- [ ] **Step 1: Write failing single-flight and install-gate tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createAutoUpdateCoordinator } from './autoUpdateCoordinator';

describe('auto update coordinator', () => {
  it('reuses one in-flight update check', async () => {
    let resolve!: () => void;
    const checkForUpdates = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const coordinator = createAutoUpdateCoordinator({
      checkForUpdates,
      installSilently: vi.fn(),
      publish: vi.fn(),
      schedule: (fn) => fn(),
    });
    const first = coordinator.check();
    const second = coordinator.check();
    expect(checkForUpdates).toHaveBeenCalledOnce();
    resolve();
    await Promise.all([first, second]);
    await coordinator.check();
    expect(checkForUpdates).toHaveBeenCalledOnce();

    coordinator.markNoUpdate();
    await coordinator.check();
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('waits for a live session to end before installing once', () => {
    const installSilently = vi.fn();
    const publish = vi.fn();
    const coordinator = createAutoUpdateCoordinator({
      checkForUpdates: vi.fn(async () => undefined),
      installSilently,
      publish,
      schedule: (fn) => fn(),
    });
    coordinator.setLive(true);
    coordinator.markDownloaded('0.0.16');
    expect(installSilently).not.toHaveBeenCalled();
    expect(publish).toHaveBeenLastCalledWith({
      state: 'waiting-for-session-end', version: '0.0.16',
    });
    coordinator.setLive(false);
    coordinator.setLive(false);
    expect(installSilently).toHaveBeenCalledOnce();
  });

  it('installs immediately when no session is active', () => {
    const installSilently = vi.fn();
    const coordinator = createAutoUpdateCoordinator({
      checkForUpdates: vi.fn(async () => undefined),
      installSilently,
      publish: vi.fn(),
      schedule: (fn) => fn(),
    });
    coordinator.markDownloaded('0.0.16');
    expect(installSilently).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run focused Electron tests and verify failure**

Run: `pnpm --filter @interview/desktop test -- electron/autoUpdateCoordinator.test.ts electron/updaterStatusStore.test.ts`

Expected: FAIL because the coordinator and new states are absent.

- [ ] **Step 3: Extend updater status and implement the coordinator**

```ts
export type DesktopUpdaterStatus = {
  state:
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'ready'
    | 'waiting-for-session-end'
    | 'installing'
    | 'none'
    | 'error';
  version?: string;
  percent?: number;
  message?: string;
};
```

```ts
interface AutoUpdateDeps {
  checkForUpdates: () => Promise<unknown>;
  installSilently: () => void;
  publish: (status: DesktopUpdaterStatus) => void;
  schedule: (fn: () => void) => void;
}

export function createAutoUpdateCoordinator(deps: AutoUpdateDeps) {
  let checkPromise: Promise<unknown> | null = null;
  let updateCycleActive = false;
  let live = false;
  let downloadedVersion: string | null = null;
  let installStarted = false;

  const maybeInstall = () => {
    if (!downloadedVersion || installStarted) return;
    if (live) {
      deps.publish({ state: 'waiting-for-session-end', version: downloadedVersion });
      return;
    }
    installStarted = true;
    deps.publish({ state: 'installing', version: downloadedVersion });
    deps.schedule(deps.installSilently);
  };

  return {
    check(): Promise<unknown> {
      if (updateCycleActive) return checkPromise ?? Promise.resolve();
      updateCycleActive = true;
      deps.publish({ state: 'checking' });
      checkPromise = deps.checkForUpdates();
      return checkPromise;
    },
    setLive(active: boolean): void {
      live = active;
      maybeInstall();
    },
    markDownloaded(version: string): void {
      updateCycleActive = false;
      checkPromise = null;
      downloadedVersion = version;
      maybeInstall();
    },
    markNoUpdate(): void {
      updateCycleActive = false;
      checkPromise = null;
      deps.publish({ state: 'none' });
    },
    resetAfterError(message: string): void {
      updateCycleActive = false;
      checkPromise = null;
      downloadedVersion = null;
      installStarted = false;
      deps.publish({ state: 'error', message });
    },
  };
}
```

Mirror the status union in renderer `UpdaterStatus`.

- [ ] **Step 4: Run the focused tests**

Run: `pnpm --filter @interview/desktop test -- electron/autoUpdateCoordinator.test.ts electron/updaterStatusStore.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the coordinator**

```powershell
git add apps/desktop/electron/autoUpdateCoordinator.ts apps/desktop/electron/autoUpdateCoordinator.test.ts apps/desktop/electron/updaterStatusStore.ts apps/desktop/electron/updaterStatusStore.test.ts apps/desktop/src/types/electron.d.ts
git commit -m "feat: coordinate silent desktop updates"
```

### Task 2: Main-process auto-install and one progress surface

**Files:**
- Modify: `apps/desktop/electron/main.ts:50-65,600-640,722-752`
- Modify: `apps/desktop/src/components/UpdateToast.tsx`
- Modify: `apps/desktop/src/pages/SettingsPage.tsx:140-245`
- Modify: `apps/desktop/src/lib/i18n/ru.ts`
- Modify: `apps/desktop/src/lib/i18n/en.ts`
- Create: `apps/desktop/src/components/UpdateToast.test.ts`

**Interfaces:**
- Consumes: coordinator from Task 1 and `overlay:liveState(active)`.
- Produces: automatic silent install, deferred-live status, one settings progress bar, and a global toast hidden on `/settings`.

- [ ] **Step 1: Add failing source/renderer assertions**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const toast = fs.readFileSync(path.resolve(__dirname, 'UpdateToast.tsx'), 'utf8');
const settings = fs.readFileSync(path.resolve(__dirname, '../pages/SettingsPage.tsx'), 'utf8');
const main = fs.readFileSync(path.resolve(__dirname, '../../electron/main.ts'), 'utf8');

describe('automatic update UI', () => {
  it('silently installs and force-runs the downloaded update', () => {
    expect(main).toContain('quitAndInstall(true, true)');
    expect(main).toContain('updateCoordinator.markDownloaded(info.version)');
  });

  it('does not repeat download percentage in status text and a disabled button', () => {
    expect(settings).toContain('sc-progress');
    expect(settings).not.toContain("`${t('settings.update.downloading')} ${updaterStatus.percent ?? 0}%`");
  });

  it('suppresses the global toast on settings', () => {
    expect(toast).toContain("pathname === '/settings'");
  });
});
```

- [ ] **Step 2: Run the UI test and verify failure**

Run: `pnpm --filter @interview/desktop test -- src/components/UpdateToast.test.ts`

Expected: FAIL on all three new contracts.

- [ ] **Step 3: Wire coordinator events in Electron**

Create one coordinator after `updaterStatusStore`:

```ts
const updateCoordinator = createAutoUpdateCoordinator({
  checkForUpdates: () => autoUpdater.checkForUpdates(),
  installSilently: () => autoUpdater.quitAndInstall(true, true),
  publish: (status) => updaterStatusStore.publish(status),
  schedule: (fn) => setTimeout(fn, 900),
});
```

Both startup and `updater:check` call `updateCoordinator.check()`. The cycle remains locked after
the version check resolves and throughout auto-download. `update-not-available` calls
`markNoUpdate()`, `update-downloaded` calls `markDownloaded(info.version)`, and updater errors call
`resetAfterError(message)`. At the start of `overlay:liveState`, call
`updateCoordinator.setLive(active)` before forwarding renderer events. Keep
`autoDownload = true` and `autoInstallOnAppQuit = true` as safety fallbacks. Remove the normal
renderer dependency on `updater:install`; leave the IPC handler only for backwards-compatible
older renderers.

- [ ] **Step 4: Render exactly one progress/status control**

In Settings, render one `sc-progress` bar and percentage only for `downloading`. Hide the action
button for `available`, `downloading`, `waiting-for-session-end`, and `installing`; show only
`Проверить обновления` in idle/none/error states. Add copy:

- `waiting-for-session-end`: `Обновление установится сразу после завершения live-сессии.`
- `installing`: `Устанавливаю обновление и перезапускаю SkillCue…`

In `UpdateToast`, read `pathname` from `useLocation`; return `null` on `/settings`. Remove the
ready-state restart button and render the two new automatic states as status-only messages.

- [ ] **Step 5: Run tests and Electron/renderer builds**

Run:

```powershell
pnpm --filter @interview/desktop test -- electron/autoUpdateCoordinator.test.ts src/components/UpdateToast.test.ts
pnpm --filter @interview/desktop typecheck
pnpm --filter @interview/desktop build
```

Expected: PASS.

- [ ] **Step 6: Commit automatic update flow**

```powershell
git add apps/desktop/electron/main.ts apps/desktop/src/components/UpdateToast.tsx apps/desktop/src/components/UpdateToast.test.ts apps/desktop/src/pages/SettingsPage.tsx apps/desktop/src/lib/i18n/ru.ts apps/desktop/src/lib/i18n/en.ts
git commit -m "feat: install updates without extra actions"
```

### Task 3: Neutral focus, aligned title bar, and clean sidebar footer

**Files:**
- Modify: `apps/desktop/electron/main.ts:284-302`
- Modify: `apps/desktop/src/index.css:130-215,290-380`
- Modify: `apps/desktop/src/styles/prepare.css:2180-2210`
- Modify: `apps/desktop/src/styles/interview-cockpit.css:200-214`
- Modify: `apps/desktop/src/components/Sidebar.tsx:149-160`
- Create: `apps/desktop/src/styles/desktopPolish.test.ts`

**Interfaces:**
- Consumes: existing 44 px `.skillcue-titlebar`, input classes, and sidebar action footer.
- Produces: 44 px native overlay height, indigo focus tokens, and footer actions without readiness copy.

- [ ] **Step 1: Add a failing CSS/source contract test**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const main = fs.readFileSync(path.resolve(__dirname, '../../electron/main.ts'), 'utf8');
const indexCss = fs.readFileSync(path.resolve(__dirname, '../index.css'), 'utf8');
const prepareCss = fs.readFileSync(path.resolve(__dirname, 'prepare.css'), 'utf8');
const sidebar = fs.readFileSync(path.resolve(__dirname, '../components/Sidebar.tsx'), 'utf8');

describe('desktop polish contracts', () => {
  it('keeps native and CSS title bars at 44px', () => {
    expect(main).toContain('height: 44');
    expect(indexCss).toContain('@apply flex h-11');
  });
  it('does not use green accent for ordinary form focus', () => {
    expect(indexCss).not.toContain('focus:border-accent focus:ring-2 focus:ring-accent-ring');
    expect(prepareCss).not.toContain('border-color: rgba(52, 199, 123, 0.55)');
  });
  it('removes the ready label from the sidebar footer', () => {
    expect(sidebar).not.toContain("t('sidebar.ready')");
  });
});
```

- [ ] **Step 2: Run the style contract test and verify failure**

Run: `pnpm --filter @interview/desktop test -- src/styles/desktopPolish.test.ts`

Expected: FAIL on 52 px native title bar, green focus, and readiness label.

- [ ] **Step 3: Apply aligned title-bar and neutral focus styles**

Change Electron `titleBarOverlay.height` from `52` to `44`. Replace generic focus styling with:

```css
.field:focus,
.select-compact:focus {
  border-color: rgba(99, 102, 241, 0.62);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.14);
}
```

Apply the same indigo values to `.prep-textarea:focus`, `.prep-input:focus`, and
`.cockpit-command:focus-within`. Do not alter green success dots, selected readiness states,
or primary action buttons.

- [ ] **Step 4: Remove only the sidebar readiness copy**

Delete the `backendOnline && !collapsed` readiness paragraph from `Sidebar`. Keep the failed
backend message and the settings/privacy footer buttons. Remove now-unused `backendOnline`
destructuring if TypeScript reports it.

- [ ] **Step 5: Run style test, typecheck, and build**

Run:

```powershell
pnpm --filter @interview/desktop test -- src/styles/desktopPolish.test.ts
pnpm --filter @interview/desktop typecheck
pnpm --filter @interview/desktop build
```

Expected: PASS.

- [ ] **Step 6: Commit desktop polish**

```powershell
git add apps/desktop/electron/main.ts apps/desktop/src/index.css apps/desktop/src/styles/prepare.css apps/desktop/src/styles/interview-cockpit.css apps/desktop/src/components/Sidebar.tsx apps/desktop/src/styles/desktopPolish.test.ts
git commit -m "fix: polish focus and window chrome"
```

### Task 4: Resume-upload loading animation and duplicate-submit guard

**Files:**
- Modify: `apps/desktop/src/pages/DocumentsPage.tsx:210-360`
- Modify: `apps/desktop/src/lib/i18n/ru.ts`
- Modify: `apps/desktop/src/lib/i18n/en.ts`
- Modify: `apps/desktop/src/styles/prepare.css`
- Create: `apps/desktop/src/pages/DocumentsPage.behavior.test.ts`

**Interfaces:**
- Consumes: existing `api.uploadText` and `api.uploadFile` promises.
- Produces: `busyKind: 'text' | 'file' | null`, spinner/status UI, and disabled text/file controls during either upload.

- [ ] **Step 1: Add failing resume-upload behavior assertions**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'DocumentsPage.tsx'), 'utf8');

describe('document upload behavior', () => {
  it('shows a spinner and prevents duplicate file/text submissions', () => {
    expect(source).toContain("useState<'text' | 'file' | null>(null)");
    expect(source).toContain('LoaderCircle');
    expect(source).toContain('animate-spin');
    expect(source).toContain('disabled={busyKind !== null}');
    expect(source).toContain("t('docs.add.addingResume')");
  });
});
```

- [ ] **Step 2: Run the page behavior test and verify failure**

Run: `pnpm --filter @interview/desktop test -- src/pages/DocumentsPage.behavior.test.ts`

Expected: FAIL because the page has only a boolean and text label.

- [ ] **Step 3: Implement a single upload busy state**

Replace `busy` with `busyKind`. `addText` sets `text`, `onFile` sets `file`, and both reset to
`null` in `finally`. Return immediately if another operation is already active. Disable the
text button, file input, and file label for any non-null state.

```tsx
{busyKind && (
  <span className="prep-upload-progress" role="status" aria-live="polite">
    <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
    {kind === 'resume' ? t('docs.add.addingResume') : t('docs.add.addingContext')}
  </span>
)}
```

Use Russian strings `Добавляю резюме…` and `Добавляю контекст…`. Leave errors visible and
restore both controls after failure.

- [ ] **Step 4: Run tests, typecheck, and build**

Run:

```powershell
pnpm --filter @interview/desktop test -- src/pages/DocumentsPage.behavior.test.ts
pnpm --filter @interview/desktop typecheck
pnpm --filter @interview/desktop build
```

Expected: PASS.

- [ ] **Step 5: Commit resume-loading feedback**

```powershell
git add apps/desktop/src/pages/DocumentsPage.tsx apps/desktop/src/pages/DocumentsPage.behavior.test.ts apps/desktop/src/lib/i18n/ru.ts apps/desktop/src/lib/i18n/en.ts apps/desktop/src/styles/prepare.css
git commit -m "fix: show resume upload progress"
```

## Plan 3 completion checkpoint

Run:

```powershell
pnpm --filter @interview/desktop test
pnpm --filter @interview/desktop lint
pnpm --filter @interview/desktop typecheck
pnpm --filter @interview/desktop build
```

Expected: every command PASS. In a packaged test build, simulate `update-downloaded` both with
and without a live session; verify one install call, no duplicated percentage, and no live-session
termination. Upload a PDF resume and verify an immediate spinner until the refreshed document list
appears.
