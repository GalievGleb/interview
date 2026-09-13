# Screenshot answer persistence verification

Report: session 7868a2e4-7dc8-427d-b6a1-201d51020054, Alpha g3cead04b.
Both real requests returned SQL in ~15.7 seconds. On screen completion, forcePhase
changes to done, manualBusy becomes false and the live synchronization effect
replaces the screen exchange with the retained previous voice answer.

- [x] Reproduce stale voice replacement and hidden error in failing tests.
- [x] Track the screen exchange's force generation and voice-history identity.
- [x] Keep screen result/error until a new voice request or explicit dismissal.
- [x] Verify the next Ctrl+Enter can still display its response.
- [x] Run complete desktop tests and renderer/Electron type checks.
- [ ] Build and install Alpha, leaving stable and Dev unchanged.
- [ ] Real Ctrl+Shift+Enter with visible SQL fixture: capture, model, UI answer.
- [ ] Repeat screen request and verify result remains after completion.
- [ ] Execute returned SELECT against in-memory SQLite; expected Austria.
- [ ] Inspect readable SQL and screenshot preview, then clean up test windows.

QA extras: check a new typed request after screenshot; no stale voice answer
on screenshot done/error (regression tests); no duplicate request on one shortcut.
