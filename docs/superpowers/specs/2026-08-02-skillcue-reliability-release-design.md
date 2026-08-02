# SkillCue Reliability Release Design

Date: 2026-08-02
Status: product design approved; written specification awaiting final review

## Goal

Make the desktop application dependable during a real interview: every `Ctrl+Enter`
must target the newest spoken question, the overlay must never block unrelated desktop
content, session results must be useful and Russian-language, and updates must install
without a manual download or installer workflow.

This release also records structured post-session assessments so SkillCue can reuse
the candidate's weak topics in later hints and build a fuller knowledge map in a future
UI iteration.

## Product decisions

- `Ctrl+Enter` uses **latest request wins** semantics. A newer press supersedes any
  pending transcription finalization or answer generation. Old work may finish in the
  background, but it cannot replace the newest answer card.
- Every final transcript event is retained in session history, including events that
  arrive while a forced finalization is pending. Request IDs decide which request may
  update the answer, not whether the transcript is stored.
- The native overlay window remains a stable rectangle, but transparent pixels are
  always click-through. Only currently visible SkillCue surfaces are interactive.
- Updates download once, install silently, and relaunch SkillCue automatically. An
  active live interview postpones installation until the session stops.
- Session summaries and assessments follow the configured answer language. With
  Russian selected, prose and headings are Russian; technical identifiers may remain
  in their conventional form.
- Post-session assessment is structured and persisted in the local backend database.
  A synchronous cache of aggregated weak topics remains available to live prompts.
- Interview-question speech uses managed OpenAI TTS with a deterministic natural
  voice and falls back to a ranked installed system voice if the network path fails.
  Model and voice routing remain automatic; this release adds no model picker.

## Workstream 1: repeated `Ctrl+Enter` and correct question routing

### Existing failure

`useLiveCopilot` rejects every press while `forcePendingRef` is set. During that window,
ordinary final STT events are displayed in the transcript but excluded from the answer
buffer. The visible transcript can therefore contain a newer question such as
"Какие бывают техники тест-дизайна?" while the answer card still contains the older
automation answer. React state captured by the hotkey callback can also lag behind the
latest transcript event.

### New request model

Introduce a small, independently tested forced-answer coordinator with these values:

- a monotonically increasing transcript sequence for final trigger-speaker lines;
- the sequence consumed by the last accepted forced request;
- a monotonically increasing force generation for each `Ctrl+Enter` press;
- the current forced STT request ID, if finalization is required;
- the current LLM generation and abort handle.

On every press:

1. Increment the force generation and immediately create a pending answer card.
2. Read the transcript ledger from a ref, not captured React state.
3. If a finalized trigger-speaker line exists after the consumed cursor, submit the
   newest complete line immediately and advance the cursor.
4. Otherwise send a uniquely tagged STT `finalize` command for the current audio.
5. Cancel the previous LLM stream. A stale STT or LLM completion may be logged and
   persisted, but it is ignored by the current answer UI.

When the latest tagged STT job completes, its text is submitted only if its generation
is still current. An ID-less automatic final is always stored and may satisfy the latest
request when it is newer than the consumed cursor. A stale tagged final never consumes
the current cursor.

"Нет новой реплики" is shown only when the latest finalization explicitly returns
empty and the ledger still has no unconsumed final line. It appears inside the pending
answer card, not as a detached status line. The card has explicit phases:
`finalizing-transcript`, `waiting-first-token`, `streaming`, `done`, and `error`.

The forced text path never captures the screen when it already has a spoken or typed
question. The target remains a visible pending card in the next render frame and the
first answer text as soon as the fast model streams it.

## Workstream 2: overlay hit area, menus, tooltips, and shortcuts

### Pointer containment

The transparent `BrowserWindow` currently receives mouse input across its full native
bounds. Replace the mode-specific hit test with one always-on policy:

- the native window starts in click-through mode with `forward: true`;
- pointer movement checks for a nearest explicit interactive region marked with
  `data-overlay-hit`;
