# Live Answer and Overlay Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make repeated `Ctrl+Enter` target the newest spoken question and make every transparent overlay pixel click-through without breaking visible controls.

**Architecture:** A pure latest-request-wins coordinator owns forced-answer generations and transcript cursors; `useLiveCopilot` remains responsible for STT/LLM I/O. Separate pure overlay geometry and pointer helpers drive an always-on Electron click-through policy plus viewport-clamped menus and tooltips.

**Tech Stack:** React 19, TypeScript 5.7, Vitest 2, Electron 33, CSS, OpenAI Mini streaming STT.

## Global Constraints

- A newer `Ctrl+Enter` supersedes all older forced STT and LLM work.
- Every final transcript event is persisted even when stale for answer generation.
- Spoken or typed questions never trigger screen capture.
- Transparent overlay pixels always pass clicks to the application below.
- `Ctrl+Shift+H`, Hide, and Escape hide only the overlay.
- Preserve unrelated changes in the existing dirty worktree; stage only files named by each task.

---

### Task 1: Latest-forced-answer coordinator

**Files:**
- Create: `apps/desktop/src/lib/latestForcedAnswer.ts`
- Create: `apps/desktop/src/lib/latestForcedAnswer.test.ts`
- Modify: `apps/desktop/src/lib/forceLiveAnswer.ts`
- Modify: `apps/desktop/src/lib/forceLiveAnswer.test.ts`

**Interfaces:**
- Consumes: final trigger-speaker lines `{ sequence: number; text: string }`, a source (`mic`, `system`, or `null`), and generated request IDs.
- Produces: `LatestForcedAnswerCoordinator`, `ForceDecision`, `ForceAcceptDecision`, and current `ForceSnapshot`.

- [ ] **Step 1: Write failing rapid-press and stale-result tests**

```ts
import { describe, expect, it } from 'vitest';
import { LatestForcedAnswerCoordinator } from './latestForcedAnswer';

describe('LatestForcedAnswerCoordinator', () => {
  it('lets the newest Ctrl+Enter supersede an older finalization', () => {
    const ids = ['force-1', 'force-2'];
    const coordinator = new LatestForcedAnswerCoordinator(() => ids.shift()!);

    expect(coordinator.press([], 'system')).toMatchObject({
      action: 'flush', generation: 1, requestId: 'force-1', source: 'system',
    });
    expect(coordinator.press([], 'system')).toMatchObject({
      action: 'flush', generation: 2, requestId: 'force-2', source: 'system',
    });

    expect(coordinator.acceptFinal({ sequence: 1, text: 'Старый вопрос' }, 'force-1'))
      .toEqual({ action: 'store-only' });
    expect(coordinator.acceptFinal({ sequence: 2, text: 'Какие техники тест-дизайна?' }, 'force-2'))
      .toMatchObject({
        action: 'submit', generation: 2, question: 'Какие техники тест-дизайна?',
      });
  });

  it('uses a newer id-less final while forced STT is pending', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-1');
    coordinator.press([], 'system');

    expect(coordinator.acceptFinal({ sequence: 7, text: 'Что проверять кроме 200?' }))
      .toMatchObject({ action: 'submit', generation: 1, sequence: 7 });
    expect(coordinator.snapshot()).toMatchObject({
      phase: 'waiting-first-token', consumedSequence: 7, generation: 1,
    });
  });

  it('submits an already finalized unconsumed question without STT flush', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'unused');
    expect(coordinator.press([{ sequence: 3, text: 'Как бороться с flaky тестами?' }], 'system'))
      .toMatchObject({
        action: 'submit', generation: 1, sequence: 3,
        question: 'Как бороться с flaky тестами?',
      });
  });

  it('reports empty audio only for the current request', () => {
    const ids = ['old', 'current'];
    const coordinator = new LatestForcedAnswerCoordinator(() => ids.shift()!);
    coordinator.press([], 'mic');
    coordinator.press([], 'mic');
    expect(coordinator.acceptEmpty('old')).toEqual({ action: 'store-only' });
    expect(coordinator.acceptEmpty('current')).toMatchObject({
      action: 'empty', generation: 2,
    });
  });
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm --filter @interview/desktop test -- src/lib/latestForcedAnswer.test.ts`

