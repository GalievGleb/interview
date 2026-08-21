# Session Debug Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reliable per-session diagnostic report from Interview history and attach it to Telegram Desktop for support.

**Architecture:** Persist one bounded JSON diagnostic snapshot per interview in the local Python backend, alongside existing session transcripts and generated answers. Build a privacy-bounded Markdown report in the renderer, then pass it to an Electron IPC boundary that writes the file and invokes Telegram Desktop's documented `-sendpath` flow, with save/reveal fallback.

**Tech Stack:** React 18, TypeScript, Electron IPC, FastAPI, SQLAlchemy, SQLite, Vitest, Pytest.

**Spec:** `docs/superpowers/specs/2026-08-21-session-debug-report.md`

## Global Constraints

- Never persist or export API keys, license keys, Authorization headers, or unrelated operational logs.
- Diagnostic persistence and sharing are best-effort and must never interrupt the live interview.
- JSON snapshots and Markdown reports are bounded to prevent unbounded SQLite/file growth.
- Existing sessions remain readable without a migration rewrite.
- Raw audio is out of scope for this release.

---

### Task 1: Durable session diagnostics API

**Files:**
- Modify: `apps/api-py/app/db/models.py`
- Modify: `apps/api-py/app/routers/sessions.py`
- Test: `apps/api-py/tests/test_sessions.py`

**Interfaces:**
- Produces: `PUT /sessions/{session_id}/diagnostics` and `SessionDetail.diagnostics`.

- [ ] Write failing API tests for storing, replacing, bounding, and retrieving a session diagnostic snapshot.
- [ ] Run the targeted pytest tests and confirm failure because the route/data does not exist.
- [ ] Add a one-to-one `SessionDiagnostic` table and validated payload route.
- [ ] Return diagnostics and stored answer model/timestamp from `GET /sessions/{id}`.
- [ ] Run targeted API tests green.

### Task 2: Persist live model and timing snapshots

**Files:**
- Modify: `apps/desktop/src/lib/api.ts`
- Modify: `apps/desktop/src/lib/interviewSessionExport.ts`
- Modify: `apps/desktop/src/hooks/useLiveCopilot.ts`
- Test: `apps/desktop/src/lib/interviewSessionExport.test.ts`
- Test: `apps/desktop/src/lib/liveSessionCapture.test.ts`

**Interfaces:**
- Produces: `api.saveSessionDiagnostics(sessionId, bundle)` and model-aware `CopilotAnswerPipeline`.

- [ ] Write failing tests proving a stored exchange exposes model/timestamp and the live stop path persists a diagnostic snapshot.
- [ ] Run targeted Vitest tests and confirm the intended failures.
- [ ] Preserve SSE `model`/`model_source` metadata and include it in the exchange pipeline.
- [ ] Persist the bounded recorder snapshot before ending a non-empty session and after completed answers.
- [ ] Run targeted tests green.

### Task 3: Privacy-safe Markdown support report

**Files:**
- Create: `apps/desktop/src/lib/sessionDebugReport.ts`
- Test: `apps/desktop/src/lib/sessionDebugReport.test.ts`

**Interfaces:**
- Produces: `buildSessionDebugReport(input): { filename: string; content: string }`.

- [ ] Write failing table-driven tests for timing aggregation, old-session gaps, bug description, and secret/path redaction.
- [ ] Run tests and confirm failure because the formatter does not exist.
- [ ] Implement the bounded Markdown formatter with a per-exchange timeline and explicit unavailable-data labels.
- [ ] Run formatter tests green.

### Task 4: Telegram Desktop attachment IPC

**Files:**
- Create: `apps/desktop/electron/sessionReportShare.ts`
- Create: `apps/desktop/electron/sessionReportShare.test.ts`
- Modify: `apps/desktop/electron/main.ts`
- Modify: `apps/desktop/electron/preload.ts`
- Modify: `apps/desktop/src/types/electron.d.ts`

**Interfaces:**
- Produces: `electronAPI.shareSessionReport({ filename, content })` returning `{ path, telegramOpened, fallback }`.

- [ ] Write failing pure tests for filename sanitization, Telegram executable discovery, and fallback decisions.
- [ ] Run tests and confirm the feature is absent.
- [ ] Implement atomic temp-file writing and Windows Telegram `-sendpath` launch without shell interpolation.
- [ ] Add the IPC/preload/type contract and reveal/open-support fallback.
- [ ] Run Electron tests and typechecks green.

### Task 5: Interview history sharing UI

**Files:**
- Modify: `apps/desktop/src/pages/HistoryPage.tsx`
- Modify: `apps/desktop/src/pages/SessionAnalysisPage.tsx`
- Modify: `apps/desktop/src/pages/HistoryPage.behavior.test.ts`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Consumes: `buildSessionDebugReport` and `electronAPI.shareSessionReport`.

- [ ] Write failing behavior tests for a per-session report button, description/consent modal, busy/error/success states, and legacy-session support.
- [ ] Run tests and confirm the UI behavior is missing.
- [ ] Add report action to each history row and the session review header.
- [ ] Add a shared modal that previews included data, requires explicit confirmation, and reports Telegram/fallback results.
- [ ] Run UI tests and accessibility-focused checks green.

### Task 6: Release verification

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src/lib/releaseNotes.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: the next public desktop release after all gates pass.

- [ ] Run targeted API and desktop tests.
- [ ] Run full API pytest, Ruff, mypy, shared build, both desktop TypeScript configs, full desktop tests, ESLint, and `git diff --check`.
- [ ] Bump package/release notes/changelog only after the frozen source passes.
- [ ] Commit only the explicit source/test/metadata allow-list; exclude PyInstaller artifacts and unrelated untracked files.
- [ ] Tag/push and verify the release workflow and public assets before reporting completion.
