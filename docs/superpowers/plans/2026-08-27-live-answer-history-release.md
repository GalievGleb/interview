# Live Answer and History Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a completed live conversation appear immediately in History and prevent provider stream failures from surfacing as the misleading “Пустой ответ от модели”, while recovering through an automatic backup model when possible.

**Architecture:** Reuse the existing cross-window `skillcue:live-stop` event as the history invalidation signal and add a small event-subscription helper with a real `EventTarget` unit test. At the LLM boundary, select the first non-empty stream from the primary/hedged models and one reliability backup, preserve the backend `stream_failed` terminal event with a safe message, and teach the renderer parser to terminate the request as an error instead of ignoring it. Release the bundled Python backend and Electron renderer together as `0.1.8`.

**Tech Stack:** React 19, TypeScript, Electron IPC, Vitest, FastAPI, pytest, async Python generators, electron-builder, GitHub Releases.

**Spec:** User report and screenshot in the 2026-08-27 Codex task.

## Global Constraints

- Keep live response latency bounded; backup work starts only when the primary path fails or misses its first-token budget.
- Never expose raw upstream/provider errors, credentials, prompts, or license keys to the renderer.
- Never persist a partial provider response as a successful answer.
- History must refresh without restarting the app or manually reloading the page.
- Ship Windows, macOS arm64, and macOS x64 artifacts under one release version.

---

### Task 1: Immediate history invalidation

**Files:**
- Create: `apps/desktop/src/lib/sessionHistoryRefresh.ts`
- Create: `apps/desktop/src/lib/sessionHistoryRefresh.test.ts`
- Modify: `apps/desktop/src/pages/HistoryPage.tsx`

**Interfaces:**
- Consumes: existing main-window events `skillcue:live-stop` and browser `focus`.
- Produces: `subscribeToSessionHistoryRefresh(target, refresh): () => void`.

- [x] **Step 1: Write the failing test**

```ts
it('refreshes on live-stop and focus and detaches cleanly', () => {
  const target = new EventTarget();
  let refreshes = 0;
  const unsubscribe = subscribeToSessionHistoryRefresh(target, () => { refreshes += 1; });
  target.dispatchEvent(new Event('skillcue:live-stop'));
  target.dispatchEvent(new Event('focus'));
  expect(refreshes).toBe(2);
  unsubscribe();
  target.dispatchEvent(new Event('skillcue:live-stop'));
  expect(refreshes).toBe(2);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @interview/desktop test -- src/lib/sessionHistoryRefresh.test.ts`

Expected: FAIL because `subscribeToSessionHistoryRefresh` does not exist.

- [x] **Step 3: Write minimal implementation**

```ts
export function subscribeToSessionHistoryRefresh(
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  refresh: () => void,
): () => void {
  const handler = () => refresh();
  target.addEventListener('skillcue:live-stop', handler);
  target.addEventListener('focus', handler);
  return () => {
    target.removeEventListener('skillcue:live-stop', handler);
    target.removeEventListener('focus', handler);
  };
}
```

Subscribe `HistoryPage` with `window` and its existing `load` callback.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @interview/desktop test -- src/lib/sessionHistoryRefresh.test.ts src/pages/HistoryPage.behavior.test.ts`

Expected: PASS.

### Task 2: Reliable live-answer terminal semantics and backup

**Files:**
- Modify: `apps/api-py/app/services/hedged_stream.py`
- Modify: `apps/api-py/tests/test_hedged_stream.py`
- Modify: `apps/api-py/app/routers/chat.py`
- Modify: `apps/api-py/tests/test_chat_review.py`
- Modify: `apps/desktop/src/lib/streamInterviewEvent.ts`
- Modify: `apps/desktop/src/lib/streamInterviewEvent.test.ts`
- Modify: `apps/desktop/src/lib/api.ts`

**Interfaces:**
- Consumes: `provider_adapter.stream_chat(...)` and current SSE `chunk`, `done`, `stream_failed` events.
- Produces: a first-non-empty stream selection with an optional reliability rescue model; renderer event `{ type: 'error', message }` for terminal failures.

- [x] **Step 1: Write failing backend and renderer tests**

Add backend tests proving an empty/failed primary stream is rescued by `openai/gpt-4o-mini`, the rescue model is not started on a healthy primary, and failure of every model emits one `stream_failed` event with a generic safe message and no `done`. Add a renderer parser test proving `stream_failed` becomes an error event rather than `null`.

- [x] **Step 2: Run tests to verify they fail**

Run:

```powershell
pnpm --filter @interview/desktop test -- src/lib/streamInterviewEvent.test.ts
Set-Location apps/api-py
.venv/Scripts/python.exe -m pytest tests/test_hedged_stream.py tests/test_chat_review.py -q
```

Expected: FAIL because rescue selection and `stream_failed` parsing are absent.

- [x] **Step 3: Implement minimal backend rescue and client error handling**

Expose a single-model first-non-empty selector from `hedged_stream.py`; in the auto fast route, use `openai/gpt-4o-mini` only after the existing primary/hedged path fails before a valid completion. Emit only a stable user-safe message for the terminal event. Parse `stream_failed` in TypeScript and settle the active request through `onError` immediately, without falling through to the empty-stream branch.

- [x] **Step 4: Run focused tests to verify they pass**

Run the same focused Vitest and pytest commands. Expected: PASS.

### Task 3: Full verification and release

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `RELEASE_NOTES.md`
- Verify: all version metadata remains exactly `0.1.8`.

**Interfaces:**
- Consumes: green desktop/backend tree and repository release tooling.
- Produces: commit, pushed `main`, tag `v0.1.8`, GitHub release assets for Windows/macOS, and verified updater/download metadata.

- [x] **Step 1: Run full local gates**

```powershell
pnpm --filter @interview/desktop test
pnpm --filter @interview/desktop typecheck
pnpm --filter @interview/desktop lint
Set-Location apps/api-py
.venv/Scripts/python.exe -m pytest -q
.venv/Scripts/python.exe -m ruff check app tests
.venv/Scripts/python.exe -m ruff format --check app tests
```

Expected: all commands exit 0.

- [x] **Step 2: Build and smoke-test the Windows artifact locally**

Run the repository stable build and backend health/version smoke checks. Expected: installer exists and bundled backend reports `ok`, version `0.1.8`.

- [ ] **Step 3: Commit, push, tag, and publish**

Commit only the scoped files, push `main`, create/push `v0.1.8`, and monitor the release workflow until all three platform jobs finish successfully.

- [ ] **Step 4: Verify public artifacts**

Confirm `latest.yml` says `0.1.8`, all required Windows/macOS assets exist, and the site’s download links return HTTP 200.