Expected: FAIL because `latestForcedAnswer.ts` does not exist.

- [ ] **Step 3: Implement the coordinator**

```ts
export type ForcePhase =
  | 'idle'
  | 'finalizing-transcript'
  | 'waiting-first-token'
  | 'streaming'
  | 'done'
  | 'error';

export interface ForcedTranscriptLine {
  sequence: number;
  text: string;
}

export interface ForceSnapshot {
  generation: number;
  consumedSequence: number;
  requestId: string | null;
  phase: ForcePhase;
}

export type ForceDecision =
  | { action: 'submit'; generation: number; sequence: number; question: string }
  | { action: 'flush'; generation: number; requestId: string; source: 'mic' | 'system' }
  | { action: 'unavailable'; generation: number };

export type ForceAcceptDecision =
  | { action: 'submit'; generation: number; sequence: number; question: string }
  | { action: 'empty'; generation: number }
  | { action: 'store-only' };

export class LatestForcedAnswerCoordinator {
  private state: ForceSnapshot = {
    generation: 0,
    consumedSequence: 0,
    requestId: null,
    phase: 'idle',
  };
  private readonly requestGenerations = new Map<string, number>();

  constructor(private readonly createRequestId: () => string = () => crypto.randomUUID()) {}

  snapshot(): ForceSnapshot {
    return { ...this.state };
  }

  press(lines: ForcedTranscriptLine[], source: 'mic' | 'system' | null): ForceDecision {
    const generation = this.state.generation + 1;
    const line = [...lines].reverse().find((item) => item.sequence > this.state.consumedSequence);
    if (line) {
      this.state = {
        generation,
        consumedSequence: line.sequence,
        requestId: null,
        phase: 'waiting-first-token',
      };
      return { action: 'submit', generation, sequence: line.sequence, question: line.text };
    }
    if (!source) {
      this.state = { ...this.state, generation, requestId: null, phase: 'error' };
      return { action: 'unavailable', generation };
    }
    const requestId = this.createRequestId();
    this.requestGenerations.set(requestId, generation);
    this.state = { ...this.state, generation, requestId, phase: 'finalizing-transcript' };
    return { action: 'flush', generation, requestId, source };
  }

  acceptFinal(line: ForcedTranscriptLine, requestId?: string): ForceAcceptDecision {
    const generation = requestId
      ? this.requestGenerations.get(requestId)
      : this.state.phase === 'finalizing-transcript'
        ? this.state.generation
        : undefined;
    if (requestId) this.requestGenerations.delete(requestId);
    if (generation !== this.state.generation || line.sequence <= this.state.consumedSequence) {
      return { action: 'store-only' };
    }
    this.state = {
      generation,
      consumedSequence: line.sequence,
      requestId: null,
      phase: 'waiting-first-token',
    };
    return { action: 'submit', generation, sequence: line.sequence, question: line.text };
  }

  acceptEmpty(requestId: string): ForceAcceptDecision {
    const generation = this.requestGenerations.get(requestId);
    this.requestGenerations.delete(requestId);
    if (generation !== this.state.generation) return { action: 'store-only' };
    this.state = { ...this.state, requestId: null, phase: 'error' };
    return { action: 'empty', generation };
  }

  setPhase(generation: number, phase: ForcePhase): boolean {
    if (generation !== this.state.generation) return false;
    this.state = { ...this.state, phase };
    return true;
  }

  reset(): void {
    this.requestGenerations.clear();
    this.state = { generation: 0, consumedSequence: 0, requestId: null, phase: 'idle' };
  }
}
```

