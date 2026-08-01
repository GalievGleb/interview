# Contextual Mock-Interview Transcription Design

## Goal

Make voice answers in mock interviews accurately preserve Russian speech mixed with QA/Python terminology such as `flaky`, `UI`, `Allure`, `pytest`, and `conftest`, while keeping model selection automatic and avoiding post-transcription word replacement.

## Observed regression

The saved mock-session payload contains the same corrupted text shown in the UI, so evaluation and rendering are not rewriting the answer. The current mock path reuses live STT: browser audio is linearly resampled to 16 kHz, split after 500 ms of silence, and each short segment is sent to `gpt-4o-mini-transcribe` with only `language=ru`. The question and technical vocabulary are absent from the transcription request. This loses context precisely where Russian/English code-switching occurs.

## Considered approaches

1. Keep Mini and add a prompt. This is the smallest server change, but preserves the model and segmented low-resolution audio that produced the regression.
2. Record one native-rate answer and use fixed `gpt-transcribe` with question context and keyword hints. This is the approved approach because it addresses audio quality, segmentation, and code-switching without rewriting output.
3. Correct the Mini transcript afterward with dictionaries or an LLM. Rejected because it can invent words and makes the displayed transcript differ from what the speech model returned.

## Architecture

Live transcription and mock-answer transcription become separate paths:

- Live overlay stays on `gpt-4o-mini-transcribe`, 16 kHz, and the existing utterance endpointer so Ctrl+Enter latency does not regress.
- A mock answer records PCM16 mono at the microphone's native AudioContext rate until the candidate submits the answer. The recorder creates one WAV file, with a two-minute safety cap so a 48 kHz answer stays below 15 MB, and never runs the 500 ms server VAD.
- The desktop sends the WAV plus `language`, the current question, and a bounded hint list to a dedicated local endpoint.
- The local backend sends that completed answer to fixed `gpt-transcribe`. Direct-key and managed-gateway paths carry the same guidance.
- The managed gateway keeps the existing Mini route for live calls and adds an answer route for `gpt-transcribe`; the gateway must be deployed before the desktop update is published.

There is no model picker and no fallback that silently sends mock answers back through Mini.

## Guidance construction

The transcription context contains only the current interview question and short vacancy/topic labels already visible to the candidate. It does not send the resume or full vacancy body.

Hints are bounded and deterministic:

- Latin/code tokens extracted from the current question and topic labels.
- A small QA/Python vocabulary used as recognition guidance: `flaky`, `UI`, `Allure`, `pytest`, `fixture`, `conftest`, `Playwright`, `Selenium`, `Page Object`, `GitLab`, `CI/CD`, `API`, `HTTPX`.
- Duplicate hints are removed case-insensitively and the list is capped before transport.

Hints influence speech recognition only. The returned text remains the raw STT text except for whitespace compaction already present in the UI.

## UI flow

1. Pressing the microphone starts native-rate recording and shows the existing recording state.
2. The textarea is not filled with unstable partial chunks while recording.
3. Pressing the answer/send action stops capture, uploads one WAV, and shows the existing finalizing state.
4. On success, the finalized raw transcript fills the answer and the normal evaluator runs.
5. On empty audio or transcription failure, evaluation is not submitted as an empty answer. The current typed text is preserved and the UI offers a clear retry message.

## API and validation

- Desktop-to-local transport uses multipart form data with one WAV plus bounded text fields.
- The local endpoint accepts at most 15 MB and validates WAV content, non-empty audio, context length, and hint count/length.
- Local-to-gateway transport uses multipart form data on a dedicated answer endpoint; context metadata stays in the request body rather than query strings so questions do not appear in access logs.
- Timeouts and upstream errors are surfaced as transcription errors; no automatic post-correction or hidden model fallback occurs.

## Tests

- Desktop unit tests prove native-rate frames are combined into one valid WAV, question-derived hints are included and deduplicated, and submission waits for the one final transcript.
- FastAPI tests prove multipart validation and that context/hints reach the answer provider while the live stream still selects Mini.
- Gateway tests prove live requests use Mini, answer requests use `gpt-transcribe`, and guidance fields are forwarded.
- Existing mock evaluation and live Ctrl+Enter suites remain green.

## Success criteria

- A mock answer is uploaded once after submit rather than transcribed in silence-delimited pieces.
- `flaky`, `UI`, `Allure`, and similar mixed-language terms are supplied to STT as context/hints.
- The transcript shown and evaluated is the raw finalized STT result, not dictionary-corrected text.
- Live overlay latency and its model remain unchanged.
- The feature works through both BYOK and the managed SkillCue gateway after server-first rollout.
