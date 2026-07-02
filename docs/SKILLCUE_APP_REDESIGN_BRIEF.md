# SkillCue App Redesign Brief

## Assumptions

- Текущий визуальный ориентир: лендинг `landing/index.html` после итерации v8: dark live-mode, green action, warm light preparation surfaces.
- Текущий desktop app уже имеет несколько разрозненных визуальных слоёв:
  - `apps/desktop/src/styles/workspace.css` — dark workspace / cockpit tokens.
  - `apps/desktop/src/styles/prepare.css` — warm light preparation mode.
  - `apps/desktop/src/styles/interview-cockpit.css` — live cockpit layer.
  - `apps/desktop/src/styles/overlay-cockpit.css` — overlay layer.
- Я не видел новых реальных desktop screenshots в этом запросе, поэтому диагноз основан на текущем коде, предыдущем контексте и актуальном лендинге.
- Цель этой итерации — redesign system + Figma/implementation brief, а не рискованная правка live audio/STT/LLM flow.

---

## 1. Короткий диагноз текущего дизайна

SkillCue уже перестал быть просто “AI wrapper”: в продукте есть сильный сценарий `vacancy -> readiness -> practice -> live cue`. Но сам desktop app пока ощущается как набор отдельных режимов, а не как единый зрелый продукт.

Что работает:

- Есть правильная продуктовая логика: Home, Prepare, Vacancy Review, Smoke Interview, Readiness Report, Live Interview, Overlay, History, Settings.
- Preparation mode уже идёт в тёплую светлую сторону через `prepare.css`.
- Live Interview уже отделён от подготовки через dark cockpit.
- Overlay уже answer-first и поддерживает transcript toggle, source picker, shortcuts.
- В коде есть полезные состояния: readiness strip, live status, answer history, diagnostics, manual question, export/debug.

Что выглядит слабее:

- Дизайн-система раздроблена: `prepare`, `cockpit`, `overlay`, `workspace` выглядят как отдельные продукты.
- Live screen всё ещё местами dashboard-heavy: много controls, metrics, debug/status рядом с главным ответом.
- Overlay использует часть cockpit-стилей, но не ощущается как главный hero-object продукта.
- Home недостаточно продаёт следующий шаг. Сейчас это скорее “страница статуса”, а должна быть preparation hub.
- Readiness map есть, но её visual hierarchy можно сделать сильнее: пользователь должен сразу видеть “что повторить”.
- Settings и Diagnostics должны быть практичными, но визуально и информационно уходить в advanced layer.
- CTA и microcopy частично английские/технические: `Start smoke review`, `Live session`, `System audio`, `Overlay`. Для продукта можно оставить термины, но главный смысл должен быть на человеческом языке.

Главный диагноз:

> SkillCue нужен не новый стиль ради стиля, а единая product system: тёплая подготовка, строгий live-mode, компактный overlay, один главный следующий шаг на каждом экране.

---

## 2. Новый дизайн-принцип SkillCue

1. **Answer-first, dashboard-never.**  
   В live-сценарии главный объект — ответ, который можно сказать вслух. Метрики, debug, transcript и controls вторичны.

2. **Warm prep, dark live.**  
   Подготовка должна снижать тревогу: светлее, теплее, структурнее. Live должен быть тёмным, компактным, читаемым под стрессом.

3. **One next action per screen.**  
   Home предлагает один главный следующий шаг. Vacancy Analysis ведёт в practice. Readiness ведёт в слабую тему или live. Live ведёт к start/stop и cue.

4. **Readiness is the product, not decoration.**  
   Проценты и progress bars должны отвечать на вопрос: “что повторить прямо сейчас?”

5. **Private by posture, not by suspicious wording.**  
   Не писать “stealth”, “hidden”, “undetected” в основном UX. Использовать “private workspace”, “compact overlay”, “local speech model”, “you control what is shown”.

6. **Live mode must read in 1 glance.**  
   Recognized question: small. Answer cue: large. Context: chips. Everything else hidden, collapsed or available by hotkey.

7. **No generic AI theatre.**  
   Не использовать “magic”, bokeh/orbs, random gradients, huge AI labels. Визуальный язык должен быть про интервью, вопросы, опыт, готовность.

---

## 3. Продуктовая архитектура

