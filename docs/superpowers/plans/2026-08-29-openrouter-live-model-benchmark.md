# OpenRouter Live Model Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find a faster and sufficiently intelligent OpenRouter model for SkillCue live interview answers using the product's real Russian prompts and audio path.

**Architecture:** Use a two-stage evaluation. First, run a broad model shortlist directly through OpenRouter with the exact SkillCue fast-answer prompt and six existing semantic fixtures; then run only the strongest finalists through the installed Dev backend with the real WAV, STT, Ctrl+Enter, and streamed answer path. Do not change the default model until a candidate beats the baseline on both latency and semantic reliability.

**Tech Stack:** Python 3.12, httpx, OpenRouter Chat Completions SSE, installed SkillCue Dev backend, existing voice fixtures.

**Spec:** `tests/voice/cases.json`

## Global Constraints

- Keep the current production and Dev default model unchanged during benchmarking.
- Use the existing Russian fast-answer prompt and the six fixtures in `tests/voice/cases.json`.
- Use `tests/voice/audio/06_ctrl_enter_before_final.wav` for finalist end-to-end audio runs.
- Measure time to first visible token, full response time, semantic matches, word count, and selected upstream provider.
- A candidate must produce at least three expected semantic groups and no forbidden phrase.
- Do not persist raw transcripts, model answers, credentials, or absolute private-media paths.
- Use the Dev OpenRouter credential without printing or copying it.

---

### Task 1: Build the current shortlist

**Files:**
- Read: `tests/voice/cases.json`
- Read: `apps/api-py/app/routers/chat.py`
- Read: `apps/api-py/app/prompts/interview_fast.py`

**Interfaces:**
- Consumes: OpenRouter `/api/v1/models` metadata and endpoint availability.
- Produces: A bounded list of current models with model IDs, pricing, reasoning effort, and benchmark rationale.

- [ ] **Step 1: Query the current OpenRouter catalog**

Run a read-only request to `https://openrouter.ai/api/v1/models` and retain only text-output models available for ordinary streaming requests.

- [ ] **Step 2: Rank candidates**

Filter for low price and high current intelligence/coding scores, then include representatives from OpenAI, Google, Z.ai, DeepSeek, Qwen, and one additional high-quality fast family.

- [ ] **Step 3: Verify model IDs and endpoint availability**

Query `https://openrouter.ai/api/v1/models/<model-id>/endpoints` for every selected model and remove unavailable or batch-only entries.

### Task 2: Run the prompt-level screen

**Files:**
- Read: `tests/voice/cases.json`
- Read: `apps/api-py/app/routers/chat.py`
- Read: `apps/api-py/app/services/domain_answer_hints.py`

**Interfaces:**
- Consumes: The Task 1 shortlist and `FAST_CORE_SYSTEM_PROMPT` plus `build_fast_core_user_prompt(...)`.
- Produces: Per-model latency and semantic pass rates across six Russian interview questions.

- [ ] **Step 1: Construct the exact fast-answer messages**

For each fixture, apply `resolve_fast_question_alias`, `classify_interview_question_intent`, `build_fast_core_user_prompt`, domain hints, the verified knowledge pack, and the required output contract exactly as the live route does.

- [ ] **Step 2: Stream one request per model and fixture**

Use `temperature=0`, `max_tokens=750`, `provider.sort=throughput`, and the lowest documented reasoning effort supported by the model.

- [ ] **Step 3: Score observable behavior**

Record TTFT, total time, selected provider, expected semantic-group matches, word count, forbidden phrases, HTTP errors, and empty responses. Never save raw answer text.

- [ ] **Step 4: Select finalists**

Require at least five of six semantic passes, median TTFT below 2.5 seconds, and no empty or malformed responses.

### Task 3: Run the real audio path

**Files:**
- Read: `tools/verify_dev_voice_overlay.py`
- Read: `tests/voice/audio/06_ctrl_enter_before_final.wav`

**Interfaces:**
- Consumes: Up to three finalists from Task 2.
- Produces: Installed-Dev WAV-to-answer timing and semantic results for each finalist.

- [ ] **Step 1: Run each finalist through installed Dev**

Set only `SKILLCUE_E2E_MODEL` for the test process and run `apps/api-py/.venv/Scripts/python.exe tools/verify_dev_voice_overlay.py` three times per finalist.

- [ ] **Step 2: Compare against the saved baseline**

Compare voice-to-first-answer latency, full response latency, semantic pass rate, and variability against GPT-4.1 Mini, GPT-5.6 Luna, and GPT-OSS-120B measurements from the same fixture.

### Task 4: Decide without deploying

**Files:**
- No source changes.

**Interfaces:**
- Consumes: Prompt-level and full-audio benchmark results.
- Produces: A recommendation for default, intent-specific routing, or no change.

- [ ] **Step 1: Reject regressions**

Reject models that are faster only because they omit required concepts, repeat a canned answer, exceed the four-second voice-to-first-answer target, or fail Russian output.

- [ ] **Step 2: Report the winner and uncertainty**

Report medians, pass counts, price, selected providers, and the exact reason for keeping or changing the current routing. Do not deploy or edit model defaults in this task.
