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
const vitrineCss = fs.readFileSync(path.resolve(__dirname, 'desktop-vitrine.css'), 'utf8');
const cockpitCss = fs.readFileSync(path.resolve(__dirname, 'interview-cockpit.css'), 'utf8');
const overlayCss = fs.readFileSync(path.resolve(__dirname, 'overlay-cockpit.css'), 'utf8');
const sidebar = fs.readFileSync(path.resolve(__dirname, '../components/Sidebar.tsx'), 'utf8');
const layout = fs.readFileSync(path.resolve(__dirname, '../components/Layout.tsx'), 'utf8');
const home = fs.readFileSync(path.resolve(__dirname, '../pages/HomePage.tsx'), 'utf8');
const modal = fs.readFileSync(path.resolve(__dirname, '../components/Modal.tsx'), 'utf8');
const palette = fs.readFileSync(path.resolve(__dirname, '../components/CommandPalette.tsx'), 'utf8');
const tokens = fs.readFileSync(path.resolve(__dirname, 'tokens.css'), 'utf8');
const workspaceCss = fs.readFileSync(path.resolve(__dirname, 'workspace.css'), 'utf8');
const calendar = fs.readFileSync(path.resolve(__dirname, '../pages/InterviewCalendarPage.tsx'), 'utf8');
const ru = fs.readFileSync(path.resolve(__dirname, '../lib/i18n/ru.ts'), 'utf8');
const markdownText = fs.readFileSync(path.resolve(__dirname, '../components/MarkdownText.tsx'), 'utf8');

