# SkillCue 0.0.19 implementation plan

1. Add failing regression tests for application-lifetime `Ctrl+Enter` and late-final-STT ordering.
2. Move force-answer registration to Electron app lifetime and retry rejected registrations.
3. Preserve a pending forced request during screen fallback and cancel only the owned stale stream.
4. Make the overlay content stack vertically scrollable.
5. Extend persisted session assessment with interview type, score, confidence, and language-safe output.
6. Add automatic/retryable AI analysis and a separate personal-progress page with technical and HR tracks.
7. Integrate and verify the HH page redesign, passwordless email/code IPC, authenticated-state checks, and uncapped queue.
8. Run full desktop/API checks, build the packaged application, update release metadata to `0.0.19`, and publish through GitHub updater.