- the pill, visible cards, input panel, transcript panel, recap, and open menus are hit
  regions;
- empty transparent space is never a hit region;
- opening or closing a surface recomputes the current hit state immediately.

The "Работать под панелью" preference continues to control focusability. It no longer
controls whether invisible pixels intercept clicks, because invisible pixels are always
click-through.

### Bounded floating UI

- The ellipsis menu is rendered in a fixed overlay layer and clamped inside the native
  window. It opens over response text when necessary and uses a maximum height derived
  from the available viewport, so its top is never cut off.
- Tooltips use viewport-aware horizontal alignment. The first and last actions clamp to
  the corresponding edge instead of centering outside the window.
- Response and recap scrolling stay inside their cards; floating controls do not change
  document layout.

### Hide semantics

Split native window actions into `hideOverlayOnly` and `hideOverlayAndOpenMain`.
`Ctrl+Shift+H`, the Hide button, and Escape call `hideOverlayOnly`. Only the SkillCue
logo, tray command, or an explicit "Открыть SkillCue" action shows the main window.

## Workstream 3: Russian recap and persistent session assessment

### Summary language

The desktop sends `answer_language` to both summary and review endpoints. Backend prompt
builders select localized headings and add an explicit output-language contract. The
Russian summary uses sections such as `Кратко`, `Что решили`, `Что сделать`, and
`Открытые вопросы`; it does not inherit English headings from the system prompt.

### User flow

After stopping a session, recap keeps its existing summary, transcript, and usage views
and adds a fourth `Разбор` view. Before analysis it contains a primary
`Разобрать сессию` button. Pressing it shows a local progress state and requests one
structured interview assessment. It never starts analysis automatically, so users do
not spend quota on sessions they do not want reviewed.

The assessment contains:

- overall level and a short evidence-based conclusion;
- strong topics with transcript evidence;
- weak topics with transcript evidence and a concrete learning action;
- per-topic score from 0 to 100 and confidence from 0 to 1;
- concise Russian Markdown for display.

The backend validates the model output against a Pydantic schema and performs at most
one repair attempt for invalid JSON. It must not invent an answer that is absent from
the transcript. If roles are ambiguous, the result says so and lowers confidence.

### Persistence and future knowledge map

Add a `session_assessments` table keyed by session ID. It stores the structured JSON,
display Markdown, language, and timestamps. `POST /sessions/{id}/analysis` generates and
persists an assessment; `GET /sessions/{id}/analysis` returns it without regenerating.

After a successful analysis, the desktop refreshes a cached aggregate of topic scores.
The live answer pipeline merges its weakest topic titles with existing vacancy/mock weak
topics. This release does not add a separate full-page knowledge-map editor; it creates
the durable evidence and aggregation contract that page will consume later.

## Workstream 4: single-flight silent updates

The Electron main process owns one update-check promise and one updater status store.
Startup checks and manual checks reuse the same in-flight promise, preventing duplicate
download attempts.

Only one progress representation is visible per screen:

- Settings shows version plus one progress bar/status;
- the action button is hidden while downloading instead of repeating the same percentage;
- the global toast is suppressed on Settings and is used only when the user is elsewhere.

On `update-downloaded`:

- if no live session is active, publish a brief installing state and call
  `quitAndInstall(true, true)` for silent installation and forced relaunch;
- if a live session is active, publish `waiting-for-session-end` and install as soon as
  `overlay:liveState(false)` arrives;
- an updater error leaves the current application running and exposes a retry action.

There is no "Установить" or additional restart button in the normal update path.

## Workstream 5: natural interview-question voice

Replace arbitrary default `window.speechSynthesis` output with a managed speech service:

- local backend endpoint accepts bounded text and language;
- managed gateway endpoint authenticates the SkillCue license, enforces request size and
  rate limits, and proxies OpenAI `gpt-4o-mini-tts`;