describe('desktop polish contracts', () => {
  it('keeps native and CSS title bars at 44px so title-bar hover stays bounded', () => {
    expect(main).toContain("getTitleBarOverlayTheme('dark')");
    expect(titleBarTheme).toContain('height: 44');
    expect(indexCss).toContain('@apply flex h-11');
  });

  it('uses neutral indigo focus for ordinary form controls', () => {
    expect(indexCss).toContain('.field:focus-visible,');
    expect(indexCss).toContain('.select-compact:focus-visible');
    // Фокус завязан на бренд-токены: смена палитры не ломает контракт.
    expect(indexCss).toContain('border-color: var(--accent-border)');
    expect(indexCss).toContain('box-shadow: 0 0 0 3px var(--sc-brand-ring)');
    expect(indexCss).not.toContain('focus:border-accent focus:ring-2 focus:ring-accent-ring');
    expect(prepareCss).not.toContain('border-color: rgba(52, 199, 123, 0.55)');
    expect(cockpitCss).not.toContain('focus-within:border-accent/50');
  });

  it('keeps stealth and theme shortcuts in the sidebar utility row', () => {
    expect(sidebar).not.toContain("t('sidebar.ready')");
    expect(sidebar).toContain("t('sidebar.unavailable')");
    expect(sidebar).not.toContain("t('sidebar.quickActions')");
    expect(sidebar).not.toContain('skillcue:open-palette');
    expect(sidebar).not.toContain('{isDeveloperBuild && (');
    expect(sidebar).toContain('setContentProtection');
    expect(sidebar).toContain('setContentProtection');
    expect(sidebar).toContain('nextSidebarTheme(theme)');
    expect(sidebar).toContain('Переключить тему');
    expect(sidebar).toContain('skillcue-sidebar__utility-row');
    expect(sidebar).toContain('aria-label={t(\'nav.settings\')}');
  });

  it('uses one edge control and Ctrl+Backslash to collapse the sidebar', () => {
    expect(sidebar).toContain('skillcue-sidebar__collapse');
    expect(sidebar).toContain('aria-keyshortcuts="Control+Backslash"');
    expect(sidebar).toContain("event.key !== '\\\\'");
    expect(sidebar).toContain('<ChevronLeft size={15} />');
    expect(sidebar).toContain('<ChevronRight size={15} />');
    expect(indexCss).toContain('right-[-22px]');
    expect(indexCss).toContain('cubic-bezier(0.2, 0.8, 0.2, 1)');
  });

  it('keeps the overlay input stable and gives it a visible brand focus ring', () => {
    expect(overlayCss).not.toContain('.ovl-input-wrap:focus-within');
    expect(overlayCss).not.toContain('.ovl-input:focus {');
    expect(overlayCss).not.toContain('transition: height');
    expect(overlayCss).toContain('.ovl-input:focus-visible');
    expect(overlayCss).toContain('outline: 2px solid var(--sc-brand, #34c77b)');
  });

  it('fits code inside the fixed overlay width without horizontal scrolling', () => {
    expect(markdownText).toContain('formatCodeForCompactDisplay(language, code)');
    expect(markdownText).toContain('overflow-x-hidden');
    expect(markdownText).toContain('whitespace-pre-wrap');
    expect(markdownText).toContain('[overflow-wrap:anywhere]');
    expect(markdownText).not.toContain('<pre className="overflow-x-auto');
  });

  it('uses a calm HH command center without the decorative journey rail', () => {
    expect(prepareCss).toContain('.home-command-center');
    expect(vitrineCss).toContain(
      'grid-template-columns: minmax(0, 1fr) minmax(250px, 0.46fr)',
    );
    expect(home).toContain('home-command-hero');
    expect(home).toContain('home-command-attention');
    expect(vitrineCss).toContain('.home-application-illustration');
    expect(vitrineCss).not.toContain('.home-command-quick-actions');
    expect(home).not.toContain('<CandidateJourneyStrip');
    expect(home).not.toContain('home-radar-flow');
    expect(home).not.toContain('applicationFlow.reached[index]');
    expect(home).toContain('home-command-stats');
    expect(vitrineCss).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(home).toContain('Главная SkillCue');
    expect(home).not.toContain('Следующий шаг без догадок');
    expect(home).not.toContain('СЛЕДУЮЩИЙ ЛОГИЧЕСКИЙ ШАГ');
    expect(home).not.toContain('className="prep-eyebrow">СЕГОДНЯ');
  });

  it('makes home a live next-action view instead of a static preparation prompt', () => {
    expect(home).toContain('window.electronAPI?.hhAssistant');
    expect(home).toContain('window.electronAPI?.hhChat');
    expect(home).toContain('window.electronAPI?.interviewCalendar');
    expect(home).toContain('С чего начать?');
    expect(home).toContain('Добавить резюме');
    expect(home).toContain('Подключить HH');
    expect(home).toContain('Запустить оверлей');
    expect(home).not.toContain('Проверить оверлей');
    expect(home).toContain('hhCommand.actionLabel');
    expect(home).toContain('getHomeHhCommand');
    expect(home).toContain('откликов отправлено');
    expect(home).toContain('Ближайших собеседований нет');
    expect(home).toContain('Нужно от вас');
    expect(home).toContain('visibleAttentionItems.length > 0');
    expect(home).toContain('home-command-clear');
    expect(home).toContain('formatHomeInterviewBadge');
    expect(home).toContain('prep h-full overflow-hidden');
    expect(home).toContain('Открыть помощника');
    expect(home).not.toContain('home-command-quick-actions');
    const homeWrapRule = vitrineCss.slice(
      vitrineCss.indexOf('.prep-wrap.home-radar {'),
      vitrineCss.indexOf('.home-dashboard-heading'),
    );
    expect(homeWrapRule).toContain('height: 100%');
    expect(homeWrapRule).toContain('overflow: hidden');
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
    expect(tokens).toContain('--twc-ink-faint: 91 107 132');
    expect(indexCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(indexCss).toContain('animation-duration: 0.01ms !important');
    expect(indexCss).toContain('scroll-behavior: auto !important');
  });

  it('keeps compact light-theme accent text readable on pale and white surfaces', () => {
    expect(tokens).toContain('--sc-brand: #057a44');
    expect(tokens).toContain('--twc-accent: 5 122 68');
    expect(workspaceCss).toContain('--accent: #057a44');
    expect(workspaceCss).toContain('--accent-text: #057a44');
    expect(workspaceCss).toContain('--text-faint: #5b6b84');
    expect(workspaceCss).toContain('--graphite-600: #5b6b84');
    expect(vitrineCss).toContain('--prep-ink-faint: #5b6b84');
    expect(vitrineCss).toContain('--prep-green: #057a44');
  });

  it('keeps text visible on every bright green primary action', () => {
    const sidebarActionRule = indexCss.slice(
      indexCss.indexOf('.skillcue-sidebar__assistant-action {'),
      indexCss.indexOf('.skillcue-sidebar--collapsed .skillcue-sidebar__assistant-card'),
    );
    const homeActionRule = vitrineCss.slice(
      vitrineCss.indexOf('.home-command-cta,'),
      vitrineCss.indexOf('.home-command-cta:hover,'),
    );
    const lightPrimaryRule = vitrineCss.slice(
      vitrineCss.indexOf(":root[data-theme='light'] .btn-primary,"),
      vitrineCss.indexOf(":root[data-theme='light'] .field,"),
    );

    expect(sidebarActionRule).toContain('color: #04240f');
    expect(sidebarActionRule).not.toContain('color: white');
    expect(homeActionRule).toContain('color: #04240f');
    expect(homeActionRule).not.toContain('color: white');
    expect(lightPrimaryRule).toContain('color: #04240f');
    expect(lightPrimaryRule).not.toContain('color: #ffffff');
  });

  it('does not leak the primary green hover glow into secondary or disabled preparation buttons', () => {
    expect(prepareCss).toContain(
      '.prep-btn:not(.prep-btn-secondary):not(.prep-btn-ghost):hover:not(:disabled)',
    );
    expect(prepareCss).not.toMatch(/\.prep-btn:hover\s*\{/);
  });

  it('exposes the weekly calendar as one roving keyboard grid', () => {
    expect(calendar).toContain('role="grid"');
    expect(calendar).toContain('role="gridcell"');
    expect(calendar).toContain('tabIndex={focusedSlot.dayIndex === dayIndex');
    expect(calendar).toContain('moveCalendarGridFocus');
    expect(calendar).not.toContain('text-xs capitalize text-ink-faint">{new Intl.DateTimeFormat');
  });

  it('keeps the first preparation navigation item clear of the title bar edge', () => {
    expect(sidebar).toContain('skillcue-sidebar__nav flex-1 overflow-y-auto');
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
