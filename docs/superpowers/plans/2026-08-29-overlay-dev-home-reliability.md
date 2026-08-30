# Overlay, developer entitlement, and Home reliability plan

> Execute in the current dirty `main` worktree because it contains the already-validated realtime STT work. Preserve a file-level rollback snapshot before edits; do not reset unrelated changes.

## Goal

Make the red live-start control reliable, remove false authorization failures in the developer build, close the overlay menu on an outside click, preserve complete questions across short pauses, and fit the Home command center into one non-scrolling desktop viewport.

## Tasks

1. **Protect the current state**
   - Copy every file in this change set to a timestamped rollback folder outside the repository.
   - Record the current commit and dirty-file list.

2. **Fix developer authorization and entitlement gates with tests first**
   - Add API tests proving CORS preflight is not rejected by local-token middleware.
   - Add tests proving the dev channel bypasses local auth and reports active Max/live entitlement even after trial usage.
   - Keep stable builds token-protected and commercially quota-limited.

3. **Fix overlay menu dismissal with tests first**
   - Add a modal pointer-capture state to the overlay pointer controller.
   - While the menu is open, capture the transparent window so a click anywhere outside the menu reaches the renderer and dismisses it.
   - Restore normal click-through immediately after closing.

4. **Verify conversation and screen routing already in place**
   - Run focused regression tests for multi-fragment questions, speaker separation, repeated Ctrl+Enter, and explicit screen routing.
   - Only change the assembler/router if a regression fails; keep answers direct and gently layered rather than forcing a rigid template.

5. **Make Home a one-screen command surface**
   - Remove the secondary quick-action block and redundant explanatory content.
   - Keep the HH primary action, core counts, upcoming interview, and urgent user action.
   - Make the page itself non-scrollable and compact the two-column layout for the default 1100×740 window; degrade to a concise single-column view at the minimum window size.

6. **Verification and developer build**
   - Run focused Python and Vitest suites, then desktop typecheck/build.
   - Build and install the developer build, ensuring stale processes are stopped by the existing verified installer.
   - Verify authorized history, red live start, menu outside-click, pause-joined question submission, screen routing, and one-screen Home visually.
   - Run one representative Ozon interview acceptance case after the focused checks.

