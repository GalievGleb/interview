# Realtime STT Latency Experiment

## Goal

Reduce `Ctrl+Enter` to first-answer latency for the live interview overlay while preserving the current transcript quality, speaker routing, quota enforcement, and HTTP/WAV transcription path.

## Baseline

The privacy-safe Ozon replay run on 2026-08-28 produced three semantically correct answers but failed the four-second latency gate:

- trigger-to-first-answer: 4,500 / 5,203 / 4,359 ms;
- post-trigger STT: 2,500 / 2,234 / 2,859 ms;
- answer first chunk: 2,000 / 2,969 / 1,500 ms.

The preserved report is `output/interview-replay/baseline-before-realtime-20260828.json`.

## Required behavior

- Keep `run_openai_mini_stream` and `/gateway/stt/transcribe` unchanged as the fallback path.
- Use Realtime STT by default after acceptance; `SKILLCUE_REALTIME_STT=0` explicitly restores the legacy path.
- Authenticate the gateway WebSocket with the existing signed SkillCue license; never expose the OpenAI API key to the desktop or local backend.
- Stream PCM while speech is happening, use explicit commits at local turn boundaries, and reconcile final transcripts by `item_id`/client turn id.
- Preserve manual `Ctrl+Enter` semantics, including binding the action to a transcription already in flight.
- On a Realtime connection/setup failure, continue the same local WebSocket using the existing file-transcription fallback.
- Record audio quota from bytes received by the gateway.
- Do not persist raw interview audio, transcripts, answers, license keys, or OpenAI credentials in test reports.

## Acceptance gates

- Existing Python, gateway, and desktop routing tests remain green.
- Realtime-specific tests cover session configuration, audio streaming before commit, commit/result correlation, manual-finalize binding, disconnect cleanup, and fallback selection.
- Ozon replay: 10/10 non-empty semantically correct answers; p95 `Ctrl+Enter` to first answer at or below 4,000 ms before the feature becomes the default.
- Screen-task behavior remains unchanged.
- If the Realtime experiment misses either quality or latency gates, leave the flag disabled and retain the baseline implementation.

## Acceptance result

The experiment passed. `gpt-4o-mini-transcribe` was selected after a same-audio model comparison, Ozon passed 10/10 with p95 `Ctrl+Enter` to first answer of 3,375 ms, and the user's mandatory WAV passed the final installed frozen-backend run 3/3 with p95 3,437 ms. The legacy HTTP/WAV implementation remains available as both automatic transport fallback and explicit `SKILLCUE_REALTIME_STT=0` rollback.

## Rollback point

The pre-change workspace is preserved outside the repository at:

`C:\Users\gleb\Documents\ChatGPT\Skill-Cue\rollback-snapshots\before-realtime-stt-20260828-201839`

It records `HEAD 6807556d5510f1ce68294e4bdfd90b3d3586cc09`, tracked binary patches, status metadata, and all five untracked files.
