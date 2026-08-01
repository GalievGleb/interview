# Contextual Mock-Interview Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mock-interview live-STT reuse with one native-rate, context-aware `gpt-transcribe` request whose raw result is evaluated without local word rewriting.

**Architecture:** Live interview transcription remains unchanged on the current WebSocket/Mini path. Mock answers use a separate browser recorder that retains one PCM16 mono answer at the microphone AudioContext rate, wraps it once as WAV, and uploads it to a dedicated local multipart endpoint. The local backend validates the recording and forwards it either directly to OpenAI or to a dedicated managed-gateway multipart endpoint using fixed `gpt-transcribe`, bounded question context, keywords, and expected languages.

**Tech Stack:** React 19, TypeScript, Web Audio API, Vitest, FastAPI, Python `wave`, `httpx`, NestJS, Node test runner, OpenAI Audio Transcriptions API.

## Global Constraints

- Keep live overlay transcription on `gpt-4o-mini-transcribe`; do not change its WebSocket, endpointer, or 16 kHz latency path.
- Mock answers use one finalized WAV at native AudioContext rate and never use silence-delimited live segments.
- Use fixed `gpt-transcribe`; expose no model picker and perform no fallback to Mini.
- The displayed and evaluated answer is the raw STT text with whitespace trimmed only; do not run dictionary or phrase replacement.
- Limit uploads to 15 MB, recording duration to 120 seconds, question context to 1,000 characters, and keywords to 32 entries of at most 64 characters each.
- Context contains only the current question and visible topic labels; never send the resume or full vacancy text to STT.
- Deploy the managed gateway before publishing the desktop update.

---

### Task 1: Native mock-answer WAV and deterministic guidance

**Files:**
- Create: `apps/desktop/src/lib/mockAnswerAudio.ts`
- Create: `apps/desktop/src/lib/mockAnswerAudio.test.ts`
- Modify: `apps/desktop/src/lib/audioCapture.ts`

**Interfaces:**
- Produces: `encodePcm16MonoWav(chunks: ArrayBuffer[], sampleRate: number): Blob`.
- Produces: `buildMockAnswerGuidance(question: string, topicLabels: string[]): { question: string; hints: string[] }`.
- Produces: `startMockAnswerRecording(): Promise<{ stop(): Blob; cancel(): void; sampleRate: number }>`.

- [ ] **Step 1: Write failing WAV and guidance tests**

```ts
it('keeps the native sample rate and combines every PCM chunk into one WAV', async () => {
  const wav = new Uint8Array(await encodePcm16MonoWav([pcmA.buffer, pcmB.buffer], 48_000).arrayBuffer());
  expect(new DataView(wav.buffer).getUint32(24, true)).toBe(48_000);
  expect(new DataView(wav.buffer).getUint32(40, true)).toBe(pcmA.byteLength + pcmB.byteLength);
});

it('deduplicates question terms and supplies QA keywords without rewriting text', () => {
  const result = buildMockAnswerGuidance('Как боретесь с flaky UI-тестами и Allure?', ['Python', 'UI']);
  expect(result.hints).toEqual(expect.arrayContaining(['flaky', 'UI', 'Allure', 'pytest']));
  expect(new Set(result.hints.map((value) => value.toLowerCase())).size).toBe(result.hints.length);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `pnpm --filter @interview/desktop test -- src/lib/mockAnswerAudio.test.ts`

Expected: FAIL because `mockAnswerAudio.ts` and its exports do not exist.

- [ ] **Step 3: Implement the minimal recorder, WAV encoder, and guidance builder**

Use raw mock microphone constraints (`echoCancellation`, `noiseSuppression`, and `autoGainControl` all `false`), reuse the selected microphone ID, retain PCM16 frames at `AudioContext.sampleRate`, write a standard 44-byte mono WAV header, deduplicate hints case-insensitively, and enforce the global bounds.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `pnpm --filter @interview/desktop test -- src/lib/mockAnswerAudio.test.ts`

Expected: PASS.

### Task 2: Dedicated local mock-answer transcription endpoint

**Files:**
- Create: `apps/api-py/tests/test_stt_mock_answer.py`
- Modify: `apps/api-py/app/routers/stt.py`
- Modify: `apps/api-py/app/services/stt/openai_transcribe.py`
- Modify: `apps/api-py/app/main.py`

**Interfaces:**
- Produces: `POST /stt/answer` multipart fields `file`, `question`, `hints`, and `language`.
- Produces: `OpenAiAnswerTranscriber.transcribe(audio: bytes, *, question: str, hints: list[str], language: str) -> str`.
- Produces: fixed `ANSWER_MODEL = "gpt-transcribe"`.

- [ ] **Step 1: Write failing provider and endpoint tests**

```py
def test_answer_request_uses_contextual_model_and_multilingual_hints():
    fields = build_answer_request_data(
        question="Что проверяете в API-ответе кроме 200?",
        hints=["API", "JSON", "schema"],
        language="ru",
    )
    assert fields["model"] == "gpt-transcribe"
    assert fields["languages"] == ["ru", "en"]
    assert fields["keywords"] == ["API", "JSON", "schema"]

