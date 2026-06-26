# Handoff: SkillCue — "Interview Cockpit" redesign

## Overview
A full visual redesign of the SkillCue desktop app (Electron + React + Vite + Tailwind, `apps/desktop`) into the **"Split Intelligence Workspace"** direction: a calm, dark technical cockpit for live technical-interview support. It covers all primary screens — Live Interview, Onboarding (local Whisper), Speech Recognition Settings, Test Lab, STT Benchmark, Diagnostics, History, Documents — plus two new things the current app doesn't have as first-class screens (a **STT Benchmark** route and a **Diagnostics** route) and a **Focus mode** on the live screen.

The goal of the redesign: a stressed candidate must be able to read the current state — **listening → transcribing → answering → say this** — in under one second, with the answer always the dominant element.

## About the design files
The files in this bundle are **design references created in HTML** — an interactive prototype showing the intended look, layout, states, motion, and copy. **They are not production code to copy verbatim.** The task is to **recreate these designs inside `apps/desktop`** using its existing stack: React + `react-router-dom`, Tailwind (the theme in `tailwind.config.js` already matches this design), the global cockpit classes in `src/index.css` / `src/styles/interview-cockpit.css`, and the existing pages/components/hooks/services. Do **not** introduce a new component library, a CSS-in-JS layer, or new design tokens — everything here maps onto values that already exist in the codebase.

- `Skillcue.dc.html` — the interactive prototype. Open it in a browser to see every screen, the animated live pipeline, hover/expand states, tab switching, search, etc. It's a single self-contained file (a "Design Component"); read its markup for exact structure, inline styles, and copy. Ignore the `<x-dc>` / `renderVals()` framework scaffolding — only the visual structure and the `state`/data arrays matter.
- `assets/ds/` — the exact design-token CSS (colors, type, spacing, radius, elevation, motion, plus the `interview` + `workspace` component classes). Use this as the source of truth for any value. **Note:** these values are already mirrored in `apps/desktop/tailwind.config.js` and the global CSS — prefer the existing Tailwind classes; reach for these files only to confirm a hex/spacing/easing value or to copy a new keyframe.

## Fidelity
**High-fidelity (hifi).** Final colors, typography, spacing, radii, shadows, motion and copy. Recreate the UI to match, using the codebase's existing Tailwind classes and global cockpit CSS rather than re-deriving values.

---

## Token mapping (prototype → existing codebase)
The prototype uses CSS variables (`var(--…)`). Every one already has a home in `tailwind.config.js` or the global CSS. Use the Tailwind class.

| Prototype token | Value | Use in codebase |
|---|---|---|
| `--surface-app` | `#0a0b0f` | `bg-surface` |
| `--surface-panel` | `#0f1117` | `bg-surface-panel` (sidebar, top bar) |
| `--surface-card` | `#15171e` | `bg-surface-card` / `bg-surface-light` |
| `--surface-hover` | `#1b1e26` | `bg-surface-hover` / `hover:bg-surface-light` |
| `--surface-elevated` | `#1d212b` | `bg-surface-elevated` (chips, inputs-on-card) |
| `--surface-border` | `#23262f` | `border-surface-border` |
| `--surface-border-strong` | `#2f333f` | `border-surface-border-strong` (hover / focused panel) |
| `--accent` | `#6366f1` | `bg-accent` / `text-accent` / `border-accent` |
| `--accent-soft` | `rgba(99,102,241,.14)` | `bg-accent-soft` |
| `--accent-text` | `#818cf8` | `text-accent` (indigo-400 on dark) |
| `--text-strong` | `#e7e9ef` | `text-ink` |
| `--text-muted` | `#9aa1ad` | `text-ink-muted` |
| `--text-faint` | `#6b7280` | `text-ink-faint` |
| status: live/success | `#34d399` (emerald-400) | green-400 family |
| status: processing/warn | `#fbbf24` (amber-400) | yellow/amber-400 family |
| status: error | `#f87171` (red-400) | red-400 family |
| speaker "you" | `#a78bfa` (violet-400) | violet-400 family |
| info / english tab | `#38bdf8` (sky-400) | sky-400 family |
| radius card / control | `16px` / `12px` | `rounded-2xl` (`rounded-card`) / `rounded-xl` |
| shadow card / glow | see config | `shadow-card` / `shadow-glow` |
| font UI / mono | Inter / **JetBrains Mono** | `font-sans` / add a `font-mono` |