| Section | Purpose | 3-second understanding | Primary CTA | Secondary actions | Remove / hide |
|---|---|---|---|---|---|
| Home / Preparation Hub | Показать текущую цель и следующий шаг | “Вот моя вакансия, готовность и что делать дальше” | Continue preparation / Analyze vacancy | Start live, view report, practice weak topic | Long recent lists, raw analytics |
| Vacancy Analysis | Разобрать требования роли | “Вот что спросят и где риски” | Start practice | Edit vacancy, add resume/legend | Tables without prioritization |
| Resume / Legend | Управлять фактами опыта | “Что можно говорить уверенно, что нельзя выдумывать” | Add missing proof / Update legend | Mark safe/careful/avoid | Full CV editor feel |
| Readiness Map | Показать готовность по темам | “Эти темы сильные, эти нужно повторить” | Practice weak topic | Start live with context, save report | Vanity charts |
| Practice Mode | Тренировать ответы | “Вопрос, мой ответ, что улучшить” | Answer / Next question | Shorter, more confident, more honest | Big dashboards |
| Live Interview | Реальный stress-case | “Слушает, понял вопрос, дал cue” | Start / Stop Live | Overlay, transcript, manual correction | Debug by default |
| Overlay | Compact answer surface | “Вопрос + короткая подсказка” | Move / collapse / copy | Transcript toggle, quick actions | Latency, debug, large chrome |
| History / Review | После сессии | “Что спросили, что ответил, что повторить” | Practice missed topics | Save cue, add to legend, export | Raw logs as main content |
| Settings | Практичная настройка | “Audio, language, answer style, overlay” | Save / Test audio | Advanced diagnostics | All settings in one long page |
| Billing / Plan | Package value | “Что доступно в моём плане” | Upgrade / Manage plan | View usage | Enterprise-style admin UI |

---

## 4. Redesign ключевых экранов

### A. Home / Preparation Hub

Goal: домашний экран не должен быть dashboard. Это “центр подготовки к ближайшему интервью”.

Layout:

- Left/main column: current target role card.
- Right column: readiness + next action.
- Below: weak topics + recent sessions, both compact.

Above the fold:

1. Current goal: role, company, vacancy status, resume/legend status.
2. Readiness score with plain label: `78% · almost ready`.
3. Next best action: `Practice CI/CD answer` or `Analyze a vacancy`.
4. Live readiness mini-strip: LLM, Speech, Audio, Overlay.

Primary CTA:

- Empty: `Разобрать вакансию`.
- In progress: `Продолжить тренировку`.
- Ready: `Начать live с этим контекстом`.

Secondary CTA:

- `Посмотреть карту готовности`.
- `Открыть отчёт`.
- `Обновить резюме / легенду`.

Empty state:

- Title: `Начните с вакансии`.
- Copy: `SkillCue покажет вероятные вопросы, риски по навыкам и план подготовки.`
- CTA: `Вставить вакансию`.

Loaded state:

- Hero card with role:
  - `QA Automation Engineer · Product team`
  - readiness ring
  - 3 weakest topics
  - primary CTA

Remove:

- Long recent session lists above fold.
- Generic greeting.
- Multiple equally strong cards.

### B. Vacancy Analysis

Goal: сделать не таблицу требований, а карту подготовки.

Recommended layout:

1. Summary header:
   - target role
   - extracted seniority / stack / interview focus
   - confidence label
2. `Likely questions` as the main block:
   - grouped by theme
   - each question has probability/risk chip
3. `Covered by resume`:
   - facts found in resume/legend
4. `Gaps / risks`:
   - unsupported claims
   - missing examples
5. CTA footer:
   - `Start practice on these questions`

Best UX:

- Prioritize by “what interviewer will ask”, not by extracted keyword frequency.
- Show max 5 critical questions first.
- Collapse low-priority topics.

### C. Resume / Legend

Goal: not a CV editor, but a grounding console.

Core zones:

- **Safe to use**: facts with proof.
- **Careful**: facts where candidate participated but did not own fully.
- **Avoid**: unsupported claims / risky exaggerations.
- **Stories**: prepared STAR-like short stories.
- **Voice**: answer tone rules.

Primary CTA:

- `Add proof to weak claim`.

Secondary:

- `Add project story`.
- `Mark as safe`.
- `Use in live answers`.

Do not:

- Show a huge resume textarea as the main object after setup.
- Make it feel like LinkedIn profile editor.

### D. Practice Mode

Goal: fast trainer, almost like flashcards with feedback.

Primary information:

