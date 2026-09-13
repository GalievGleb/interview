const DOWNLOADS = Object.freeze({
  windows: Object.freeze({
    label: 'Скачать для Windows',
    href: '/downloads/SkillCue-Setup.exe',
    icon: 'windows',
  }),
  'mac-arm': Object.freeze({
    label: 'Скачать для Mac',
    href: 'https://github.com/GalievGleb/SkillCue/releases/latest/download/SkillCue-macOS-arm64.dmg',
    icon: 'apple',
  }),
  'mac-intel': Object.freeze({
    label: 'Скачать для Mac',
    href: 'https://github.com/GalievGleb/SkillCue/releases/latest/download/SkillCue-macOS-x64.dmg',
    icon: 'apple',
  }),
  other: Object.freeze({
    label: 'Скачать на компьютер',
    href: '#downloads',
    icon: 'desktop',
  }),
});

const CONCEPTS = new Set(['light', 'dark']);

export function detectDesktopPlatform({ userAgent = '', platform = '' } = {}) {
  const value = `${userAgent} ${platform}`.toLowerCase();

  if (/iphone|ipad|ipod|android|mobile/.test(value)) return 'other';
  if (/windows|win32|win64/.test(value)) return 'windows';
  if (/macintosh|macintel|mac os|macos/.test(value)) {
    return /apple silicon|arm64|aarch64/.test(value) ? 'mac-arm' : 'mac-intel';
  }

  return 'other';
}

export function getDownloadTarget(platform) {
  return DOWNLOADS[platform] ?? DOWNLOADS.other;
}

export function getFloatingDownloadTarget(platform) {
  return getDownloadTarget(platform);
}

export function shouldCompactFloatingActions({ isNarrow, viewportBottom, pricingTop }) {
  const bottom = Number(viewportBottom);
  const top = Number(pricingTop);
  return Boolean(isNarrow) && Number.isFinite(bottom) && Number.isFinite(top) && bottom >= top;
}

export function getFloatingActionsMode({
  isNarrow,
  scrollY,
  viewportHeight,
  heroBottom,
  pricingTop,
}) {
  if (!isNarrow) return 'full';

  const scroll = Math.max(0, Number(scrollY) || 0);
  const height = Math.max(0, Number(viewportHeight) || 0);
  const heroEnd = Math.max(0, Number(heroBottom) || 0);
  const pricingStart = Math.max(0, Number(pricingTop) || 0);
  const heroExit = Math.max(96, heroEnd - height * 0.6);

  if (pricingStart > 0 && scroll + height >= pricingStart) return 'hidden';

  return height < 780 || scroll >= heroExit
    ? 'compact'
    : 'full';
}

export function resolveConcept(search = '') {
  const requested = new URLSearchParams(search).get('concept');
  return CONCEPTS.has(requested) ? requested : 'light';
}

export function resolveTheme(storedTheme = '') {
  return storedTheme === 'dark' ? 'dark' : 'light';
}

export function getThemeControlPresentation(theme) {
  return theme === 'dark'
    ? {
        icon: 'sun',
        label: 'Включить светлую тему',
        nextTheme: 'light',
      }
    : {
        icon: 'moon',
        label: 'Включить тёмную тему',
        nextTheme: 'dark',
      };
}

export function advanceDemoFrame({ index, phase, count }) {
  if (phase === 'question') return { index, phase: 'loading' };
  if (phase === 'loading') return { index, phase: 'answer' };
  return { index: (index + 1) % count, phase: 'question' };
}

const heroVideoTimeline = [
  { index: 0, startsAt: 0, loadingAt: 3.35, answerAt: 4.15 },
  { index: 1, startsAt: 8.35, loadingAt: 11.85, answerAt: 12.65 },
  { index: 2, startsAt: 16.85, loadingAt: 22.55, answerAt: 23.35 },
];

export function getHeroVideoFrame(currentTime) {
  const safeTime = Math.max(0, Number(currentTime) || 0);
  const active = [...heroVideoTimeline]
    .reverse()
    .find((frame) => safeTime >= frame.startsAt) ?? heroVideoTimeline[0];

  if (safeTime >= active.answerAt) return { index: active.index, phase: 'answer' };
  if (safeTime >= active.loadingAt) return { index: active.index, phase: 'loading' };
  return { index: active.index, phase: 'question' };
}

export function counterValue(target, progress) {
  const safeTarget = Math.max(0, Number(target) || 0);
  const safeProgress = Math.min(1, Math.max(0, Number(progress) || 0));
  return Math.round(safeTarget * safeProgress);
}

export function advanceBotDemoState({ index, phase, count }) {
  if (phase === 'typing') return { index, phase: 'sent' };
  if (phase === 'sent') return { index, phase: 'result' };

  const safeCount = Math.max(1, Number(count) || 1);
  return { index: (index + 1) % safeCount, phase: 'typing' };
}

export function advancePreparationState(phase) {
  if (phase === 'input') return 'analysis';
  if (phase === 'analysis') return 'result';
  if (phase === 'result') return 'input';
  return 'input';
}

export function getReadinessPresentation(input) {
  const numeric = Number(input);
  const value = Number.isFinite(numeric)
    ? Math.max(0, Math.min(100, Math.round(numeric)))
    : 0;

  if (value >= 75) return { value, label: 'Готово', tone: 'ready' };
  if (value >= 50) return { value, label: 'Освежить', tone: 'review' };
  return { value, label: 'Повторить', tone: 'focus' };
}