Keep `forceLiveAnswer.ts` only for non-coordinator helpers still used elsewhere; remove the old pending-request gate and update its tests so no exported function contradicts the coordinator.

- [ ] **Step 4: Run the coordinator and force-policy tests**

Run: `pnpm --filter @interview/desktop test -- src/lib/latestForcedAnswer.test.ts src/lib/forceLiveAnswer.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the isolated coordinator**

```powershell
git add apps/desktop/src/lib/latestForcedAnswer.ts apps/desktop/src/lib/latestForcedAnswer.test.ts apps/desktop/src/lib/forceLiveAnswer.ts apps/desktop/src/lib/forceLiveAnswer.test.ts
git commit -m "fix: coordinate latest forced live answer"
```

### Task 2: Wire latest-request-wins into STT and the answer card

**Files:**
- Modify: `apps/desktop/src/hooks/useLiveCopilot.ts:146-1137`
- Modify: `apps/desktop/src/lib/liveOverlaySync.ts`
- Modify: `apps/desktop/src/lib/liveOverlaySync.test.ts`
- Modify: `apps/desktop/src/pages/OverlayPage.tsx:180-630`
- Modify: `apps/desktop/src/pages/OverlayPage.behavior.test.ts`

**Interfaces:**
- Consumes: `LatestForcedAnswerCoordinator` from Task 1 and existing `LiveSession.flush(requestId)`.
- Produces: every force press yields a new generation, `forcePhase`, and a pending card; only current generations may submit or mutate it.

- [ ] **Step 1: Add failing hook/UI contract tests**

```ts
it('does not block a second Ctrl+Enter behind forcePendingRef', () => {
  expect(hookSource).toContain('forceCoordinatorRef.current.press');
  expect(hookSource).not.toContain("if (forcePendingRef.current) return 'finalizing'");
});

it('stores final transcript before deciding whether it may answer', () => {
  const appendAt = hookSource.indexOf('appendLine(trimmed, true, speaker)');
  const acceptAt = hookSource.indexOf('forceCoordinatorRef.current.acceptFinal');
  expect(appendAt).toBeGreaterThan(-1);
  expect(acceptAt).toBeGreaterThan(appendAt);
});

it('replaces the pending card on every forced generation', () => {
  expect(overlaySource).toContain('forceGeneration');
  expect(overlaySource).toContain("request: t('overlay.forceRequest')");
  expect(overlaySource).not.toContain("setNotice(t('overlay.forceSent'))");
});
```

Define `hookSource` and `overlaySource` with the same `fs.readFileSync` pattern already used by `OverlayPage.behavior.test.ts`.

- [ ] **Step 2: Run the behavior tests and verify failure**

Run: `pnpm --filter @interview/desktop test -- src/pages/OverlayPage.behavior.test.ts src/lib/liveOverlaySync.test.ts`

Expected: FAIL on the old `forcePendingRef` guard and missing generation contract.

- [ ] **Step 3: Integrate a ref-backed transcript ledger and coordinator**

Use these refs and one helper inside `useLiveCopilot`:

```ts
const transcriptSequenceRef = useRef(0);
const triggerFinalLedgerRef = useRef<ForcedTranscriptLine[]>([]);
const forceCoordinatorRef = useRef(new LatestForcedAnswerCoordinator());
const [forceGeneration, setForceGeneration] = useState(0);
const [forcePhase, setForcePhase] = useState<ForcePhase>('idle');

const appendTriggerFinal = useCallback((text: string): ForcedTranscriptLine => {
  const line = { sequence: ++transcriptSequenceRef.current, text: text.trim() };
  triggerFinalLedgerRef.current = [...triggerFinalLedgerRef.current.slice(-39), line];
  return line;
}, []);