- Question.
- User answer / drafted answer.
- Score by criteria.
- One fix to make it better.

Layout:

- Top: current topic + progress.
- Center: question card.
- Main: answer area.
- Side/under: quality criteria:
  - concrete example
  - tools mentioned
  - honest ownership
  - concise enough to say aloud

Actions:

- `Answer`
- `Make shorter`
- `Make more confident`
- `Make more honest`
- `Next question`

Microcopy:

- Weak answer: `Нужен пример из проекта, иначе звучит как теория.`
- Missing ownership: `Уточните, что делали сами, а где поддерживали готовую систему.`

### E. Live Interview

Goal: stress-safe screen. User cannot parse dashboard during interview.

Always visible:

1. Live status: `Listening`, `Question detected`, `Answer ready`.
2. Recognized question.
3. Answer cue.
4. Context chips: vacancy, resume, topic readiness.
5. Start/Stop + Overlay.

Collapsible:

- Transcript.
- Recent questions.
- Audio sources.
- Manual correction.

Hidden / advanced:

- STT timing breakdown.
- LLM latency.
- Debug download.
- Raw transcript events.
- Model settings.

Recommended layout:

- Top compact bar:
  - status
  - audio source
  - overlay
  - stop
- Main area:
  - answer card 70%
  - recent questions 30% or hidden drawer
- Bottom:
  - manual question input, collapsed by default or command-K.

Answer card:

- Question line: 14px, muted.
- Answer: 20-24px, high contrast, 3-5 lines.
- Actions: Copy, Shorter, More concrete, Regenerate.

### F. Overlay

Goal: compact answer-first surface.

Default size:

- Normal: 560 x 260 px.
- Expanded: 720 x 420 px.
- Collapsed: 280 x 44 px.

Structure:

1. Thin draggable topbar:
   - small status dot
   - `Listening` / `Answer ready`
   - minimal controls
2. Optional question line:
   - 1-2 lines max
3. Answer cue:
   - 2-4 readable lines
4. Context chips:
   - `Vacancy`
   - `Resume`
   - `API 78%`

States:

- Idle: `Ready for interview audio`
- Listening: waveform + `Listening`
- Processing: `Preparing cue...`
- Answer ready: answer card prominent
- Low quality transcript: `Waiting for a clearer question`
- Collapsed: only status + hotkey hint

Hotkeys:

- `Ctrl + Shift + H`: show/hide overlay
- `Ctrl + /`: transcript
- `Ctrl + K`: quick actions
- `Esc`: close popovers / hide overlay
- Arrow drag controls optional in settings

Do not show:

- latency
- raw confidence
- debug labels
- “screen capture protected”
- large settings UI

### G. History / Review

Goal: useful debrief, not logs.

Top summary:

- Questions answered.
- Missed/unclear phrases.
- Weak topics.
- Cues worth saving.

Session rows:

- Question.
- Answer quality.
- Topic.
- Status: strong / needs example / unclear / skipped.

Actions:

- `Practice this topic`
- `Save cue`
- `Add to legend`
- `Export session`

Hidden:

- Raw debug, unless developer tools are enabled.

### H. Settings / Overlay Settings

Split settings into clear groups:

1. Answer style:
   - Say aloud length
   - Short / Detailed / English / Risks
2. Audio:
   - Mic
   - System audio
   - STT model
   - Microphone level test
3. Overlay:
   - size
   - position
   - readability
   - opacity
   - hotkeys
4. Privacy:
   - local speech model
   - data export/delete
   - window visibility controls, worded carefully
5. Advanced:
   - diagnostics
   - latency logs
   - debug export

---

## 5. Визуальная система

### Color tokens

