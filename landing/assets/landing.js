import {
  advancePreparationState,
  detectDesktopPlatform,
  getDownloadTarget,
  getFloatingActionsMode,
  getFloatingDownloadTarget,
  getHeroVideoFrame,
  getReadinessPresentation,
  getThemeControlPresentation,
  resolveConcept,
  resolveTheme,
} from './site-runtime.js?v=20260913-canonical1';

const root = document.documentElement;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const heroDemoVideo = document.querySelector('.hero-demo-video');
const themeButton = document.querySelector('[data-theme-toggle]');
const themeIcon = document.querySelector('[data-theme-icon]');
const themeColor = document.querySelector('meta[name="theme-color"]');

if (reducedMotion && heroDemoVideo) {
  heroDemoVideo.removeAttribute('autoplay');
  heroDemoVideo.pause();
  heroDemoVideo.currentTime = 0;
}

let storedTheme = '';
try {
  storedTheme = localStorage.getItem('skillcue.theme') || '';
} catch (_) {
  storedTheme = '';
}

const hasConceptPreview = new URLSearchParams(window.location.search).has('concept');
let theme = hasConceptPreview
  ? resolveConcept(window.location.search)
  : resolveTheme(storedTheme);

const renderTheme = () => {
  const presentation = getThemeControlPresentation(theme);
  root.dataset.theme = theme;
  themeButton?.setAttribute('aria-label', presentation.label);
  themeButton?.setAttribute('title', presentation.label);
  themeButton?.setAttribute('data-icon', presentation.icon);
  if (themeIcon) themeIcon.src = `/assets/icons/${presentation.icon}.svg`;
  if (themeColor) themeColor.content = theme === 'dark' ? '#07111f' : '#eef4f8';
};

renderTheme();

themeButton?.addEventListener('click', () => {
  theme = getThemeControlPresentation(theme).nextTheme;
  try {
    localStorage.setItem('skillcue.theme', theme);
  } catch (_) {
    // The current page still switches when storage is unavailable.
  }
  renderTheme();
});

const platform = detectDesktopPlatform({
  userAgent: navigator.userAgent,
  platform: navigator.userAgentData?.platform || navigator.platform,
});
const download = getDownloadTarget(platform);
const floatingDownload = getFloatingDownloadTarget(platform);

document.querySelectorAll('[data-download]').forEach((link) => {
  const target = link.classList.contains('floating-download') ? floatingDownload : download;
  link.href = target.href;
  if (link.classList.contains('floating-download')) link.dataset.os = target.icon;
  const label = link.querySelector('[data-download-label]');
  if (label) label.textContent = target.label;
});

const floatingActions = document.querySelector('.floating-actions');
const heroSection = document.querySelector('#interview');
const pricingSection = document.querySelector('#pricing');
const narrowViewport = window.matchMedia('(max-width: 760px)');

const renderFloatingActions = () => {
  if (!floatingActions || !heroSection || !pricingSection) return;
  const heroBottom = window.scrollY + heroSection.getBoundingClientRect().bottom;
  const pricingTop = window.scrollY + pricingSection.getBoundingClientRect().top;
  const mode = getFloatingActionsMode({
    isNarrow: narrowViewport.matches,
    scrollY: window.scrollY,
    viewportHeight: window.innerHeight,
    heroBottom,
    pricingTop,
  });
  floatingActions.classList.toggle(
    'is-mobile-compact',
    mode === 'compact',
  );
  floatingActions.classList.toggle(
    'is-mobile-hidden',
    mode === 'hidden',
  );
};

renderFloatingActions();
window.addEventListener('scroll', renderFloatingActions, { passive: true });
window.addEventListener('resize', renderFloatingActions);
narrowViewport.addEventListener?.('change', renderFloatingActions);

const preparationDemo = document.querySelector('[data-preparation-demo]');
const preparationAction = preparationDemo?.querySelector('[data-preparation-action]');
const preparationActionLabel = preparationDemo?.querySelector('[data-preparation-action-label]');
let preparationTimer = 0;

