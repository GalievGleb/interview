# Real Interview Acceptance Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the private Ozon, Lamoda, and PositiveTech recordings into a repeatable pass/fail exam for the installed SkillCue Dev voice and screen pipelines.

**Architecture:** Add a local-manifest-driven Python runner that launches the installed backend with its installed gateway identity, replays WAV excerpts through the real STT WebSocket with real-time pacing and Ctrl+Enter finalization, sends visible tasks through the real screen SSE route, validates semantic and latency budgets, and writes only privacy-safe metrics. Keep recordings, frames, transcripts, answers, and absolute media paths outside Git.

**Tech Stack:** Python 3.11, asyncio/websockets, installed FastAPI backend, managed SkillCue gateway, pytest.

**Specs:** `docs/superpowers/plans/2026-08-27-ozon-interview-replay.md`, `docs/superpowers/specs/2026-08-25-overlay-launch-voice-routing.md`

## Global Constraints

- Do not use Whisper or another alternate transcription engine.
- Exercise the installed SkillCue Dev backend and its existing gateway identity.
- Voice replay must preserve utterance pauses by pacing PCM at real time.
- Start answering only after the explicit finalize action that represents `Ctrl+Enter`.
- A pass requires a terminal non-empty answer, semantic matches, and latency within budget.
- Do not commit source recordings, derived clips, screenshots, transcripts, answers, names, or absolute private paths.
- A privacy-safe report may contain only case IDs, pass/fail reasons, aggregate timings, semantic match keys, model metadata, and hashes.

---

### Task 1: Define strict manifest and privacy-safe result contracts

**Files:**
- Create: `tools/real_interview_acceptance.py`
- Create: `tools/tests/test_real_interview_acceptance.py`

**Interfaces:**
- Consumes: a versioned local JSON manifest with voice and screen cases.
- Produces: validated case definitions and reports that exclude raw content and source paths.

- [x] **Step 1: Write failing tests** for malformed cases, incorrect percentile calculation, one-failure suite semantics, and report privacy.
- [x] **Step 2: Run the focused pytest file** and confirm it fails because the production module does not exist.
- [x] **Step 3: Implement the smallest manifest, scoring, percentile, and sanitization functions.**
- [x] **Step 4: Rerun the focused tests** and confirm they pass.

### Task 2: Implement exact installed voice replay

**Files:**
- Modify: `tools/real_interview_acceptance.py`
- Modify: `tools/tests/test_real_interview_acceptance.py`

**Interfaces:**
- Consumes: mono PCM16 WAV excerpt, expected transcript/answer concepts, latency budgets.
- Produces: STT final after explicit finalize plus a terminal streamed interview answer.

- [x] **Step 1: Add failing tests** for real-time chunk pacing math, empty terminal answer failure, semantic failure, and trigger-to-first-answer timing.
- [x] **Step 2: Run focused tests** and confirm the new behavior is absent.
- [x] **Step 3: Add installed-backend lifecycle, WebSocket STT replay, finalize handling, and interview SSE answer generation.**
- [x] **Step 4: Rerun focused tests** and confirm transport-independent behavior passes.

### Task 3: Implement exact installed screen replay

**Files:**
- Modify: `tools/real_interview_acceptance.py`
- Modify: `tools/tests/test_real_interview_acceptance.py`

**Interfaces:**
- Consumes: a private PNG/JPEG task frame, question/context, expected answer concepts.
- Produces: a terminal streamed screen answer with first-token and total latency.

- [x] **Step 1: Add failing tests** for missing images and incomplete screen streams.
- [x] **Step 2: Implement the screen SSE route and shared semantic evaluation.**
- [x] **Step 3: Rerun focused tests** and confirm screen and voice evaluations remain isolated.

### Task 4: Create and run the private real-interview matrix

**Files:**
- Create locally only: `output/interview-replay/acceptance-cases.json`
- Create locally only: `output/interview-replay/acceptance-report.json`
- Modify: `.gitignore` only if a new private output path is not already covered.

**Interfaces:**
- Consumes: selected Ozon voice excerpts and Lamoda/PositiveTech visible-task frames.
- Produces: local repeatable evidence across at least one voice and one screen case.

- [x] **Step 1: Build a private manifest** from existing ignored replay artifacts without copying personal content into source-controlled files.
- [x] **Step 2: Run each representative case through installed SkillCue Dev.**
- [x] **Step 3: Repeat pause-sensitive voice cases and record p50/p95 trigger-to-first-answer latency.**
- [x] **Step 4: Fix only deterministic failures with a failing regression test first, then rerun the affected case.**

### Task 5: Verification and handoff

**Files:**
- Modify: `apps/desktop/package.json` only if a stable command is useful.
- Modify: this plan to check completed steps.

**Interfaces:**
- Consumes: focused unit tests, installed acceptance matrix, repository diff.
- Produces: reproducible command, privacy-safe report, and explicit remaining limitations.

- [x] **Step 1: Run focused pytest and lint/compile checks for the new tool.**
- [x] **Step 2: Run relevant existing renderer routing tests** so the headless backend evidence is paired with speaker/screen selection coverage.
- [x] **Step 3: Inspect the report, `git diff --check`, and `git status --short`.**
- [x] **Step 4: Report exact pass/fail evidence without claiming untested full-video coverage.**

## Verification evidence

- Tool contract: 17 pytest tests pass; Ruff and `py_compile` pass.
- Renderer routing: 102 Vitest tests pass across forced-answer coordination, overlapping speech activity, live reliability, visual routing, and overlay request routing.
- Installed private replay: Lamoda visible API/DB task and PositiveTech visible Python task pass semantically and within first-token budgets.
- Ozon pause-split voice question is merged correctly and always produces a non-empty semantically correct Docker answer.
- Ozon three-run trigger-to-first-answer latency: 3437 / 4125 / 5407 ms (p50 4125 ms, p95 5407 ms). Strict 4000 ms SLA therefore remains failed in 2/3 attempts; STT p95 4141 ms is the dominant variance while LLM first-token p95 is 1266 ms.
- The final one-run full matrix remains strict-red only for Ozon latency (5140 ms); both screen cases pass.
- Reports and manifests are ignored under `output/interview-replay/` and contain no transcript, answer, or absolute media path.
- This is representative-case coverage, not a claim that every minute of all three recordings was replayed.