**One addition to make:** the design uses **JetBrains Mono** for all metrics (latency, model IDs, tabular numbers, raw↔corrected diffs). The current config has no mono family. Add `fontFamily.mono: ['JetBrains Mono','ui-monospace','SF Mono','Menlo','monospace']` to `tailwind.config.js`, load the webfont (it's in `assets/ds/tokens/fonts.css`), and apply `font-mono tabular-nums` everywhere a latency / size / id is shown.

**Status colors are fixed and semantic** — never use the indigo accent for "live"/"success". Live & interviewer = emerald, processing/warning = amber, error = red, answer-ready & "you" channel = indigo/violet.

---

## Global shell

### Sidebar — `src/components/Sidebar.tsx`
Reorganize the flat nav into **three labeled groups** (small uppercase 10px `tracking-wide text-ink-faint` headers), and add two routes:

- **Workspace**: Live Interview (`/interview`), Test Lab (`/test-lab`), **STT Benchmark (`/benchmark`) — NEW route**
- **Library**: Documents (`/documents`), History (`/history`)
- **System**: **Diagnostics (`/diagnostics`) — NEW route**, Settings (`/settings`)

Keep: the `SC` monogram + "SkillCue" wordmark at the top, the `NavLink` + `.nav-pill` / `.nav-pill-active` pattern, and `width: 220px`. The active pill fills `bg-accent-soft`, text goes `text-ink`, and the icon tints `text-accent` (already the pattern). Each nav row: 17px Lucide icon + label, `rounded-full` pill, `px-3 py-2`, `text-sm font-medium`.
- The "Live Interview" row shows a small breathing emerald dot on the right while a session is live.
- **Footer:** replace the dev `🛡 / 👁` emoji toggles with line-icon buttons (no emoji in product surfaces). Add a **local-model status card** — a clickable tile showing `[mic icon] Whisper · ● Ready / Balanced · ~480 MB` that opens the Onboarding/STT setup. Keep the backend/API `StatusBadge`s.
- Add a **search row** at the top of the sidebar: a ghost field `[search icon] Search … ⌘K` that opens the existing `CommandPalette`.

### App title bar (top, full width, 50px) — likely `src/components/Layout.tsx`
A slim top chrome: window-control dots (left), `SC` monogram + "SkillCue" + a mono `2.0` version chip, a vertical divider, then session context (`● Senior QA Automation · 00:14:06` with a live dot + mono clock). Right cluster: a **Focus** toggle button and a **`[shield] Local · Private`** status pill (emerald-tinted). `bg-surface-panel`, `border-b border-surface-border`. (The meeting/overlay routes can hide it.)

### Page header pattern (every non-live screen)
A header strip: `flex items-end justify-between, px-6 py-[18px], border-b border-surface-border`. Left = `h1` (20px, `font-semibold tracking-[-0.014em] text-ink`) + a 13px `text-ink-muted` subtitle. Right = action buttons. Body below is a single scroll container (`overflow-y-auto`) with a centered max-width (≈860–1040px for reading/table routes).

---

## Screens

> For exact markup, inline styles and copy, open `Skillcue.dc.html` and find the matching `data-screen-label` section. Each screen below names the real file(s) to edit.

### 1. Live Interview — `pages/InterviewPage.tsx` (+ `LiveCopilot.tsx`, `TranscriptPanel.tsx`, `SuggestionPanel.tsx`, `components/interview/*`, hooks `useLiveCopilot.ts`)
The hero screen. **Only this route shows the cockpit backdrop** — a 48px graph-paper grid faded by a radial mask + a faint indigo/emerald ambient glow (classes already in `interview-cockpit.css` / `assets/ds/tokens/base.css` as `.sc-cockpit-*`; replicate with your existing cockpit CSS). Layout, top to bottom:

**a) Live status bar** (sticky under the title bar, `bg-surface/80`, `border-b`):
- Row 1: a large **status pill** with a breathing ping dot — label is one of `Idle · Listening · Speech detected · Transcribing · Answering · Answer ready` (pill tint follows status: emerald while listening, amber while processing, indigo when ready). Next to it, a **status flow** `Listening → Transcribing → Answering` where the active step is `text-ink` and the rest `text-ink-faint`. Right-aligned: three **latency metric badges** `STT · LLM · Total` (mono values, `—` until known), and the **Start Live / Stop** button (`Stop` = danger style while live).
- Row 2: compact stat chips — `[mic] Mic`, `[monitor] System audio`, `STT: Local Whisper`, `Model: Balanced`, `LLM: gpt-4o-mini`, `Lang: RU`, `Overlay: On`. Label part `text-ink-faint`, value part `text-ink`.