| Token | Hex | Role | Usage |
|---|---:|---|---|
| `bg/app` | `#080B10` | Main app background | Live shell, global dark workspace |
| `bg/prep` | `#F6F3EC` | Warm prep background | Home, vacancy, resume, readiness |
| `bg/surface` | `#101722` | Base dark surface | Live panels |
| `bg/surface-raised` | `#162131` | Raised dark card | Answer card, command panels |
| `bg/surface-muted` | `#202A38` | Muted dark surface | Disabled/secondary controls |
| `bg/paper` | `#FFFCF5` | Light raised surface | Preparation cards |
| `bg/overlay` | `#071018` | Overlay surface | Compact overlay |
| `text/primary` | `#F4F7FB` | Primary text dark mode | Headings, live answers |
| `text/prep-primary` | `#182230` | Primary text prep mode | Light pages |
| `text/secondary` | `#C7D2E2` | Secondary text dark | Supporting labels |
| `text/prep-secondary` | `#536171` | Secondary prep text | Prep descriptions |
| `text-muted` | `#8492A7` | Muted text | Meta, timestamps |
| `border/subtle` | `#223044` | Subtle dark border | Cards, dividers |
| `border/strong` | `#334358` | Active border | Focus/selected |
| `brand/primary` | `#46D37D` | Primary action | CTA, ready state |
| `brand/primary-hover` | `#37C76E` | Primary hover | Buttons |
| `brand/soft` | `#DFF7E8` | Soft brand surface | Prep success chips |
| `status/ready` | `#38C172` | Ready | Good readiness, live ready |
| `status/warning` | `#D8A942` | Warning | Needs review |
| `status/risk` | `#D66B61` | Risk | Unsupported claim, weak topic |
| `status/info` | `#78A9E8` | Info | Neutral guidance |
| `accent/prep` | `#D7B889` | Prep warmth | Readiness paper accents |
| `accent/practice` | `#8AA8FF` | Practice | Practice progress, selected question |
| `accent/live` | `#46D37D` | Live | Listening/answer ready |
| `accent/review` | `#A391FF` | Review | Post-session insights |

Rules:

- Green is action/readiness, not decoration.
- Dark surfaces only for live and overlay.
- Warm light surfaces only for prep/review/readiness.
- Violet/blue are secondary accents, never primary CTA.
- Red/risk appears only for risk, unsupported claims, failed checks.

### Typography

Font mood:

- UI should feel Apple/Cursor-like: crisp, fast, not editorial.
- Use Inter/System for app UI.
- Use tabular mono only for timings, hotkeys, ids, metrics.

Desktop app scale:

| Role | Size | Weight | Usage |
|---|---:|---:|---|
| Page title | 24-28 | 700 | Home/Prepare headers |
| Section title | 16-18 | 650 | Cards, panels |
| Body | 14-15 | 400-500 | Main readable content |
| Live answer | 20-24 | 500-650 | Live cue / focus mode |
| Labels | 11-12 | 700 | Status labels, chips |
| Meta | 11-12 | 500 | Time, source, debug |

Overlay scale:

| Role | Size | Rule |
|---|---:|---|
| Question | 12-13 | 1-2 lines, muted |
| Answer | 17-19 | 2-4 lines, high contrast |
| Status | 11 | chip/dot |
| Hotkey | 10-11 | mono, subtle |

### Spacing

- Base grid: 4px.
- Normal card padding: 16-20px.
- Dense live card padding: 12-16px.
- Overlay padding: 12px outer, 14-16px answer.
- Page shell gap: 16px.
- Prep page max width: 1120px.
- Live mode: full-width, no oversized margins.

---

## 6. Components

### App Shell

Purpose: common product frame.

Style:

- Sidebar quiet, 240px max.
- Content area mode-aware: prep light, live dark.
- Top-level route state visible.

States:

- prep mode
- live mode
- advanced/dev mode

Do not:

- Make sidebar compete with answer panel.

### Sidebar

Use:

- Home
- Prepare
- Live Interview
- History
- Settings
- Developer tools collapsed.

Rules:

- Active item has surface + subtle left mark.
- Live item can show breathing green dot when active.
- Billing/upgrade never visually louder than current task.

### Primary Button

Use:

- one per screen.

Style:

- green fill
- 12px radius
- strong label verb

Examples:

- `Разобрать вакансию`
- `Продолжить тренировку`
- `Начать live`

Do not:

- Use primary for export/debug/settings.

### Secondary Button

Use:

- navigation to related screen.

Examples:

- `Посмотреть отчёт`
- `Открыть overlay`
- `Добавить легенду`

### Ghost Button

Use:

- low-risk utility.

Examples:

- copy
- collapse
- open advanced

### Status Chip

Use:

- short state, not paragraph.

Examples:

- `Ready`
- `Needs review`
- `Listening`
- `Skipped unclear phrase`

### Risk Chip

Use:

- only when user should act.

States:

- warning: needs example
- risk: unsupported claim
- info: resume missing

### Progress Card

Use:

- readiness score and topic progress.

Rule:

- percentage must have “what to do next”.

Bad:

- `78%`

Good:

- `78% · repeat CI/CD and ownership examples`

