# Fast Text Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make typed overlay questions use a low-latency text route and make `Ctrl+Enter` immediately show a loading answer card and answer the latest recognized question.

**Architecture:** Extract request routing and forced-answer selection into pure TypeScript functions covered by unit tests. The React hook owns explicit forced-finalization state, while the overlay renders that state through the existing response card. The Python `/chat` endpoint treats `mode=fast` as a no-RAG, throughput-prioritized streaming request.

**Tech Stack:** React 19, TypeScript, Vitest, Electron, FastAPI, pytest, OpenRouter-compatible SSE, electron-builder.

## Global Constraints

- Any non-empty typed text must never trigger automatic screen capture.
- Explicit `Screen` and empty `Assist` fallback keep the current vision route.
- `Ctrl+Enter` must show the answer card by the next render frame.
- The string `Реплика отправлена — готовлю ответ` must not be displayed.
- Normal-network target for first visible text is 1–2 seconds.
- Delivery must use the built-in updater; no manual server download.

---

### Task 1: Deterministic overlay request routing

**Files:**
- Create: `apps/desktop/src/lib/overlayRequestRoute.ts`
- Test: `apps/desktop/src/lib/overlayRequestRoute.test.ts`
- Modify: `apps/desktop/src/pages/OverlayPage.tsx`

**Interfaces:**
- Produces: `resolveOverlayRequestRoute(input): OverlayRequestRoute`.
- Consumes: action id, trimmed custom text, transcript presence, screen availability, screen preference, Smart state.

- [ ] **Step 1: Write the failing route tests**

```ts
expect(resolveOverlayRequestRoute({
  action: 'assist', customText: 'Что такое тестирование?', hasTranscript: false,
  canCaptureScreen: true, useScreenFallback: true, smart: false,
})).toEqual({ kind: 'chat', mode: 'fast' });

expect(resolveOverlayRequestRoute({
  action: 'assist', customText: '', hasTranscript: false,
  canCaptureScreen: true, useScreenFallback: true, smart: false,
})).toEqual({ kind: 'screen', mode: 'general' });
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run src/lib/overlayRequestRoute.test.ts`

Expected: FAIL because `overlayRequestRoute.ts` does not exist.

- [ ] **Step 3: Implement the pure router**

```ts
export type OverlayActionId = 'assist' | 'say' | 'followup' | 'recap' | 'screen';
export type OverlayRequestRoute =
  | { kind: 'chat'; mode: 'fast' | 'general' | 'deep' }
  | { kind: 'screen'; mode: 'general' | 'deep' }
  | { kind: 'notice' };

export function resolveOverlayRequestRoute(input: OverlayRequestRouteInput): OverlayRequestRoute {
  if (input.action === 'screen') return { kind: 'screen', mode: input.smart ? 'deep' : 'general' };
  if (input.customText.trim()) return { kind: 'chat', mode: input.smart ? 'deep' : 'fast' };
  if (input.action === 'assist' && !input.hasTranscript && input.canCaptureScreen && input.useScreenFallback) {
    return { kind: 'screen', mode: input.smart ? 'deep' : 'general' };
  }
  if (!input.hasTranscript) return { kind: 'notice' };
  return { kind: 'chat', mode: input.smart ? 'deep' : 'general' };
}
```

- [ ] **Step 4: Use the route from `OverlayPage.runAction`**

Pass the selected mode into `streamChat`/`streamScreenAssist`; remove the inline condition that sends typed text to `runScreenAssist`.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm exec vitest run src/lib/overlayRequestRoute.test.ts`

Expected: all route cases PASS.

### Task 2: Fast no-RAG backend stream

**Files:**
- Modify: `apps/api-py/app/routers/chat.py:405-448`
- Modify: `apps/api-py/tests/test_chat_review.py`

**Interfaces:**
- Consumes: existing `ChatPayload.mode == "fast"`.
- Produces: `/chat` SSE call with `max_tokens=450`, `temperature=0.3`, `route_fast=True`, and no call to `rag_service.search`.

- [ ] **Step 1: Add a failing backend test**

```py
def test_fast_chat_skips_rag_and_prioritizes_fast_stream(client, monkeypatch):
    from app.routers import chat as chat_router

    async def forbidden_search(*args, **kwargs):
        raise AssertionError("fast chat must not call RAG")
    captured = {}
    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured.update(kwargs)
        captured["messages"] = messages
        yield "быстро"
    monkeypatch.setattr(chat_router.rag_service, "search", forbidden_search)
    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    response = client.post("/chat", json={"message": "Что такое тестирование?", "mode": "fast", "context": "явный контекст"})
    assert response.status_code == 200
    assert captured["route_fast"] is True
    assert captured["max_tokens"] == 450
    assert "явный контекст" in captured["messages"][1]["content"]