preparationAction?.addEventListener('click', () => {
  window.clearTimeout(preparationTimer);
  const analysisPhase = advancePreparationState('input');
  preparationDemo.dataset.phase = analysisPhase;
  preparationAction.disabled = true;
  if (preparationActionLabel) preparationActionLabel.textContent = 'Сверяем требования';

  preparationTimer = window.setTimeout(() => {
    preparationDemo.dataset.phase = advancePreparationState(analysisPhase);
    preparationAction.disabled = false;
    if (preparationActionLabel) preparationActionLabel.textContent = 'Разобрать ещё раз';
  }, reducedMotion ? 80 : 900);
});

const readinessItems = [...document.querySelectorAll('[data-readiness]')];

readinessItems.forEach((item) => {
  const presentation = getReadinessPresentation(item.dataset.readiness);
  item.dataset.tone = presentation.tone;
  item.style.setProperty('--readiness', `${presentation.value}%`);
  item.setAttribute('aria-valuenow', String(presentation.value));

  const value = item.querySelector('[data-readiness-value]');
  const state = item.querySelector('[data-readiness-state]');
  if (value) value.textContent = `${presentation.value}%`;
  if (state) state.textContent = presentation.label;
});

if (reducedMotion || !('IntersectionObserver' in window)) {
  readinessItems.forEach((item) => item.classList.add('is-measured'));
} else {
  const readinessObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-measured');
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: '0px 0px -6% 0px', threshold: 0.18 },
  );
  readinessItems.forEach((item) => readinessObserver.observe(item));
}

const demoFrames = [
  {
    question: 'Как инкапсуляция реализуется в Python?',
    answer: 'В Python инкапсуляция строится на соглашениях: _name — защищённый атрибут, __name включает name mangling. Доступ к состоянию контролируют через методы и @property.',
  },
  {
    question: 'Какие техники тест-дизайна ты используешь в работе?',
    answer: 'Использую классы эквивалентности, граничные значения, таблицы решений, pairwise и переходы состояний. Технику выбираю по рискам и логике функции.',
  },
  {
    question: 'Расскажи про стек на последнем месте работы.',
    answer: 'Python + pytest. UI — Playwright, API — requests и HTTPX, отчёты — Allure, запуск — GitLab CI.',
  },
];

const phaseLabels = {
  question: 'Слушаю вопрос',
  loading: 'Готовлю ответ',
  answer: 'Live-ответ по разговору',
};

let demoState = reducedMotion
  ? { index: 0, phase: 'answer' }
  : getHeroVideoFrame(heroDemoVideo?.currentTime ?? 0);

const renderDemo = () => {
  const frame = demoFrames[demoState.index];
  document.querySelectorAll('[data-demo-card]').forEach((card) => {
    card.dataset.phase = demoState.phase;
  });
  document.querySelectorAll('[data-demo-question]').forEach((node) => {
    node.textContent = frame.question;
  });
  document.querySelectorAll('[data-demo-answer]').forEach((node) => {
    node.textContent = frame.answer;
  });
  document.querySelectorAll('[data-demo-state]').forEach((node) => {
    node.textContent = phaseLabels[demoState.phase];
  });
};

renderDemo();

const syncHeroDemo = () => {
  if (!heroDemoVideo || reducedMotion) return;
  const nextState = getHeroVideoFrame(heroDemoVideo.currentTime);
  if (nextState.index === demoState.index && nextState.phase === demoState.phase) return;
  demoState = nextState;
  renderDemo();
};

['loadedmetadata', 'timeupdate', 'seeked'].forEach((eventName) => {
  heroDemoVideo?.addEventListener(eventName, syncHeroDemo);
});

const revealItems = [...document.querySelectorAll('.reveal')];

if (reducedMotion || !('IntersectionObserver' in window)) {
  revealItems.forEach((item) => item.classList.add('is-visible'));
} else {
  const revealObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: '0px 0px -9% 0px', threshold: 0.1 },
  );
  revealItems.forEach((item) => revealObserver.observe(item));
}

if (!reducedMotion) root.classList.add('motion-ready');