const syncForceSnapshot = useCallback(() => {
  const snapshot = forceCoordinatorRef.current.snapshot();
  setForceGeneration(snapshot.generation);
  setForcePhase(snapshot.phase);
  setForcePending(snapshot.phase === 'finalizing-transcript');
}, []);
```

`forceAnswer` must cancel the previous LLM stream, call `press(...)` on every invocation,
sync the snapshot, submit immediately for `submit`, and call the selected `LiveSession.flush`
for `flush`. Do not check `speechInProgressRef` before forcing because the server owns the
authoritative pending-audio decision.

In `onTranscript`, execute `appendLine`, `persistTranscriptLine`, and ledger insertion before
calling `acceptFinal`. For `store-only`, return only after persistence. For `submit`, clear
the pending debounce/buffer and call `askQuestion(decision.question)`. In `onForceEmpty` and
`onLowQuality`, show `live.forceNoAudio` only when `acceptEmpty(requestId)` returns `empty`.
Stale `onUtteranceEnd` events must not clear the newest generation.

Reset the coordinator, ledger, and sequence on session start/stop. Return `forceGeneration`
and `forcePhase` from the hook.

- [ ] **Step 4: Make the overlay card generation-aware**

```ts
useEffect(() => {
  if (!forceGeneration) return;
  if (forcePhase === 'finalizing-transcript' || forcePhase === 'waiting-first-token') {
    setExchange({
      label: 'Live',
      request: currentQuestion || t('overlay.forceRequest'),
      text: '',
      streaming: true,
    });
  }
}, [forceGeneration, forcePhase, currentQuestion, t]);
```

Keep the existing 200 ms renderer/global-hotkey duplicate suppression for the same physical
keypress, but do not suppress later presses. Remove detached `notice` copy for forced answers.
Update `deriveLiveOverlayView` to use `forcePhase` instead of treating all pending states as one
boolean.

- [ ] **Step 5: Run focused tests and full desktop typecheck**

Run:

```powershell
pnpm --filter @interview/desktop test -- src/lib/latestForcedAnswer.test.ts src/lib/liveOverlaySync.test.ts src/pages/OverlayPage.behavior.test.ts
pnpm --filter @interview/desktop typecheck
```

Expected: both commands PASS.

- [ ] **Step 6: Commit the live pipeline integration**

```powershell
git add apps/desktop/src/hooks/useLiveCopilot.ts apps/desktop/src/lib/liveOverlaySync.ts apps/desktop/src/lib/liveOverlaySync.test.ts apps/desktop/src/pages/OverlayPage.tsx apps/desktop/src/pages/OverlayPage.behavior.test.ts
git commit -m "fix: answer the newest live question"
```

### Task 3: Always-on click-through and bounded floating surfaces

**Files:**
- Create: `apps/desktop/src/lib/overlayPointerPolicy.ts`
- Create: `apps/desktop/src/lib/overlayPointerPolicy.test.ts`
- Create: `apps/desktop/src/components/OverlayTooltipLayer.tsx`
- Modify: `apps/desktop/src/pages/OverlayPage.tsx:250-1120`
- Modify: `apps/desktop/src/styles/overlay-cockpit.css`

**Interfaces:**
- Consumes: DOM elements marked `data-overlay-hit="true"`, anchor/panel rectangles, and viewport dimensions.
- Produces: `shouldCaptureOverlayPointer`, `clampFloatingPanel`, and one delegated tooltip layer.

- [ ] **Step 1: Write failing pointer and geometry tests**

```ts
import { describe, expect, it } from 'vitest';
import { clampFloatingPanel, shouldCaptureOverlayPointer } from './overlayPointerPolicy';

