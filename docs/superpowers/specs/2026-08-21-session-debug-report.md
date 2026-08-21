# Session Debug Report Specification

## Goal

From Interview history, a user can prepare and share one session-specific diagnostic report that lets SkillCue support identify slow or failed STT/LLM stages without reproducing the issue on the user's machine.

## Required behavior

- Every new live interview persists a bounded diagnostic timeline linked to its durable session.
- The timeline identifies the STT engine/model, selected audio sources, LLM model, retries/errors, and per-exchange STT/first-token/total timings when available.
- Older sessions remain exportable; unavailable fields are explicitly marked as not recorded by that app version.
- The report includes session metadata, transcript, generated hints, diagnostic events, timing summary, and a user-entered bug description.
- The report must never include API/license keys, Authorization headers, secret values, full user home paths, or raw operational logs unrelated to the selected session.
- The user explicitly confirms sharing because the report contains transcript text.
- On Windows with Telegram Desktop installed, the report is attached through Telegram's supported `-sendpath` flow. Otherwise SkillCue saves/reveals the report and opens the support chat.
- A failed Telegram launch never loses the report; the returned result includes its local path and a clear fallback state.

## Scope

- New sessions: full available timeline and timing diagnostics.
- Existing sessions: metadata, model stored with answers, transcript, and hints; missing live telemetry is explained.
- Audio is not attached in this iteration: the report stays small and avoids silently sharing a voice recording.
