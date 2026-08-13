import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const main = fs.readFileSync(path.resolve(__dirname, '../../electron/main.ts'), 'utf8');
const titleBarTheme = fs.readFileSync(
  path.resolve(__dirname, '../../electron/titleBarTheme.ts'),
  'utf8',
);
const indexCss = fs.readFileSync(path.resolve(__dirname, '../index.css'), 'utf8');
const prepareCss = fs.readFileSync(path.resolve(__dirname, 'prepare.css'), 'utf8');
const cockpitCss = fs.readFileSync(path.resolve(__dirname, 'interview-cockpit.css'), 'utf8');
const overlayCss = fs.readFileSync(path.resolve(__dirname, 'overlay-cockpit.css'), 'utf8');
const sidebar = fs.readFileSync(path.resolve(__dirname, '../components/Sidebar.tsx'), 'utf8');
const layout = fs.readFileSync(path.resolve(__dirname, '../components/Layout.tsx'), 'utf8');
const home = fs.readFileSync(path.resolve(__dirname, '../pages/HomePage.tsx'), 'utf8');
const modal = fs.readFileSync(path.resolve(__dirname, '../components/Modal.tsx'), 'utf8');
const palette = fs.readFileSync(path.resolve(__dirname, '../components/CommandPalette.tsx'), 'utf8');
const tokens = fs.readFileSync(path.resolve(__dirname, 'tokens.css'), 'utf8');
const calendar = fs.readFileSync(path.resolve(__dirname, '../pages/InterviewCalendarPage.tsx'), 'utf8');
const ru = fs.readFileSync(path.resolve(__dirname, '../lib/i18n/ru.ts'), 'utf8');