- use the `marin` voice with instructions for calm, natural interview speech;
- request WAV for low decoding overhead;
- cache audio by normalized text, language, voice, and model;
- prefetch the next known mock question after the current question is displayed;
- expose play, stop, loading, and retry states through one reusable hook.

If managed TTS fails, select the best installed voice by language and a stable quality
ranking instead of accepting the browser's first voice. The UI labels this as AI-generated
speech as required by the provider policy.

## Workstream 6: desktop polish

- Replace green input focus borders with a subtle indigo/neutral accessible focus ring.
  Selection and success states may remain green; ordinary typing focus may not.
- Match the native Windows title-bar overlay height to the 44 px CSS title bar so window
  button hover backgrounds end at the divider instead of crossing it.
- Remove the bottom-left `SkillCue готов` text and its status dot. Keep the footer actions.
- During resume text or file upload, disable both submission controls and show a visible
  spinner plus `Добавляю резюме…`; restore controls on success or failure.
- Preserve existing error text and keyboard accessibility while simplifying the visual
  hierarchy.

## Error handling

- A stale generation can never mutate the current answer card.
- STT finals are persisted even if they are stale for answer generation.
- A failed session analysis remains retryable and does not overwrite a saved assessment.
- A TTS network failure falls back locally and does not block the mock interview.
- An update failure never closes the app. Silent install is attempted only after a fully
  downloaded update and outside an active live session.
- Overlay hit testing returns to click-through on unmount or renderer failure.

## Verification

### Unit and component tests

- two and three rapid `Ctrl+Enter` presses select the newest unconsumed question;
- stale forced STT and stale LLM completions cannot overwrite the newest card;
- an ID-less final arriving during forced finalization remains in the transcript and can
  satisfy the newest generation;
- genuine empty audio produces the empty-replica message only for the current generation;
- hide-only shortcut never shows or focuses the main window;
- transparent points are click-through and visible hit regions remain interactive;
- menu and tooltip position helpers clamp all edges;
- updater checks are single-flight and install waits for live-state false;
- Russian summary/review requests carry Russian language and prompts use Russian headings;
- structured assessment validates, persists, reloads, and refreshes weak-topic cache;
- TTS uses managed audio, caches it, and falls back to a ranked Russian system voice;
- resume upload exposes a busy spinner and prevents duplicate submissions;
- title-bar native and CSS heights stay equal.

### Integration and release checks

- run desktop unit tests, Electron tests, TypeScript typecheck, backend tests, gateway tests,
  lint, and production builds;
- run a packaged Windows smoke session with three successive spoken questions and rapid
  `Ctrl+Enter` presses;
- verify clicks beside and below every visible overlay surface reach the underlying app;
- verify a Russian recap and persisted analysis from a real captured transcript;
- verify background update download, silent install, and automatic relaunch;
- publish the next desktop release through the existing updater channel so no manual
  application download is required.

## Out of scope

- A standalone full knowledge-map management page.
- User-selectable AI, transcription, or TTS model pickers.
- Parallel answer cards or a FIFO queue of stale interview questions.
- Visual redesigns unrelated to the reported overlay, update, title-bar, focus, and upload
  problems.

## Acceptance criteria

All fifteen reported issues and the duplicate update-progress issue are covered when:

1. Rapid repeated `Ctrl+Enter` always ends on an answer to the newest spoken question.
2. Spoken final lines never disappear from the answer-selection ledger.
3. Session summary and assessment are Russian when Russian is selected.
4. Transparent overlay space does not prevent clicking the desktop below it.
5. Session analysis is explicit, structured, saved, and reflected in later weak-topic
   context.
6. Tooltips and menus remain fully visible inside the overlay window.
7. Updates show one progress indicator, install silently, and relaunch automatically.
8. `Ctrl+Shift+H` only hides the overlay.
9. Input focus, title-bar buttons, sidebar footer, and resume-loading states match the
   approved polish decisions.
10. Mock-interview speech uses natural managed TTS with a reliable local fallback.
