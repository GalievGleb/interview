# SkillCue Live Force and Desktop Polish Design

**Status:** Approved by the user's explicit requested behavior on 2026-08-03.

## Goal

Make every Ctrl+Enter press produce an answer for the intended newest question, including when STT finalization arrives late, while removing the reported overlay, light-theme, persistence, navigation, home-context, and installer regressions.

## Confirmed root causes

- With mic and system audio enabled, forced finalization always targets system audio. Mic finals are labelled `me` and are excluded from the forced-answer ledger, so a spoken test question can appear in the transcript without ever satisfying Ctrl+Enter.
- `force_empty` immediately transitions the coordinator to a terminal error. A later id-less final is then ineligible.
- The overlay textarea changes height while losing focus. The ellipsis button moves between pointer down and pointer up, swallowing the first click.
- `forceDarkTheme()` is one-shot; a later cross-window `storage` event reapplies the main light theme to the overlay.
- Electron's native `titleBarOverlay` colors are fixed to dark values.
- Packaged SQLite defaults under `resources/backend/_internal/data`, which belongs to the replaceable installation directory.
- The NSIS target is configured as an assisted installer, which exposes navigation buttons.

## Live answer design

Ctrl+Enter creates a latest-wins forced-answer generation. The generation selects a source in this order:

1. the only channel currently reporting speech;
2. system audio when both channels are speaking;
3. an unconsumed system final;
4. an unconsumed microphone final;
5. system audio, then microphone, as the finalization target.

Final transcript lines from both channels enter a source-aware forced ledger. Normal automatic answers remain restricted to the configured interviewer channel; only an explicit Ctrl+Enter may consume the microphone fallback.

An empty forced finalization keeps the generation pending for a short grace period so a delayed final can still satisfy it. If no usable final arrives, the overlay captures the screen and starts screen assistance automatically. The UI never renders “no recorded phrase” for this path. A newer Ctrl+Enter cancels or supersedes every older finalization, stream, and screen fallback.

## UI design

- The overlay input has a constant compact height, no focus border/ring, and no focus growth animation.
- Removing that layout shift makes the first ellipsis click open the menu.
- The overlay renderer remains dark for its full lifetime, even when the main renderer changes theme.
- The main native title-bar colors follow the resolved main-window theme; light uses a pale surface and dark symbols.
- The home context rail receives a wider column, taller rows, and unclamped-enough supporting text so vacancy and resume status are immediately legible.
- Sidebar navigation receives vertical inset so the first active/focused preparation row is not clipped by its scroll container.

## Persistence and installation

Packaged backend data moves to `<Electron userData>/backend-data/copilot.sqlite`. Before starting the backend, the app migrates a legacy database from the bundled backend directory when the persistent destination is empty.

The NSIS installer also copies the legacy database after the old app has stopped but before uninstalling the old version. It checks both the registered install directory and the legacy Desktop `Skillcue` folder, preserving the current user's resume during this transition. Existing persistent data always wins and is never overwritten.

The installer becomes one-click per-user: manual launch shows only installation progress, automatic updates run silently, and the application launches automatically when appropriate.

## Verification

- Unit tests cover source selection, source-aware final acceptance, late-final grace, screen fallback routing, sticky overlay theme, title-bar colors, persistent database migration, installer configuration, home rail sizing, input stability, and sidebar inset.
- Full desktop, Electron, API, lint, and type checks must pass.
- The final packaged backend must boot from the installer resources and use the persistent database URL.
- Release assets must match their published SHA-256 digests before the release becomes Latest.
