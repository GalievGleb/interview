# Overlay Launch and Voice Routing Specification

## Goal

Make the installed SkillCue dev app open the interview assistant reliably from the UI, keep `Ctrl+Enter` scoped to the spoken conversation, and remove blocking AI checks from the start path.

## User-visible contract

1. Clicking **Открыть помощника** uses the same reliable native show path as `Ctrl+Shift+H`. The main window must not disappear before the non-focusable overlay is raised.
2. `Ctrl+Enter` means **answer from the conversation**. A delayed or temporarily empty STT result must never trigger a screen capture.
3. Screen capture runs only after an explicit **Экран / Что на экране?** action, or after a finalized spoken question that explicitly refers to visible screen content.
4. If a forced transcript is delayed, SkillCue keeps the request pending, shows a short waiting/no-audio notice, and accepts a late final transcript.
5. Opening/starting the assistant is immediate. Provider and STT warmups run in the background while the app is already open and retry after failure.
6. A repeatable integration check must prove that a test-design question sent through the conversation path gets a meaningful streamed answer within the existing response-time budget, without a screen request.

## Constraints

- Preserve the current dirty worktree and unrelated user changes.
- Do not remove the existing debug/session draft reporting.
- Keep explicit visual-question routing and explicit screen controls working.
- Install only the dev build requested by the user; do not publish a production release.