### Question Card

Use:

- vacancy-derived questions.

Fields:

- question
- topic
- probability/risk
- coverage from resume

### Answer Cue Card

Use:

- live and practice answers.

Structure:

- optional question
- answer
- context chips
- actions

Rules:

- no headings like `Main answer`.
- no long paragraphs.
- no more than 90 words in Say aloud.

### Context Source Chip

Examples:

- `Vacancy`
- `Resume`
- `Legend`
- `API 78%`
- `Missing proof`

### Overlay Card

Use:

- live answer cue only.

Rules:

- compact
- draggable
- readable
- low chrome

### History Row

Fields:

- question
- answer status
- topic
- next action

### Empty State

Rule:

- explain next action, not mood.

Example:

- `Add a vacancy to see likely interview questions.`

### Warning State

Example:

- `This claim is not supported by your resume. Mark it as careful or add proof.`

### Loading State

Use:

- skeleton/progress for analysis.
- live generation: `Preparing cue...`

### Audio Status

Show:

- mic/system
- model ready/warming
- low level warning

Hide:

- raw latency unless advanced.

### Command / Hotkey Hint

Use:

- `Ctrl K`
- `Ctrl /`
- `Esc`

Style:

- mono, subtle, not large badges.

---

## 7. Interaction Design

Motion:

- 120-180ms transitions.
- No decorative animation loops except live listening waveform/dot.
- Respect `prefers-reduced-motion`.

Hover:

- Cards lift max 1-2px or border brightens.
- Buttons: background + tiny translate.

Focus:

- visible ring for keyboard users.
- focus states must work in overlay.

Loading:

- Vacancy analysis: staged progress:
  - reading vacancy
  - extracting topics
  - matching resume
  - preparing questions
- Live answer:
  - `Listening`
  - `Question detected`
  - `Preparing cue`
  - `Answer ready`

Success:

- small confirmation, no fireworks.

Errors:

- specific and actionable:
  - `System audio is off. Turn it on to hear the interviewer.`
  - `Speech model is warming up. Wait a few seconds before starting.`

Keyboard:

- `Ctrl K` command palette.
- `Ctrl Shift H` overlay.
- `Ctrl /` transcript.
- `Esc` close popover/focus.

---

## 8. Information Hierarchy

### Preparation Mode

Primary:

- current role
- readiness
- next action

Secondary:

- weak topics
- recent sessions
- resume/legend status

Tertiary:

- export
- detailed report
- settings

Hidden:

- raw analysis JSON
- debug scoring

### Live Interview

Primary:

- recognized question
- answer cue
- live state

Secondary:

- context chips
- recent questions
- transcript toggle

Tertiary:

- manual correction
- answer actions

Hidden:

- latency
- model settings
- debug download
- STT breakdown

### Overlay

Primary:

- answer cue

Secondary:

- current question
- status dot
- context chips

Hidden:

- transcript
- shortcuts panel
- settings

---

## 9. UX Copy / Microcopy

### Onboarding

- `Начните с вакансии. SkillCue покажет, что могут спросить и где стоит подготовиться.`

### Upload vacancy

- `Вставьте описание роли`
- `Мы выделим требования, вероятные вопросы и темы риска.`

### Upload resume

- `Добавьте резюме`
- `Ответы станут конкретнее и не будут звучать как общий AI-текст.`

### Legend

- `Добавьте короткую историю опыта`
- `Что вы делали сами, какие инструменты использовали, где была поддержка команды.`

### Readiness score

- `78% готовности`
- `Повторите CI/CD и проектные кейсы перед звонком.`

### Detected risks

- `Риск: мало конкретики`
- `Нужен пример из проекта, иначе ответ звучит как теория.`

### Generated answer

- `Короткий ответ`
- `Готово для ответа вслух`

### Live listening

- `Слушаю вопрос`
- `Жду финальную формулировку`

### Recognized question

- `Похоже, спросили:`

### Answer cue

- `Подсказка`
- `Скажите коротко:`

### Unsupported claim warning

- `Нет подтверждения в резюме`
- `Не утверждайте это как личный опыт. Лучше сказать, что понимаете подход и работали с похожим сценарием.`

### Missing experience bridge

- `На коммерческом проекте напрямую не делал, но понимаю подход и могу связать с похожим опытом.`

### Session review

- `Что повторить перед следующим интервью`
- `Сохранить сильную подсказку`
- `Добавить факт в легенду`

