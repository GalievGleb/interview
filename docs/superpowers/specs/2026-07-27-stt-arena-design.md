# STT Arena Design

## Goal

Build a focused desktop comparison tool for Russian technical-interview speech
with English terms such as API, REST, HTTP, pytest, Playwright, Docker, and
CI/CD. The same captured audio must be sent to every selected cloud provider so
accuracy and latency can be compared fairly.

## Scope

- Cloud STT only. Local Whisper is intentionally excluded.
- First-class providers: Yandex SpeechKit v3, Deepgram Nova-3, Soniox STT Async
  v5, and OpenAI GPT-4o Transcribe.
- Candidate providers shown for later integration: Google Chirp 3 and Azure
  Speech.
- Microphone recording and WAV upload.
- Optional reference transcript with word error rate (WER).
- Raw and glossary-corrected transcript shown separately.
- Parallel provider execution, per-provider latency and errors.
- JSON export and local run history.

## Architecture

The existing SkillCue backend remains the single secret owner and provider
adapter host. A new multipart endpoint accepts one normalized mono PCM16 WAV,
validates it, and runs selected cloud providers concurrently. The desktop route
records PCM16 at 16 kHz, wraps it into WAV, and renders comparison results.

The Electron executable supports `--stt-arena`, opening the comparison route
directly without the regular SkillCue navigation. This keeps a dedicated tool
surface while reusing the packaged backend and credential store.

## Data Contract

`POST /stt/arena/compare`

- multipart `audio`: WAV file
- multipart `engines`: JSON array of `speechkit`, `deepgram`, `soniox`, `openai`
- multipart `reference`: optional exact transcript
- multipart `language`: defaults to `multi`

Response:

- audio metadata: duration, sample rate, channels, byte count
- one result per requested engine
- provider/model/display name
- raw and glossary-corrected transcript
- latency
- WER when reference text is present
- explicit unavailable/error state

## UX

The screen uses a quiet dark technical-workbench style. Recording is the main
action; provider selection and microphone choice are secondary. Results use
equal-width columns so wording differences are visible without navigation.
Latency and WER are supporting metrics, not the visual focus.

## Safety and Privacy

- API keys never enter renderer code or exported reports.
- Audio is sent only to explicitly selected cloud providers.
- A visible disclosure names each selected provider before the run.
- Uploaded audio is processed in memory and not persisted by SkillCue.
- Files over 60 seconds or invalid WAV formats are rejected.

## Verification

- Unit tests for WAV generation and WER.
- Backend tests for provider validation, parallel result mapping, and invalid
  audio rejection.
- React typecheck and production build.
- Real smoke run against every configured provider without printing secrets.