describe('overlay pointer policy', () => {
  it('captures only an explicit visible hit region', () => {
    expect(shouldCaptureOverlayPointer({ closest: () => null } as never)).toBe(false);
    expect(shouldCaptureOverlayPointer({ closest: () => ({}) } as never)).toBe(true);
  });

  it('clamps a tooltip at the left and top edges', () => {
    expect(clampFloatingPanel(
      { left: 4, top: 3, right: 44, bottom: 27, width: 40, height: 24 },
      { width: 220, height: 48 },
      { width: 680, height: 780 },
      'top',
    )).toEqual({ left: 8, top: 35 });
  });

  it('keeps a tall menu inside the native window', () => {
    const result = clampFloatingPanel(
      { left: 520, top: 500, right: 560, bottom: 540, width: 40, height: 40 },
      { width: 300, height: 600 },
      { width: 680, height: 780 },
      'top',
    );
    expect(result.left).toBe(372);
    expect(result.top).toBe(172);
  });
});
```

- [ ] **Step 2: Run the geometry test and verify failure**

Run: `pnpm --filter @interview/desktop test -- src/lib/overlayPointerPolicy.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement pointer and floating-position helpers**

```ts
export const OVERLAY_HIT_SELECTOR = '[data-overlay-hit="true"]';
export type FloatingPlacement = 'top' | 'bottom';

export function shouldCaptureOverlayPointer(element: Pick<Element, 'closest'> | null): boolean {
  return Boolean(element?.closest(OVERLAY_HIT_SELECTOR));
}

export function clampFloatingPanel(
  anchor: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  preferred: FloatingPlacement,
  margin = 8,
): { left: number; top: number } {
  const left = Math.min(
    Math.max(anchor.left + anchor.width / 2 - panel.width / 2, margin),
    Math.max(margin, viewport.width - panel.width - margin),
  );
  const topCandidate = preferred === 'top'
    ? anchor.top - panel.height - margin
    : anchor.bottom + margin;
  const opposite = preferred === 'top'
    ? anchor.bottom + margin
    : anchor.top - panel.height - margin;
  const fits = topCandidate >= margin && topCandidate + panel.height <= viewport.height - margin;
  const top = Math.min(
    Math.max(fits ? topCandidate : opposite, margin),
    Math.max(margin, viewport.height - panel.height - margin),
  );
  return { left: Math.round(left), top: Math.round(top) };
}
```

- [ ] **Step 4: Apply click-through to transparent pixels in every mode**

Replace the `avoidFocus`-conditional effect with an always-on mousemove handler:

```ts
useEffect(() => {
  const setClickThrough = window.electronAPI?.overlay.setClickThrough;
  if (!setClickThrough) return;
  let captures = false;
  void setClickThrough(true);
  const onMove = (event: MouseEvent) => {
    const next = shouldCaptureOverlayPointer(document.elementFromPoint(event.clientX, event.clientY));
    if (next === captures) return;
    captures = next;
    void setClickThrough(!next);
  };
  window.addEventListener('mousemove', onMove);
  return () => {
    window.removeEventListener('mousemove', onMove);
    void setClickThrough(true);
  };
}, []);
```

Mark the pill, response/recap card, command panel, transcript card, and open menus with
`data-overlay-hit="true"`. Do not mark `.ovl-root` or transparent layout wrappers.
Keep `avoidFocus` only in the `setFocusable` effect.

- [ ] **Step 5: Add the delegated tooltip layer and clamp the ellipsis menu**

`OverlayTooltipLayer` listens to `pointerover`, `pointerout`, `focusin`, and `focusout` on
the overlay root, reads the nearest `.tip[data-tip]`, measures a single fixed tooltip,
and calls `clampFloatingPanel`. Render it once under `.ovl-root`; remove tooltip
`::before`/`::after` pseudo-elements from CSS.

Measure `menuRef` after opening and apply the same helper:

```ts
const [menuPosition, setMenuPosition] = useState({ left: 8, top: 64 });
useLayoutEffect(() => {
  if (!menuOpen || !menuButtonRef.current || !menuPanelRef.current) return;
  setMenuPosition(clampFloatingPanel(
    menuButtonRef.current.getBoundingClientRect(),
    menuPanelRef.current.getBoundingClientRect(),
    { width: window.innerWidth, height: window.innerHeight },
    'top',
  ));
}, [menuOpen]);
```