describe('desktop polish contracts', () => {
  it('keeps native and CSS title bars at 44px so title-bar hover stays bounded', () => {
    expect(main).toContain("getTitleBarOverlayTheme('dark')");
    expect(titleBarTheme).toContain('height: 44');
    expect(indexCss).toContain('@apply flex h-11');
  });

  it('uses neutral indigo focus for ordinary form controls', () => {
    expect(indexCss).toContain('.field:focus-visible,');
    expect(indexCss).toContain('.select-compact:focus-visible');
    expect(indexCss).toContain('border-color: rgba(99, 102, 241, 0.62)');
    expect(indexCss).not.toContain('focus:border-accent focus:ring-2 focus:ring-accent-ring');
    expect(prepareCss).not.toContain('border-color: rgba(52, 199, 123, 0.55)');
    expect(cockpitCss).not.toContain('focus-within:border-accent/50');
  });

  it('keeps quick controls dev-only while stable stays focused on navigation', () => {
    expect(sidebar).not.toContain("t('sidebar.ready')");
    expect(sidebar).toContain("t('sidebar.unavailable')");
    expect(sidebar).not.toContain("t('sidebar.quickActions')");
    expect(sidebar).not.toContain('skillcue:open-palette');
    expect(sidebar).toContain('useBuildChannel');
    expect(sidebar).toContain('{isDeveloperBuild && (');
    expect(sidebar).toContain('setContentProtection');
    expect(sidebar).toContain('setSkipTaskbar');
    expect(sidebar).toContain('skillcue-sidebar__utility-row');
    expect(sidebar).toContain('aria-label={t(\'nav.settings\')}');
  });

  it('uses one edge control and Ctrl+Backslash to collapse the sidebar', () => {
    expect(sidebar).toContain('skillcue-sidebar__collapse');
    expect(sidebar).toContain('aria-keyshortcuts="Control+Backslash"');
    expect(sidebar).toContain("event.key !== '\\\\'");
    expect(sidebar).toContain('<ChevronLeft size={15} />');
    expect(sidebar).toContain('<ChevronRight size={15} />');
    expect(indexCss).toContain('right-[-13px]');
    expect(indexCss).toContain('cubic-bezier(0.2, 0.8, 0.2, 1)');
  });

  it('keeps the overlay input stable and neutral while it is focused', () => {
    expect(overlayCss).not.toContain('.ovl-input-wrap:focus-within');
    expect(overlayCss).not.toContain('.ovl-input:focus {');
    expect(overlayCss).not.toContain('transition: height');
    expect(overlayCss).toContain('.ovl-input:focus-visible');
    expect(overlayCss).toContain('outline: none');
  });

  it('uses the calm three-zone radar layout in both desktop themes', () => {
    expect(prepareCss).toContain('.home-radar-grid');
    expect(prepareCss).toContain(
      'grid-template-columns: minmax(0, 1.24fr) minmax(320px, 0.76fr)',
    );
    expect(prepareCss).toContain('.home-radar-primary');
    expect(home).toContain('home-radar-applications');
    expect(home).toContain('home-radar-attention');
    expect(prepareCss).toContain(":root[data-theme='light'] .home-radar-primary");
    expect(prepareCss).toContain(":root[data-theme='light'] .home-radar-panel");
    expect(home).toContain('home-radar-score');
    expect(home).toContain('home-radar-flow');
    expect(home).toContain('applicationFlow.reached[index]');
    expect(prepareCss).toContain('.home-radar-flow__step:not(:last-child)::after');
    expect(prepareCss).toContain('inset-inline-start: calc(50% + 28px)');
    expect(prepareCss).toContain('inset-inline-end: calc(-50% + 28px)');
    expect(prepareCss).not.toContain('.home-radar-flow__rail');
    expect(prepareCss).not.toContain('.home-radar-primary::after');
    expect(prepareCss).toContain('@container home-primary (max-width: 720px)');
    expect(prepareCss).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(home).toContain('Ваш следующий шаг');
    expect(home).not.toContain('Следующий шаг без догадок');
    expect(home).not.toContain('СЛЕДУЮЩИЙ ЛОГИЧЕСКИЙ ШАГ');
    expect(home).not.toContain('className="prep-eyebrow">СЕГОДНЯ');
  });

  it('makes home a live next-action view instead of a static preparation prompt', () => {
    expect(home).toContain('window.electronAPI?.hhAssistant');
    expect(home).toContain('window.electronAPI?.hhChat');
    expect(home).toContain('window.electronAPI?.interviewCalendar');
    expect(home).toContain('С чего начать?');
    expect(home).toContain('Добавить вакансию');
    expect(home).toContain('Добавить резюме');
    expect(home).toContain('Начать практику');
    expect(home).toContain('Без конкретной вакансии');
    expect(home).toContain('candidateJourney.action.label');
    expect(home).toContain('<CandidateJourneyStrip');
    expect(home).toContain('отправлено сегодня');
    expect(home).toContain('Ближайших собеседований нет');
    expect(home).toContain('Нужно от вас');
    expect(home).toContain('visibleAttentionItems.length > 0');
    expect(home).toContain('home-radar-automatic-status');
    expect(home).toContain('formatHomeInterviewBadge');
  });

  it('turns interview readiness into an actionable checklist instead of a blind redirect', () => {
    expect(home).toContain('onClick: () => setReadinessOpen(true)');
    expect(home).toContain('Это проверка техники и контекста, а не оценка ваших знаний.');
    expect(home).toContain('Техническая готовность SkillCue');
    expect(home).toContain("title: 'Микрофон'");
    expect(home).toContain("title: 'Онлайн-ИИ и распознавание'");
    expect(home).toContain("title: 'Данные собеседования'");
    expect(home).toContain("title: 'Скрытие оверлея'");
    expect(home).toContain('/calendar?edit=');
    expect(prepareCss).toContain('.home-readiness-step');
  });

  it('uses accessible modal and command-palette semantics', () => {
    for (const source of [modal, palette]) {
      expect(source).toContain('createPortal');
      expect(source).toContain('aria-modal="true"');
      expect(source).toContain('appRoot.inert = true');
    }
    expect(modal).toContain("if (e.key !== 'Tab') return");
    expect(palette).toContain('role="combobox"');
    expect(palette).toContain('role="listbox"');
    expect(palette).toContain('role="option"');
    expect(palette).toContain('aria-activedescendant');
  });

  it('keeps secondary text legible and honours reduced motion globally', () => {
    expect(tokens).toContain('--twc-ink-faint: 135 153 175');
    expect(tokens).toContain('--twc-ink-faint: 89 111 134');
    expect(indexCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(indexCss).toContain('animation-duration: 0.01ms !important');
    expect(indexCss).toContain('scroll-behavior: auto !important');
  });

  it('exposes the weekly calendar as one roving keyboard grid', () => {
    expect(calendar).toContain('role="grid"');
    expect(calendar).toContain('role="gridcell"');
    expect(calendar).toContain('tabIndex={focusedSlot.dayIndex === dayIndex');
    expect(calendar).toContain('moveCalendarGridFocus');
    expect(calendar).not.toContain('text-xs capitalize text-ink-faint">{new Intl.DateTimeFormat');
  });

  it('keeps the first preparation navigation item clear of the title bar edge', () => {
    expect(sidebar).toContain('overflow-y-auto px-2.5 py-2');
  });

  it('keeps inactive live interview navigation neutral and action badges calm', () => {
    const liveRule = indexCss.slice(
      indexCss.indexOf('.skillcue-live-launch {'),
      indexCss.indexOf('.skillcue-live-launch.is-live'),
    );
    expect(liveRule).toContain('border-surface-border bg-transparent');
    expect(liveRule).not.toContain('bg-emerald-400/10');
    expect(liveRule).toContain('border-surface-border-strong bg-surface-elevated text-ink');
    expect(liveRule).toContain('transform: scale(0.96)');
    expect(ru).toContain("'sidebar.openLiveOverlay': 'Открыть помощника'");
    expect(indexCss).toContain('background: rgb(14 165 233 / 0.14)');
    expect(indexCss).toContain(":root[data-theme='light'] .hh-view-switcher > button > span");
    expect(indexCss).toContain(":root[data-theme='light'] .text-violet-100");
    expect(indexCss).toContain(":root[data-theme='light'] .text-emerald-200");
  });

  it('opens every route at its beginning instead of inheriting another page scroll', () => {
    expect(layout).toContain('const contentRef = useRef<HTMLDivElement>(null)');
    expect(layout).toContain("contentRef.current?.scrollTo({ top: 0, left: 0 })");
    expect(layout).toContain('}, [pathname, routeKey, t])');
    expect(layout).toContain('key={pathname}');
    expect(layout).toContain('ref={contentRef}');
    expect(layout).toContain('mainRef.current?.focus({ preventScroll: true })');
  });
});