def test_mock_answer_endpoint_forwards_one_complete_wav(client, monkeypatch):
    response = client.post(
        "/stt/answer",
        files={"file": ("answer.wav", valid_wav, "audio/wav")},
        data={"question": question, "hints": '["API","JSON"]', "language": "ru"},
    )
    assert response.status_code == 200
    assert response.json()["text"] == "Проверяю JSON-тело, схему и заголовки."
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `apps/api-py/.venv/Scripts/python.exe -m pytest apps/api-py/tests/test_stt_mock_answer.py -q`

Expected: FAIL because the answer endpoint and answer transcriber do not exist.

- [ ] **Step 3: Implement validation and direct/gateway forwarding**

Validate RIFF/WAVE PCM16 mono data with Python `wave`, reject empty/all-zero audio and files over 15 MB, parse and bound the JSON hints, and send multipart fields `model=gpt-transcribe`, `prompt`, repeated `keywords[]`, and repeated `languages[]`. Keep the existing Mini provider unchanged.

- [ ] **Step 4: Run focused Python tests and verify GREEN**

Run: `apps/api-py/.venv/Scripts/python.exe -m pytest apps/api-py/tests/test_stt_mock_answer.py apps/api-py/tests/test_stt_openai_mini_only.py -q`

Expected: PASS, including the unchanged Mini assertions.

### Task 3: Managed gateway answer route

**Files:**
- Create: `apps/api/src/gateway/gateway-stt.service.test.ts`
- Modify: `apps/api/src/gateway/gateway-stt.service.ts`
- Modify: `apps/api/src/gateway/gateway.controller.ts`

**Interfaces:**
- Produces: `POST /gateway/stt/answer` multipart file plus `prompt`, `keywords`, and `languages` JSON fields.
- Produces: `buildAnswerTranscriptionForm(audio: Buffer, guidance: AnswerTranscriptionGuidance): FormData`.
- Keeps: `STT_MODEL = "gpt-4o-mini-transcribe"` for `/gateway/stt/transcribe`.
- Adds: `ANSWER_STT_MODEL = "gpt-transcribe"` for `/gateway/stt/answer`.

- [ ] **Step 1: Write the failing Node test**

```ts
test('answer form uses gpt-transcribe while live keeps Mini', async () => {
  const form = buildAnswerTranscriptionForm(Buffer.from(validWav), {
    prompt: 'Техническое интервью. Вопрос: что проверяете кроме 200?',
    keywords: ['API', 'JSON'],
    languages: ['ru', 'en'],
  });
  assert.equal(form.get('model'), 'gpt-transcribe');
  assert.equal(STT_MODEL, 'gpt-4o-mini-transcribe');
  assert.deepEqual(form.getAll('keywords[]'), ['API', 'JSON']);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm --filter @interview/api build && node --test apps/api/dist/gateway/gateway-stt.service.test.js`