**b) Two-column workspace** (`grid-template-columns: minmax(330px,400px) 1fr; gap:16px; grid-template-rows: minmax(0,1fr)` so panels scroll internally):
- **Left — Conversation timeline** (secondary, trustworthy). A `.sc-panel` titled "Conversation" with a **live waveform** beside the title (animated emerald bars while speech is detected, idle/flat otherwise) and a mono `first partial 0.31s` chip. Body = a vertical timeline (`.sc-timeline` / `.sc-tnode`): each node has a 24px round avatar (`И` interviewer = emerald, `Я` you = violet), a `who · time(mono)` line, and a bubble. Bubble states:
  - **interim** — italic, `text-ink-faint`, with a blinking caret (`«Что такое си си ди»`)
  - **final** — solid `text-ink` (`Что такое CI/CD?`)
  - **correction chip** under a final node when the glossary fired — `.sc-tfix`: a small indigo-tinted chip `✓ си си ди → CI/CD` (mono), with a one-shot flash animation when it lands
  - **skipped** — strikethrough, faint, with a mono reason line (`Skipped · audio below speech threshold`)
  - per-node mono meta: `first partial 0.31s · final 0.82s`
- **Right — Response card** (the dominant element). A `rounded-2xl` card with `bg-surface-card`, an indigo-tinted border, a soft indigo focus glow (`shadow-panel-focus` + faint glow), and a 3px indigo gradient bar across the top. While the answer is being generated, a slow **rotating conic-gradient border** sweeps the card (a 1px ring behind the content) to signal "working". Contents:
  - header: `ANSWER` micro-label · a context chip `[file] based on Resume · QA Automation` · right-aligned **confidence meter** (`High / Medium / Low` + a 48px track filled to the % — green/amber/red).
  - the question being answered (15px `font-semibold text-ink`, with a small speech-bubble icon).
  - **answer mode tabs** (`.sc-tabs`): `Say aloud · Short · Detailed · English · Risks`. Switching tabs swaps the answer text instantly.
  - **answer prose** — 15–15.5px / line-height 1.65, `text-ink`. Default ("Say aloud") is **50–80 words, direct, no filler, easy to read aloud**, specific to QA Automation / Python. While generating, it **streams in word-by-word** with a blinking caret.
  - footer: metric badges `STT · LLM · Total` (Total highlighted indigo), a `1 term corrected` accent badge, and **Regenerate** (ghost) + **Copy** (primary, → "Copied ✓") buttons.
  - **Below the card — manual question input** (`.sc-command`): a textarea "Type a question to answer manually…", a bottom bar with a `Manual question` hint and a **Get answer ⌘↵** button. Maps to `useManualInterviewAsk.ts`.