### Empty states

- `Пока нет вакансии`
- `Добавьте описание роли, чтобы получить вероятные вопросы.`

### Error states

- `Не слышу системный звук`
- `Включите System audio, чтобы SkillCue слышал интервьюера.`

---

## 10. Было / стало

| Area | Current issue | Redesign direction | Expected improvement |
|---|---|---|---|
| Colors | Разные системы: prep light, cockpit dark, accent indigo/green | Unified warm prep + dark live tokens | Product feels cohesive |
| Layout | Home and live can feel like dashboards | One next action, answer-first hierarchy | Faster comprehension |
| Live mode | Too many controls/metrics near answer | Hide advanced, answer card dominant | Lower stress |
| Overlay | Works but still tool-like | Compact answer surface with clear states | More premium and usable |
| Cards | Similar cards without hierarchy | Primary/secondary card system | Better scanning |
| CTA | Mixed English/Russian and generic labels | Action verbs tied to user outcome | Higher intent |
| Navigation | Sidebar can compete with task | Quiet nav, live state only where relevant | Focus |
| History | Risk of becoming logs | Review-oriented rows and next actions | More useful debrief |
| Settings | Many technical settings together | Grouped by Answer, Audio, Overlay, Privacy, Advanced | Less overload |
| Trust / privacy | Could sound suspicious if worded wrong | Private workspace, local speech, user control | More trust |

---

## 11. Figma Redesign Brief

### Overall style

SkillCue is a private interview copilot with two modes:

- Warm preparation: light, calm, structured.
- Dark live performance: compact, focused, answer-first.

The UI should feel like a premium desktop product: fast, quiet, precise. It should not feel like a SaaS admin dashboard or a generic AI chat wrapper.

### Screen list

1. Home / Preparation Hub
2. Vacancy Analysis
3. Resume / Legend
4. Practice Mode
5. Readiness Map
6. Live Interview
7. Compact Overlay
8. Expanded Overlay
9. History / Review
10. Settings
11. Overlay Settings
12. Advanced Diagnostics

### Layout rules

- App shell has a quiet sidebar and mode-aware content area.
- Preparation screens use warm light surfaces.
- Live and overlay use dark surfaces.
- Each screen has one primary CTA.
- Advanced/debug content is hidden under developer tools.
- Answer card is the largest object in live mode.

### Component list

- App shell
- Sidebar
- Top bar
- Page header
- Primary button
- Secondary button
- Ghost button
- Status chip
- Risk chip
- Progress card
- Readiness ring/bar
- Question card
- Answer cue card
- Context source chip
- Overlay card
- History row
- Empty state
- Warning state
- Loading state
- Audio status
- Command palette
- Hotkey hint

### Token requirements

Use the color table from section 5. Build light and dark semantic aliases:

- `surface/prep`
- `surface/live`
- `surface/overlay`
- `text/prep`
- `text/live`
- `action/primary`
- `status/ready`
- `status/warn`
- `status/risk`

### Forbidden patterns

- Generic AI chat hero inside app.
- Big decorative gradients or orbs.
- Debug metrics in live default view.
- Multiple primary buttons per screen.
- Long answer paragraphs in overlay.
- Labels like `Main answer`, `Key points`, `Short answer`.
- Suspicious wording: `stealth`, `hidden`, `undetected` in main UX.
- Random pastel chips.
- Dashboard grids in live mode.

### Acceptance criteria for Figma

- Home is understandable in 3 seconds.
- Vacancy Analysis clearly shows likely questions and risks.
- Resume / Legend clearly separates safe/careful/avoid facts.
- Practice Mode feels fast and focused.
- Live Interview answer cue is visually dominant.
- Overlay is readable at 390-720px widths.
- Settings are grouped and non-overwhelming.
- Design supports both QA demo and other roles.

---

## 12. Acceptance Criteria

The redesign is good if:

- The app is understandable in 3 seconds.
- Every screen has one obvious next action.
- Live mode does not look like a dashboard.
- Overlay reads at first glance.
- There are no random pastel colors.
- Green is used for action/readiness, not decoration.
- UI feels mature and expensive, but not cold.
- User understands what to do before, during and after interview.
- Privacy/trust are visible without suspicious wording.
- SkillCue does not look like another AI wrapper.
- The system can scale to more roles, not only QA Automation.
- Debug/diagnostics are available but never default.
- Answer cue remains short, speakable and context-aware.