Expected: FAIL because the answer-form builder and answer route do not exist.

- [ ] **Step 3: Implement the multipart route and fixed answer model**

Use Nest `FileInterceptor` with a 15 MB limit, validate and bound the body fields again, call OpenAI `/audio/transcriptions` with a native `FormData`, and charge the same STT duration quota. Never route this endpoint to Mini.

- [ ] **Step 4: Build and run the focused gateway test**

Run: `pnpm --filter @interview/api build && node --test apps/api/dist/gateway/gateway-stt.service.test.js`

Expected: PASS.

### Task 4: Wire the mock UI to the finalized answer path

**Files:**
- Create: `apps/desktop/src/lib/mockAnswerSubmission.test.ts`
- Modify: `apps/desktop/src/lib/api.ts`
- Modify: `apps/desktop/src/lib/vacancyReview/useVoiceAnswer.ts`
- Modify: `apps/desktop/src/lib/vacancyReview/useVoiceAnswer.errorRecovery.test.ts`
- Modify: `apps/desktop/src/components/prepare/SmokeInterviewView.tsx`

**Interfaces:**
- Adds: `api.transcribeMockAnswer(wav: Blob, context: { question: string; hints: string[]; language: string }): Promise<{ text: string; model: "gpt-transcribe" }>`.
- Changes: `useVoiceAnswer(onText, { language, question, topicLabels })` records locally and calls the answer endpoint only from `finish()`.

- [ ] **Step 1: Write failing source-boundary and submission tests**

```ts
it('mock voice capture no longer imports or starts the live STT session', () => {
  expect(source).not.toContain('startLiveSession');
  expect(source).not.toContain('createVoiceAnswerTranscript');
  expect(source).toContain('startMockAnswerRecording');
  expect(source).toContain('transcribeMockAnswer');
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `pnpm --filter @interview/desktop test -- src/lib/mockAnswerSubmission.test.ts src/lib/vacancyReview/useVoiceAnswer.errorRecovery.test.ts`

Expected: FAIL because the hook still imports and uses live STT.

- [ ] **Step 3: Implement the finalized-only UI flow**

Do not mutate the textarea during recording. On submit, stop once, upload once, trim only outer whitespace, fill the textarea with the returned raw transcript, and then evaluate. On cancellation or error, preserve existing typed text and do not submit an empty evaluation.

- [ ] **Step 4: Run focused and regression suites**

Run:

```powershell
pnpm --filter @interview/desktop test
pnpm --filter @interview/desktop typecheck
apps/api-py/.venv/Scripts/python.exe -m pytest apps/api-py/tests -q
pnpm --filter @interview/api build
```

Expected: all commands PASS.

### Task 5: Server-first rollout and desktop release

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src/lib/releaseNotes.ts`
- Modify: `apps/desktop/electron/productSurface.test.ts`

**Interfaces:**
- Managed gateway `/gateway/stt/answer` must return `{ text, model: "gpt-transcribe" }` before the desktop release is marked latest.

- [ ] **Step 1: Deploy and probe the managed gateway**

Deploy with the repository's existing gateway deployment script, then send an authorized multipart WAV probe and assert HTTP 200, non-empty `text`, and `model === "gpt-transcribe"`.

- [ ] **Step 2: Bump desktop version and add release notes**

Add a release note stating that mock answers now use one native-rate contextual recording and that live STT is unchanged.

- [ ] **Step 3: Build and publish the desktop updater artifact**

Run: `pnpm --filter @interview/desktop dist:full`, publish `SkillCue-Setup.exe`, its blockmap, and `latest.yml`, then compare the remote SHA-256 digest with the local installer.

- [ ] **Step 4: Verify updater metadata**

Assert the GitHub latest release tag and `latest.yml` version match the new desktop version and that all three assets are in the uploaded state.