```

- [ ] **Step 2: Verify RED**

Run: `python -m pytest tests/test_chat_review.py::test_fast_chat_skips_rag_and_prioritizes_fast_stream -q`

Expected: FAIL because current `/chat` always calls `rag_service.search`.

- [ ] **Step 3: Implement the fast branch**

```py
is_fast = payload.mode == "fast"
context_chunks = [] if is_fast else await rag_service.search(db, payload.message, top_k=5)
context = payload.context or "\n\n".join(chunk["text"] for chunk in context_chunks)
stream_options = {
    "max_tokens": 450 if is_fast else 800,
    "temperature": 0.3 if is_fast else 0.4,
    "route_fast": is_fast,
}
```

Pass `stream_options` to `provider_adapter.stream_chat`.

- [ ] **Step 4: Verify GREEN and the surrounding chat tests**

Run: `python -m pytest tests/test_chat_review.py -q`

Expected: all tests PASS.

### Task 3: Immediate forced-answer decision

**Files:**
- Modify: `apps/desktop/src/lib/forceLiveAnswer.ts`
- Modify: `apps/desktop/src/lib/forceLiveAnswer.test.ts`
- Modify: `apps/desktop/src/hooks/useLiveCopilot.ts`

**Interfaces:**
- Produces: `decideForcedAnswer(input): { action: 'submit'; question: string } | { action: 'flush'; source: 'mic' | 'system' } | { action: 'unavailable' }`.
- Produces from hook: `forcePending: boolean` and `forceAnswer(): 'started' | 'finalizing' | 'unavailable'`.

- [ ] **Step 1: Write failing decision tests**

```ts
expect(decideForcedAnswer({
  pendingParts: [], lines: [{ text: 'Что такое тестирование?', isFinal: true, speaker: 'me' }],
  triggerSpeaker: 'me', lastCompletedQuestion: '', lastCompletedRawQuestion: '',
  sources: { mic: true, system: false }, speechInProgress: { mic: false, system: false },
})).toEqual({ action: 'submit', question: 'Что такое тестирование?' });

expect(decideForcedAnswer({
  pendingParts: [], lines: [], triggerSpeaker: 'me', lastCompletedQuestion: '',
  lastCompletedRawQuestion: '', sources: { mic: true, system: false },
  speechInProgress: { mic: true, system: false },
})).toEqual({ action: 'flush', source: 'mic' });
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run src/lib/forceLiveAnswer.test.ts`

Expected: FAIL because `decideForcedAnswer` does not exist.

- [ ] **Step 3: Implement and integrate the decision**

Choose an already-final question before attempting STT flush. Flush only when the target source reports speech in progress. Mirror `forcePendingRef` into React state and clear both together on transcript, empty-final, error, stop, and timeout.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm exec vitest run src/lib/forceLiveAnswer.test.ts`

Expected: all forced-answer cases PASS.

### Task 4: Immediate answer card and visible phases

**Files:**
- Modify: `apps/desktop/src/lib/liveOverlaySync.ts`
- Modify: `apps/desktop/src/lib/liveOverlaySync.test.ts`
- Modify: `apps/desktop/src/pages/OverlayPage.tsx`
- Modify: `apps/desktop/src/lib/i18n/ru.ts`
- Modify: `apps/desktop/src/lib/i18n/en.ts`

**Interfaces:**
- `deriveLiveExchange(streamText, streaming, lastSpoken, forcePending)` treats forced finalization as visible loading.
- `forceAnswer()` status selects loading-card or error-card rendering.

- [ ] **Step 1: Write the failing loading-card test**

```ts
expect(deriveLiveExchange('', false, undefined, true)).toEqual({ show: true, text: '' });
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run src/lib/liveOverlaySync.test.ts`

Expected: FAIL because forced finalization is not part of the view state.

- [ ] **Step 3: Implement the UI state**

Use `streaming || forcePending` as the card's pending flag. On `Ctrl+Enter`, cancel any manual exchange, clear the yellow notice, and show the live card with the known question or `Ctrl+Enter · Подсказка`. Display unavailable/timeout errors in the card. Remove usage of `overlay.forceSent`.

- [ ] **Step 4: Verify GREEN and UI regressions**

Run: `pnpm exec vitest run src/lib/liveOverlaySync.test.ts src/lib/forceLiveAnswer.test.ts src/lib/overlayRequestRoute.test.ts`

Expected: all tests PASS.

### Task 5: Release and updater delivery

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src/lib/releaseNotes.ts`
- Modify: `apps/desktop/electron/productSurface.test.ts`

**Interfaces:**
- Produces: desktop release `0.0.13` and GitHub updater assets.

- [ ] **Step 1: Bump and test release metadata**

Set package and product-surface expectation to `0.0.13`; add release notes for fast typed questions and immediate `Ctrl+Enter` feedback.

- [ ] **Step 2: Run all verification**

```powershell
pnpm test
pnpm lint
pnpm typecheck
pnpm build
python -m pytest tests/test_chat_review.py -q
```

Expected: all tests, lint, typechecks, and builds PASS.

- [ ] **Step 3: Build backend and installer**

```powershell
pnpm build:backend
pnpm exec electron-builder --win nsis --config.win.signAndEditExecutable=false
```

Expected: `release/latest.yml` reports `0.0.13` and installer/blockmap exist.

- [ ] **Step 4: Publish and verify updater assets**

Create GitHub release `v0.0.13` with `latest.yml`, installer, and blockmap. Verify public `releases/latest/download/latest.yml` returns `version: 0.0.13` and the published SHA-256 equals the local installer hash.
