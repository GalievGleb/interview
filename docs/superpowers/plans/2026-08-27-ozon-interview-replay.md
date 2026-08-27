# Ozon Interview Replay Verification Plan

**Goal:** Validate SkillCue against the supplied real Ozon technical interview before publishing v0.1.9, using the same installed desktop capture, managed STT, question resolution, live-answer, and screen-assist paths used by a student.

**Source:** local `Ozon.mp4` recording (ignored; never committed or uploaded outside the normal SkillCue inference path).

## Non-negotiable constraints

- Do not use Whisper or a substitute transcription engine.
- Do not modify the source video.
- Do not commit raw video, audio, frames, names, faces, Telegram handles, or other personal data.
- Use the installed SkillCue Dev application and its existing gateway identity.
- Treat system audio as the interviewer channel and keep microphone capture disabled during deterministic replay.
- A successful live case requires a non-empty terminal answer, not a partial stream.
- Measure from the user's `Ctrl+Enter` action: first answer target about 4 seconds; hard failure at 5 seconds.

## Phase 1: Validate and inventory the recording

- Wait until the MP4 is unlocked and `ffprobe` can read its `moov` index.
- Record duration, resolution, frame rate, audio-track count, channel layout, and sample rate.
- Keep all derived clips and reports under a local ignored output directory.

## Phase 2: Full discovery pass through the real application

- Install the current repository state as SkillCue Dev.
- Open the helper with system audio enabled and microphone disabled.
- Play the recording at 1x through Windows audio.
- Let SkillCue persist its own transcript and source diagnostics without automatically asking the LLM.
- End the session and verify it appears immediately in History.
- Export the local session report and identify interviewer questions, pauses, back-to-back turns, technical terms, and visible tasks.

## Phase 3: Build a privacy-safe replay matrix

- Select representative voice cases covering short questions, long lead-ins, mid-sentence pauses, filler words, terminology, and consecutive questions.
- Select every clearly visible desktop/code/testing task.
- For each case record only local timestamps, semantic expectations, and latency budgets.
- Derive synthetic text/audio fixtures for any regression that needs to be committed; never commit source excerpts containing personal data.

## Phase 4: Deterministic installed-app replay

- Replay each selected voice clip as system audio into the installed overlay.
- Send `Ctrl+Enter` only after the interviewer finishes.
- Assert that the accepted question comes from the interviewer/system channel, contains the complete multi-fragment question, and produces a non-empty answer.
- Score answer semantics against per-case concepts and record STT, first-token, and total latency.
- Repeat pause-sensitive and back-to-back cases at least three times.
- Pause the video on visible tasks, invoke `Экран`, and validate that SkillCue describes or solves what is actually visible.

## Phase 5: Fix and prove regressions

- For every failure, first add the smallest deterministic failing test around the responsible boundary.
- Implement the minimal fix, rerun the focused test, then rerun the affected real-video case.
- Run the complete desktop/backend gates and packaged-backend smoke test.

## Phase 6: Release without GitHub Actions billing

- Build and verify the Windows backend and installer locally on the existing Windows machine.
- Publish `SkillCue-Setup.exe`, its blockmap, and `latest.yml` directly to the public `GalievGleb/SkillCue` release with the authenticated `gh` CLI; do not dispatch a hosted Actions runner.
- Verify updater metadata, checksums, and public HTTP downloads after upload.
- Build macOS arm64/x64 only on a real macOS machine or an explicitly approved runner; do not pretend a Windows cross-build is a usable Mac release.
