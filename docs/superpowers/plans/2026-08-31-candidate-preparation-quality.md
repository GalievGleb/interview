# Candidate Preparation Quality Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use test-driven-development and systematic-debugging while executing each task. Preserve unrelated HH worktree changes.

**Goal:** Make Profile & experience, vacancy analysis, and practice form one understandable preparation flow, while ensuring each practice answer receives real, technically credible AI feedback instead of an invisible heuristic fallback.

**Architecture:** Keep the existing persisted `SmokeReviewSession` contract for backward compatibility, but shrink the model-facing per-answer contract to the few fields a candidate can act on. The backend expands and hardens that compact result into the existing response shape. Treat role selection as preparation context rather than an abstract growth goal, remove the unused self-assessment, and make fallback/error state explicit. Improve deterministic vacancy extraction so an AI outage cannot erase requirements such as gRPC, Kubernetes, microservices, and load testing.

**Tech Stack:** React 18, TypeScript, Vite/Vitest, Electron, FastAPI/Pydantic, pytest, Playwright Electron.

---

### Task 1: Lock the observed regressions into tests

**Files:**
- Modify: `apps/api-py/tests/test_vacancy_guard.py`
- Modify: `apps/desktop/src/lib/vacancyReview/vacancyReview.test.ts`
- Modify: `apps/desktop/src/pages/CandidateFlow.behavior.test.ts`
- Modify: `apps/desktop/src/pages/PersonalProgressPage.behavior.test.ts`

1. Add failing tests that require a compact per-answer model contract and a realistic bounded feedback deadline.
2. Add failing deterministic-analysis tests for senior titles and explicit vacancy technologies.
3. Add failing UI contract tests that remove the unused baseline self-assessment, rename the abstract goal, and distinguish active practice from completed results.
4. Run only these tests and confirm the expected failures.

### Task 2: Repair answer evaluation at the source

**Files:**
- Modify: `apps/api-py/app/prompts/vacancy.py`
- Modify: `apps/api-py/app/routers/vacancy.py`
- Modify: `apps/api-py/app/services/vacancy_guard.py`
- Modify: `apps/desktop/src/lib/api.ts`
- Modify: `apps/desktop/src/lib/vacancyReview/vacancyReviewService.ts`

1. Replace the oversized model response shape with a compact coaching result: calibrated score, crisp verdict, specific feedback, genuine strengths, decisive gaps/corrections, a ready-to-say answer, and one natural follow-up.
2. Expand missing optional fields server-side so old saved sessions and reports remain compatible.
3. Give offline feedback a visible source/reason and prevent generic local prose from masquerading as AI coaching.
4. Set a bounded practice-only deadline that permits one compact model answer without affecting live-overlay latency.
5. Run focused backend and desktop tests.

### Task 3: Make vacancy analysis honest and complete

**Files:**
- Modify: `apps/desktop/src/lib/vacancyReview/vacancyReviewService.ts`
- Modify: `apps/desktop/src/lib/vacancyReview/topicExtraction.ts`
- Modify: `apps/desktop/src/lib/vacancyReview/types.ts`
- Modify: `apps/desktop/src/components/prepare/VacancyAnalysisView.tsx`

1. Preserve the AI failure reason/source instead of swallowing it.
2. Extend deterministic extraction for explicit role requirements, including gRPC, Kubernetes, microservices, load testing, and correct seniority.
3. Stop reporting every unmatched résumé topic as a partial match; use a real gap state.
4. Show a concise “local analysis” notice with retry instead of pretending the result came from full AI analysis.
5. Test against the saved Ozon vacancy fixture.

### Task 4: Simplify Profile & experience and Practice

**Files:**
- Modify: `apps/desktop/src/components/candidate/GrowthProfileSetup.tsx`
- Modify: `apps/desktop/src/lib/growthProfile.ts`
- Modify: `apps/desktop/src/pages/DocumentsPage.tsx`
- Modify: `apps/desktop/src/pages/PracticePage.tsx`
- Modify: `apps/desktop/src/components/prepare/GeneralPracticeSetup.tsx`
- Modify: `apps/desktop/src/components/prepare/SmokeInterviewView.tsx`
- Modify: preparation styles under `apps/desktop/src/styles/`

1. Rename “professional goal” to “role for preparation” and state exactly where it is used.
2. Remove the unused starting self-assessment UI while preserving stored legacy data.
3. Present an unfinished session as a compact resume action, not as the dominant page/result.
4. Separate unfinished and completed attempts; keep “new practice” always available.
5. Replace the feedback wall with three primary blocks: what worked, what to fix, and how to answer better. Keep genuinely useful diagnostics collapsed.
6. Verify both themes at the standard 1100×740 desktop viewport.

### Task 5: Run an actual coaching corpus and iterate

**Files:**
- Modify: `apps/desktop/tools/verify-practice-coaching-quality.mjs`
- Create/modify: focused quality fixtures as needed.

1. Run the six-case corpus through the same installed backend/model route used by the app.
2. Check score ordering, detection of the inverted `sort`/`sorted` answer, honesty about missing Kubernetes experience, semantic credit for a strong test-design answer, and resilience to ASR filler.
3. Review every returned better answer manually for technical correctness and natural Russian.
4. Iterate prompt/hardening until all cases pass without one-off phrase rules.

### Task 6: Full verification and dev install

**Files:**
- Modify: `apps/desktop/tools/audit-candidate-prep-ui.mjs`
- Verify: all touched files and existing dirty HH files remain intact.

1. Run focused pytest and Vitest suites, then full desktop tests, typecheck, and build.
2. Build/install the dev application using the repository installation script.
3. Run the Playwright Electron audit in light and dark themes and inspect screenshots.
4. Run the installed coaching corpus and record latency/quality evidence.
5. Only then hand the dev build back to the user.
