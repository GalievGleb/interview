# SkillCue 0.0.19: live reliability, personal progress, and HH redesign

## Outcome

The overlay must answer the latest spoken question when `Ctrl+Enter` is pressed even while another Windows application owns focus. A late final STT segment must be allowed to replace a same-request screen fallback. Long overlay content must remain scrollable. Every completed session can receive a persisted AI assessment, while technical growth and HR/self-presentation progress remain separate from vacancy readiness.

The redesigned HH page ships in the same release with passwordless email-to-code login, a compact search/schedule/recent-applications UI, and no daily send cap or artificial pause between queued vacancies.

## Live request lifecycle

- Electron owns one application-lifetime global `Ctrl+Enter` registration. Overlay visibility and focus do not register or unregister it.
- A failed Windows registration is retried without stealing focus.
- A shortcut opens the overlay with `showInactive` and sends `overlay:force-answer` to the current live web contents.
- The force-request generation remains pending while the screen fallback starts. If a final STT segment arrives for that generation, it cancels the owned screen request and becomes the answer source.
- A later shortcut increments the generation, so stale transcription, screenshot, and LLM streams cannot overwrite the newest answer.

## Session assessment and progress

- Session analysis classifies the interview as `technical`, `hr`, `mixed`, or `unknown` and stores score and confidence.
- Ending a persisted session opens the analysis view and starts the assessment automatically; the user can retry from recap or History.
- Technical knowledge aggregation ignores HR-only and unknown sessions.
- `/sessions/development-profile` aggregates technical and HR evidence independently and returns recent assessed sessions.
- `/progress` presents personal development separately from the vacancy readiness map.
- Summary and analysis requests receive an explicit Russian or English answer language.

## HH applications

- The renderer calls passwordless request-code and confirm-code APIs exposed through preload and IPC.
- Request-code succeeds only after the one-time-code field is visible.
- Confirm-code succeeds only after HH's authenticated applicant menu is visible.
- A fresh unchecked session is not labelled connected.
- Queue processing has no `dailyLimit` gate and no inter-vacancy `setTimeout`; short waits needed to observe HH page transitions remain internal to a single application flow.

## Verification

- Unit and source-contract tests cover shortcut lifetime, retry, late transcript ordering, stale request protection, scrolling, AI analysis, personal progress, HH IPC/login state, and uncapped queue execution.
- Run all desktop tests, renderer and Electron typechecks, ESLint, all Python tests, Ruff, production build, packaged backend smoke test, and installer build.
- Publish `v0.0.19` with updater metadata and installer assets through the existing GitHub release workflow.