Render the menu with `position: fixed`, `left`, `top`, and
`maxHeight: 'calc(100vh - 16px)'`; it may cover response text but may not leave the viewport.

- [ ] **Step 6: Run tests, typecheck, and build**

Run:

```powershell
pnpm --filter @interview/desktop test -- src/lib/overlayPointerPolicy.test.ts src/pages/OverlayPage.behavior.test.ts
pnpm --filter @interview/desktop typecheck
pnpm --filter @interview/desktop build
```

Expected: all commands PASS.

- [ ] **Step 7: Commit overlay containment**

```powershell
git add apps/desktop/src/lib/overlayPointerPolicy.ts apps/desktop/src/lib/overlayPointerPolicy.test.ts apps/desktop/src/components/OverlayTooltipLayer.tsx apps/desktop/src/pages/OverlayPage.tsx apps/desktop/src/styles/overlay-cockpit.css
git commit -m "fix: constrain overlay input and floating UI"
```

### Task 4: Hide-only shortcut lifecycle

**Files:**
- Modify: `apps/desktop/electron/windowLifecycle.ts`
- Modify: `apps/desktop/electron/windowLifecycle.test.ts`
- Modify: `apps/desktop/electron/main.ts:330-345,650-705`
- Modify: `apps/desktop/electron/overlayShortcutLifecycle.test.ts`

**Interfaces:**
- Consumes: Electron-like windows exposing `hide`, `show`, `focus`, and `isDestroyed`.
- Produces: `hideOverlayOnly(overlay)` and the existing explicit `hideOverlayAndShowMain(overlay, main)`.

- [ ] **Step 1: Write the failing lifecycle test**

```ts
import { hideOverlayOnly } from './windowLifecycle';

it('hides the overlay without showing the main window', () => {
  const overlay = fakeWindow(false);
  const main = fakeWindow(false);
  hideOverlayOnly(overlay);
  expect(overlay.hide).toHaveBeenCalledOnce();
  expect(main.show).not.toHaveBeenCalled();
  expect(main.focus).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the Electron lifecycle tests and verify failure**

Run: `pnpm --filter @interview/desktop test -- electron/windowLifecycle.test.ts electron/overlayShortcutLifecycle.test.ts`

Expected: FAIL because `hideOverlayOnly` is missing.

- [ ] **Step 3: Implement and route hide-only actions**

```ts
export function hideOverlayOnly(overlay: WindowLike | null): void {
  if (isLiveWindow(overlay)) overlay.hide();
}
```

In `main.ts`, make `hideOverlay()` call only `hideOverlayOnly(overlayWindow)`. Keep
`hideOverlayAndShowMain` exclusively in `overlay:openApp` and explicit tray/open handlers.
The global `CommandOrControl+Shift+H`, Escape shortcut lifecycle, renderer Hide button,
and renderer Escape therefore never show or focus the main window.

- [ ] **Step 4: Run lifecycle tests and Electron compilation**

Run:

```powershell
pnpm --filter @interview/desktop test -- electron/windowLifecycle.test.ts electron/overlayShortcutLifecycle.test.ts
pnpm --filter @interview/desktop build
```

Expected: PASS.

- [ ] **Step 5: Commit hide semantics**

```powershell
git add apps/desktop/electron/windowLifecycle.ts apps/desktop/electron/windowLifecycle.test.ts apps/desktop/electron/main.ts apps/desktop/electron/overlayShortcutLifecycle.test.ts
git commit -m "fix: hide only the live overlay"
```

## Plan 1 completion checkpoint

Run:

```powershell
pnpm --filter @interview/desktop test
pnpm --filter @interview/desktop typecheck
pnpm --filter @interview/desktop build
```

Expected: every command PASS. Manually start a live session, speak three different questions,
press `Ctrl+Enter` after each without waiting for old answers, and verify the final card answers
the third question. Move the cursor through empty space beside and below the visible overlay and
verify clicks reach the underlying application.
