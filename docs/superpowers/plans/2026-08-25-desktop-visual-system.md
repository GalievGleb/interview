# SkillCue Desktop Visual System Implementation Plan

> **For Codex:** Execute this plan task-by-task with TDD checkpoints. The existing dirty workspace is authoritative and must be preserved; do not reset or move unrelated work.

**Goal:** Rebuild the desktop shell and home screen to match the supplied 25 August mockups, use the first mockup as the canonical sidebar, retain every existing product workflow, and install a visually verified dev build.

**Architecture:** Keep the existing React pages, routing, Electron IPC, and feature state. Move the frameless title bar into the content column so the sidebar owns the full window height, introduce one canonical expanded/collapsed navigation shell, and replace the home presentation with a responsive three-card operations dashboard driven by the existing HH/calendar data. Use shared CSS tokens and component classes so Calendar, Profile, Practice, Interview, Vacancy analysis, and Applications inherit the same paper/mint visual language without duplicating business logic.

**Tech Stack:** React 18, TypeScript, React Router, Lucide, Tailwind utilities, plain CSS design tokens, Vitest, Electron Builder.

---

### Task 1: Canonical full-height desktop shell

**Files:**
- Modify: `apps/desktop/src/components/Layout.tsx`
- Modify: `apps/desktop/src/components/Sidebar.tsx`
- Modify: `apps/desktop/src/index.css`
- Modify: `apps/desktop/src/styles/tokens.css`
- Test: `apps/desktop/src/components/Sidebar.behavior.test.tsx`
- Test: `apps/desktop/src/components/Layout.behavior.test.tsx`

**Behavior contract:**
- Sidebar spans the whole frameless window and the title bar sits only above content.
- Expanded sidebar has the first mockup's hierarchy: 48px brand, spacious navigation, mint active state, product assistant card, and Settings / privacy / theme utilities.
- Collapse remains keyboard-accessible and the compact viewport still collapses safely.
- Theme utility switches the real application theme, not a visual-only mock.
- Existing calendar attention, stealth mode, and live overlay launch remain functional.

**TDD:** Add real rendered interaction tests for theme toggle and route navigation/layout structure; run and observe RED before production changes, then GREEN.

### Task 2: Operations-first home dashboard

**Files:**
- Modify: `apps/desktop/src/pages/HomePage.tsx`
- Modify: `apps/desktop/src/styles/prepare.css`
- Modify: `apps/desktop/src/lib/homeRadar.ts`
- Test: `apps/desktop/src/lib/homeRadar.test.ts`
- Test: `apps/desktop/src/pages/HomePage.behavior.test.tsx`

**Behavior contract:**
- Home prioritizes HH applications: actionable title, new/processed/HR stats, repeat status, primary action, and direct all-applications link.
- A code-native document/folder illustration supports the hero without an external asset.
- Right rail contains nearest interview, urgent status, and quick actions.
- Bottom progress derives from real candidate journey/application flow, never a hardcoded screenshot value.
- Existing path chooser and readiness modal keep working.

**TDD:** Add literal progress fixtures and rendered navigation/action tests, observe RED, implement the smallest behavior, then refactor visual markup.

### Task 3: Shared page polish from the remaining mockups

**Files:**
- Modify: `apps/desktop/src/styles/workspace.css`
- Modify: `apps/desktop/src/styles/prepare.css`
- Modify: `apps/desktop/src/styles/interview-calendar.css`
- Modify only where copy/semantic structure differs: `apps/desktop/src/pages/HistoryPage.tsx`, `PracticePage.tsx`, `InterviewCalendarPage.tsx`, `DocumentsPage.tsx`, `PreparePage.tsx`, `HhApplicationsPage.tsx`
- Test relevant existing behavior/layout suites; add behavior tests only for changed behavior.

**Behavior contract:**
- All seven sections share the canonical sidebar and a consistent cloud-white canvas, paper cards, navy text, restrained emerald status/action accents, 18–22px radii, subtle borders, and low shadows.
- Responsive layouts remain usable when the sidebar is collapsed or the window is narrow.
- No fake data is added and no real action is removed.

### Task 4: Verification, visual QA, and dev installation

**Files:**
- Update only generated dev artifacts outside source through the existing build/install commands.

**Checks:**
1. Focused behavior and helper tests.
2. Full desktop Vitest suite.
3. Renderer and Electron TypeScript checks.
4. Desktop lint and `git diff --check`.
5. Build dev installer with the existing dev configuration.
6. Install silently on Windows, launch the dev app, inspect Home plus at least two secondary sections at the target viewport, and correct visible clipping/alignment regressions.
7. Leave the dev build installed and report its exact version.
