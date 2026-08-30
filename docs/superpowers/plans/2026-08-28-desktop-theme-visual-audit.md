# Desktop Theme Visual Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Проверить все пользовательские экраны SkillCue в светлой и тёмной темах и устранить состояния hover/focus/disabled, в которых поверхность, текст, иконка или граница теряют читаемость.

**Architecture:** Не вводить третий набор цветов и не перекрашивать продукт локальными хардкодами. Исправления идут через существующие semantic tokens в `tokens.css`/`workspace.css`; точечные правила допустимы только для самостоятельных визуальных систем Preparation, Calendar и Overlay. Визуальная проверка выполняется в настоящем Electron-окне на штатном размере 1100×740 и минимальном 880×600.

**Tech Stack:** React 19, TypeScript, Tailwind CSS 3, plain CSS design tokens, Electron 39, Vitest 3, Playwright Electron.

**Spec:** запрос пользователя от 2026-08-28 в текущей задаче.

## Global Constraints

- Не менять продуктовую логику, данные пользователя, backend и поведение оверлея.
- Сохранить существующий светлый «бумажный» и тёмный «кокпитный» характер SkillCue.
- Проверить `/home`, `/prepare`, `/applications`, `/calendar`, `/documents`, `/practice`, `/history`, `/settings` и отдельное окно `/overlay`.
- Для каждого экрана проверить initial, hover, keyboard focus и доступные disabled/selected/open состояния в обеих темах.
- Проверить штатное окно 1100×740 и минимальное окно 880×600; клиппинг обязательных контролов считается дефектом.
- Не затрагивать уже имеющиеся незакоммиченные исправления live/STT.

---

### Task 1: Baseline visual inventory

**Files:**
- Create: `output/ui-audit/2026-08-28/*`
- Modify: `docs/superpowers/plans/2026-08-28-desktop-theme-visual-audit.md`

**Interfaces:**
- Consumes: Electron routes and existing `skillcue.theme` preference.
- Produces: reproducible defect list with route, theme, control state and screenshot.

- [x] **Step 1: Launch the real renderer in Electron**

```powershell
pnpm --filter @interview/desktop dev
```

- [x] **Step 2: Exercise the shared QA inventory with normal input**

```text
For each route: click the sidebar item, capture initial state, hover every visible
button/input/card, tab through focusable controls, inspect selected/open/disabled
states, then repeat after clicking “Переключить тему”.
```

- [x] **Step 3: Repeat at minimum window size**

```text
Resize the Electron main BrowserWindow to 880×600 and verify required controls,
headings, scroll containers, dropdowns and modals are not clipped or obscured.
```

### Task 2: Regression contracts for theme-safe interactions

**Files:**
- Modify: `apps/desktop/src/styles/desktopPolish.test.ts`
- Test: `apps/desktop/src/styles/desktopPolish.test.ts`

**Interfaces:**
- Consumes: defects found by Task 1.
- Produces: source-level contracts that fail when a theme-specific hardcoded hover overrides semantic foreground/background pairs.

- [x] **Step 1: Write failing tests for each confirmed shared root cause**

```ts
it('keeps interactive surfaces theme-safe on hover and focus', () => {
  expect(tokens).toContain('--twc-interactive-hover:');
  expect(indexCss).toContain('background: rgb(var(--twc-interactive-hover))');
});
```

- [x] **Step 2: Verify RED**

```powershell
pnpm --filter @interview/desktop test -- src/styles/desktopPolish.test.ts
```

Expected: FAIL because the semantic interaction token/rule is missing.

### Task 3: Minimal theme-safe CSS fix

**Files:**
- Modify: `apps/desktop/src/styles/tokens.css`
- Modify: `apps/desktop/src/styles/workspace.css`
- Modify: `apps/desktop/src/index.css`
- Modify when confirmed by screenshots: `apps/desktop/src/styles/prepare.css`
- Modify when confirmed by screenshots: `apps/desktop/src/styles/desktop-vitrine.css`
- Modify when confirmed by screenshots: `apps/desktop/src/styles/interview-calendar.css`
- Modify when confirmed by screenshots: `apps/desktop/src/styles/overlay-cockpit.css`

**Interfaces:**
- Consumes: existing `--twc-*`, `--surface-*`, `--prep-*` semantic palettes.
- Produces: stable foreground/background/border pairs for hover, focus, active and disabled states in both themes.

- [x] **Step 1: Add only the semantic values required by confirmed failures**

```css
:root { --twc-interactive-hover: 23 40 61; }
:root[data-theme='light'] { --twc-interactive-hover: 239 246 243; }
```

- [x] **Step 2: Replace the failing hardcoded interaction rule**

```css
.affected-control:hover {
  color: rgb(var(--twc-ink));
  background: rgb(var(--twc-interactive-hover));
}
```

- [x] **Step 3: Verify GREEN**

```powershell
pnpm --filter @interview/desktop test -- src/styles/desktopPolish.test.ts
```

Expected: PASS.

### Task 4: Electron visual regression pass

**Files:**
- Create: `output/ui-audit/2026-08-28/final/*`

**Interfaces:**
- Consumes: Task 3 CSS changes.
- Produces: reviewed screenshots for every route/theme/control-state pair.

- [x] **Step 1: Reload the existing Electron renderer**

```text
Use Playwright appWindow.reload() so the same application profile and window
state are retained.
```

- [x] **Step 2: Re-run functional and visual QA at 1100×740**

```text
Click every sidebar route, hover visible primary/secondary/destructive/icon
controls, keyboard-tab through inputs, and capture the densest reachable state.
```

- [x] **Step 3: Re-run at 880×600 and inspect the overlay window**

```text
Verify no required region is clipped; verify overlay controls remain legible on
the forced dark theme and do not inherit light-theme hover colors.
```

### Task 5: Final verification

**Files:**
- Test: `apps/desktop/src/**/*.test.ts`

**Interfaces:**
- Consumes: all changes above.
- Produces: fresh test/type/build evidence.

- [x] **Step 1: Run focused tests**

```powershell
pnpm --filter @interview/desktop test -- src/styles/desktopPolish.test.ts
```

- [x] **Step 2: Run desktop typecheck and build**

```powershell
pnpm --filter @interview/desktop typecheck
pnpm --filter @interview/desktop build
```

- [x] **Step 3: Run the full desktop suite**

```powershell
pnpm --filter @interview/desktop test
```

- [x] **Step 4: Inspect the final diff**

```powershell
git diff --check
git status --short
```

Full-suite result: 1300/1301 tests pass. The sole failure is the pre-existing
`electron/productSurface.test.ts` assertion that still expects tag-triggered
GitHub Actions, while the repository deliberately uses manual-only Actions to
avoid hosted-runner billing. The UI-focused suite, lint, typecheck and build pass.
