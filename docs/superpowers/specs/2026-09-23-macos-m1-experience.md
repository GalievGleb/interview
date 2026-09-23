# SkillCue macOS M1 Experience Spec

## User-visible problems

1. In the main window, the SkillCue sidebar brand overlaps the three native macOS traffic-light controls.
2. A floating overlay pill appears during application startup even though the user did not open the live assistant.
3. The native Apple-silicon build feels blocked for several seconds at startup and shows additional route loading after clicks.
4. Microphone and system-audio permission recovery is not discoverable from the live overlay.
5. The user needs a clear distinction between moving SkillCue data, Codex tasks, and ChatGPT cloud conversations to a Mac.

## Required behavior

- The macOS traffic-light area must remain visually empty and clickable in expanded and collapsed sidebar modes.
- Startup must create and reveal only the main window. The overlay window may be created only on demand and must not be shown before its renderer is ready.
- The application shell must render without waiting for the Python backend, provider readiness, STT diagnostics, or license refresh.
- Independent startup probes must run concurrently and must not start twice because two renderer windows were eagerly created.
- A denied microphone permission or silent/denied system-audio capture must present a direct action that opens the relevant macOS Privacy & Security settings.
- Windows behavior and existing overlay shortcuts must remain unchanged.
- The release must remain native for both `arm64` and `x64` and pass the packaged backend smoke test.

## Verification boundaries

- Unit/component tests cover shell rendering, platform-safe layout classes, lazy overlay creation, and permission actions.
- Typecheck and the complete desktop test suite must pass on Windows.
- A GitHub Actions macOS run must build and smoke-test both architectures.
- Actual TCC permission prompts and real microphone/system-audio capture require a final test on a physical Mac.
