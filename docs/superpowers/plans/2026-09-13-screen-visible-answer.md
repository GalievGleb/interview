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
- [x] Build and install Alpha, leaving stable and Dev unchanged.
- [x] Real Ctrl+Shift+Enter with visible SQL fixture: capture, model, UI answer.
- [x] Repeat screen request and verify result remains after completion.
- [x] Execute returned SELECT against in-memory SQLite; expected Austria.
- [x] Inspect readable SQL and screenshot preview, then clean up test windows.

QA extras: check a new typed request after screenshot; no stale voice answer
on screenshot done/error (regression tests); no duplicate request on one shortcut.

Verified installed version: 0.1.14-alpha.gcdf1f920. Three real screenshot requests
returned SQL and remained visible. The second followed system-audio playback of
03_api_testing.wav, confirmed transcript, and a successful Ctrl+Enter voice answer.
Its first rendered SQL arrived at 18195 ms; it did not revert to that voice answer.
Rapid double Ctrl+Shift+Enter on the third run emitted one /chat/screen/stream
request. Every returned SQL executed against two-country SQLite fixture data and
returned country_name=Austria. Ctrl+Shift+ArrowDown advanced the answer scroll.
Evidence: output/playwright/alpha-screen-after-voice.png. Tests: 171 files,
1580 passed; renderer/Electron typechecks passed. No latency improvement claimed.
Test recording ended; diagnostic process closed and Alpha restarted normally.