**c) Focus mode** (NEW; the design system's "B" concept as a toggle): the Focus button in the title bar opens a full-screen calm overlay over the live route — the status pill, the question (small, emerald), and the answer at **26px / line-height 1.5** centered for reading under pressure, with an `Exit · Esc` button. Wire `Esc` to close.

**Pipeline / state** (drives the whole screen — already modeled by `interviewPipeline.ts` / `liveSession.ts` / `useLiveCopilot.ts`): `idle → listening → speech → final → answering → ready`. The prototype's `SCRIPT` array (in `Skillcue.dc.html`) is a faithful demo of the signature progression and good test data: interim text → final text → `fix {from,to}` → per-item latencies `{first, final, llm, total}` → confidence → 5 answer variants. Use it to validate the real wiring.

### 2. Onboarding (local Whisper, first-run) — `pages/OnboardingPage.tsx` + `components/OnboardingSttStep.tsx`
Full-screen takeover (cockpit backdrop, centered ≤1040px). Header: `SC SkillCue · FIRST-RUN SETUP · Skip`. Title **"Set up local speech recognition"** + subtitle. Two cards: a **"Local Whisper — Recommended"** privacy card (`[shield]`, "Audio is transcribed locally … not sent to the cloud in local mode. Runs on your CPU/GPU."), and a **"What to expect"** card (3 line-icon bullets: works offline once downloaded · uses CPU/GPU — may affect battery/fan/performance · a model must be downloaded first).

**Three model cards** (`components/interview/ModelCard.tsx` / `ModelSelect.tsx`; data from `packages/shared` `sttProviders.ts`): **Fast**, **Balanced (Recommended)**, **Quality**. Each card: name + (Recommended badge) + a radio circle (filled indigo check when selected); mono `size · device` (`~75 MB · weak laptop · battery`, `~480 MB · most laptops`, `~1.5 GB · powerful laptop · desktop`); a short description; three **3-segment meters** — Speed (emerald), Accuracy (indigo), Resource (amber) — filled to the model's level; and a status footer: `● Downloaded · Ready` / a download **progress bar** while downloading / `Not downloaded`. Selected card = indigo border + `bg-accent-soft` (`.sc-model-card--selected`).

Actions row: **Auto-choose for my device** (ghost, sparkles) · **Download selected model** (primary, animates a progress bar to 100% then flips to Ready) · `Selected: Balanced` · **Change later in Settings** (ghost) · **Continue** (primary, → `/interview`).

### 3. Speech Recognition Settings — `components/SpeechRecognitionSettings.tsx` (`pages/SettingsPage.tsx`, `MicrophoneSettings.tsx`, `AiModelsSettings.tsx`, `lib/sttOptions.ts`)
Reading-width stack of `.sc-card`s (20px padding), each a `label + description` left / control right row using **segmented controls** (`.sc-segmented`, `components/core/SegmentedControl`):
- **Recognition mode**: `Local Whisper · Cloud fallback · Auto` + an info alert "Audio is transcribed locally and is not sent to the cloud in local mode" when not Cloud.
- **Local model**: `Fast · Balanced · Quality`. **Compute device**: `Auto · CPU · GPU` (Auto = GPU if available, else CPU).
- **Model downloads**: a row per model — mic-tile + name + mono size + status badge + **Download** / **Delete** (danger) / progress while downloading.
- **Microphone test** (`MicrophoneSettings.tsx`): a live input-level meter (emerald gradient bar + mono %) + **Run microphone test** button that animates the level for ~3s.
- **Validation**: **Run STT benchmark** (→ `/benchmark`) + **Open diagnostics** (→ `/diagnostics`).
- A `Resource usage` warning alert at the bottom.

### 4. Test Lab — `pages/TestLabPage.tsx` (+ `components/test-lab/*`, `src/test-lab/voice-test-*`)
"Serious QA tool, not a debug dump." Full pipeline: audio → STT → correction → LLM → answer → scoring. Header actions: **Export CSV · Export JSON** (`lib/interviewSessionExport.ts`) · **Run all tests** (primary). A **summary stat row**: total cases · ● Passed · ● Warnings · ● Failed · Avg total latency (mono). Then a **table** (a `.sc-card` with a header row + body rows on a shared CSS grid — see prototype columns `Status · Test case · Transcript · Answer · STT · LLM · Total · chevron`):
- Status = colored badge (`Pass` green / `Warning` amber / `Failed` red). Case = mono id (`TL-01`) over the question (ellipsis). Scores are mono, **color-coded by value** (≥90 green, ≥80 amber, else red). Latencies mono.
- **Row click → expandable detail drawer** (animated, `bg-accent-soft`): raw transcript (mono, faint) vs corrected transcript (indigo-tinted), the generated answer, fired correction rules (chips), and a **Failure reason** warning alert when present. Mirrors `voice-test-types.ts` / `voice-test-scoring.ts` / `voice-test-report.ts`.

### 5. STT Benchmark — NEW route (`/benchmark`), built on `tests/stt-benchmark/` + `SttDebugPanel.tsx`
**Speech-recognition only** (audio → STT → transcript). Must read as conceptually separate from Test Lab — so it's **card-based, not a table**, and carries a `[sky dot] Speech-to-text only` badge. Header: **Export JSON · Run benchmark**. A **metric strip** of 5 tiles: Keyword match · Correction gain · Rules fired · False neg. · False pos. Then one **card per case** (`.sc-card`, click to expand):
- top: model badge · mono id · `Clean` / `False negative` status badge · mono STT latency · chevron.
- a prominent **raw → corrected diff** block: `RAW STT` (mono, faint) on the left, an indigo arrow, `CORRECTED` (`bg-accent-soft`) on the right.
- metrics row: `Keyword 100%` (color-coded) · `Intent Match` · `Correction gain 62% → 100% +38 pp` with a tiny progress bar.
- expanded: expected meaning · fired correction rules (chips) · false-negatives / false-positives counts · an `Error type` warning alert when present.

### 6. Diagnostics — NEW route (`/diagnostics`), built on `components/DiagnosticsPanel.tsx`
Header: an `● Operational` live pill + **Refresh**. Cards:
- **Answer latency waterfall** (the centerpiece): a single horizontal stacked bar split into the pipeline stages (Audio capture → STT first partial → STT final → LLM first token → LLM complete), each a token color, total mono on the right; below it a 5-column legend with stage name + duration (mono) + cumulative `@` time.
- **Telemetry** (two `.sc-card`s of `.sc-diag-row` label/value rows): STT (provider, model, average STT latency, time to first partial, speech-end → final) and LLM (model, first-token latency, total answer latency, tokens/answer, streaming). Values that are healthy use `--ok` green.
- **Audio & privacy** (mic, system audio, privacy = Local, overlay) and **Last errors** (last STT error, last LLM error, uptime).
- **Recent skipped transcripts**: a list of `time(mono) · ⚠ reason · detail(mono)` rows (honest failure surfacing).

### 7. History — `pages/HistoryPage.tsx`
Header: a **search field** (filters question + answer live) + a **source segmented filter** `All · Live · Manual · Test`. Body: a stack of `.sc-card` rows, each = a source badge (Live=emerald, Manual=indigo, Test=sky) + mono timestamp, the question (15px `font-semibold`), the answer (13.5px `text-ink-muted`), and right-aligned **Copy** + **Delete** icon buttons. Empty state (`.sc-empty`) when filters match nothing.

### 8. Documents / Resume context — `pages/DocumentsPage.tsx`
Header: **Add file**. An **Active context** card (indigo-tinted, soft glow) — `N files in use` + "Answers are tailored to:" + derived tag chips (`Senior QA Automation`, `Python · pytest`, `CI/CD`…). A **Context files** list: each file = a kind-colored icon tile (resume=indigo, vacancy=emerald, notes=sky) + name (ellipsis) + UPPERCASE kind label + mono `size · date` + `Active/Inactive` label + a **Switch** (`components/core/Switch`) to toggle whether it feeds answers. A **Context notes** textarea (role focus / seniority / emphasis). A **privacy** info alert ("stored locally … never uploaded in local mode").

---

## Interactions & behavior
- **Live pipeline** drives status pill, status flow, waveform, latency badges, timeline node state and the response card. The previous answer stays visible while the next question is being transcribed; the response card only updates when answering begins.
- **Streaming**: interim transcript and answer prose both reveal word-by-word with a blinking caret.
- **Correction flash**: when a glossary rule fires, the correction chip plays a one-shot highlight (`sc-flash`, ~1.2s).
- **Tabs**: switching answer mode swaps text instantly (no re-stream).
- **Table/card expand** (Test Lab, STT Benchmark): one row open at a time; chevron rotates 90°; drawer animates in (transform-only).
- **Copy** → label flips to "Copied ✓" for ~1.6s. **Regenerate** re-streams the answer.
- **Onboarding/Settings download** → progress bar 0→100%, then status flips to Ready; **Delete** clears it.
- **Mic test** → animated level meter for ~3s.
- **History search/filter** → live filter; **Delete** removes the row.
- **Focus mode** → full-screen overlay, `Esc` to exit.
- **Hover**: surfaces lighten + border strengthens; nav fills `accent-soft` + indigo icon; primary CTA brightens + blooms. **Press**: `translateY(.5px) scale(.985)`. **Focus**: 2px indigo ring.

## Motion (all respect `prefers-reduced-motion`)
- `fade-in` 0.15s; `scale-in` 0.18s `cubic-bezier(.16,1,.3,1)` for a newly-arrived answer (already in `tailwind.config.js`).
- **Add** these keyframes (see `assets/ds/tokens/motion.css` + `workspace.css`): `sc-wave` (waveform bars), `sc-ping` (breathing status dot — only while listening/processing), `sc-blink` (caret), `sc-flash` (correction landing), `sc-glow-pulse` / rotating conic border on the active response card, transform-only `sc-node-in` / `sc-stream-in` entrances.
- **Do NOT** put one-shot entrance animations (opacity 0→1) on a container that re-renders every streamed word — it restarts every frame and the element stays invisible. Keep entrance animations on stable, non-streaming nodes only; use transform-only or infinite animations elsewhere.

## State management
Most already exists. Reuse `context/AppContext.tsx` and the hooks. New UI state to add: current **answer tab**, **Focus mode** boolean, table/card **expanded-row** id (Test Lab, Benchmark), **History** search query + source filter, **Documents** per-file active toggles, and routing for the two **new routes** (`/benchmark`, `/diagnostics`). Data shapes for the demo content (cases, benchmark rows, latency stages, history items, models) are in the prototype's logic-class arrays — match them to the real services (`interviewPipeline`, `voice-test-*`, `sttProviders`, `aiModels`, `DiagnosticsPanel`).

## Content rules (don't break these)
- **Bilingual**: UI chrome + questions in Russian, technical terms in **English verbatim** (`CI/CD`, `pytest fixtures`, `Page Object Model`, `GitLab CI`). Mixed RU/EN in one sentence is correct — don't translate terms.
- Voice: second person, calm, direct. Imperative button verbs. Sentence case. **No emoji** in product surfaces.
- Numbers: latency in **mono** with units (`0.82s`); model sizes always approximate with a tilde (`~480 MB`).
- Honest states: surface real failures ("Transcript score below threshold", "false negative — glossary did not fire", "Skipped: audio below speech threshold").

## Assets
- **Icons:** Lucide line icons, `stroke-width 1.75`, round caps, `currentColor`, ~17px in nav / 13–15px inline. The codebase already hand-rolls these inline (see `Sidebar.tsx`); keep that pattern. No emoji-as-icon.
- **Fonts:** Inter (already configured) + **JetBrains Mono** (add — webfont `@import` in `assets/ds/tokens/fonts.css`).
- No photography/illustration. The only "art" is the cockpit grid/glow (live route only) and the `SC` monogram.

## Files in this bundle
- `Skillcue.dc.html` — the interactive prototype (open in a browser; read markup for exact structure/copy).
- `screenshots/` — hi-fi reference captures of all nine screens (`1-live-interview` … `9-onboarding`). The live route is shown mid-pipeline ("Transcribing"). Captures are ~924px wide; the prototype targets a ~1440px desktop window, so on a real screen rows/columns breathe more than the PNGs suggest.
- `assets/ds/styles.css` + `assets/ds/tokens/*.css` — exact token + component-class values (already mirrored in `tailwind.config.js` / global CSS).
- `README.md` — this document (self-sufficient).
