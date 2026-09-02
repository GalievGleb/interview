import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const executablePath = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
  'Programs',
  'skillcue-dev',
  'SkillCue Dev.exe',
);
const outputDir = path.resolve(process.cwd(), '..', '..', 'output', 'playwright', 'practice-feedback-audit');
const storageKey = 'skillcue.vacancyReview.sessions.v1';
const fixtureId = 'codex-practice-feedback-audit';

if (!fs.existsSync(executablePath)) {
  throw new Error(`Installed SkillCue Dev executable was not found: ${executablePath}`);
}
fs.mkdirSync(outputDir, { recursive: true });

const now = Date.now();
const fixture = {
  id: fixtureId,
  vacancyAnalysisId: `${fixtureId}-analysis`,
  status: 'in_progress',
  currentIndex: 0,
  startedAt: now,
  vacancyAnalysis: {
    id: `${fixtureId}-analysis`,
    vacancyText: 'QA Automation Engineer: Python, pytest, Playwright, API.',
    contextKind: 'role',
    targetRole: 'QA Automation · Python',
    seniorityLevel: 'middle',
    language: 'ru',
    extractedRequirements: ['Python', 'pytest', 'Playwright'],
    optionalSkills: [],
    interviewTopics: [{
      id: 'oop',
      title: 'Python и архитектура автотестов',
      category: 'technical',
      importance: 'high',
      expectedKnowledge: 'Практическое применение ООП',
      sampleQuestions: ['Как вы используете ООП в работе?'],
      vacancyEvidence: 'Python, pytest, Playwright',
      level: 'middle',
    }],
    projectQuestions: [],
    riskAreas: [],
    hasResume: true,
    hasLegend: false,
    analysisSource: 'ai',
    createdAt: now,
  },
  questions: [{
    id: 'oop-question',
    topicId: 'oop',
    question: 'Как вы используете ООП в своей работе?',
    difficulty: 'medium',
    level: 'middle',
    expectedSignals: ['инкапсуляция', 'Page Object', 'композиция', 'пример'],
    redFlags: [],
  }],
  answers: [{
    questionId: 'oop-question',
    text: 'В UI-тестах использую Page Object: локаторы и действия инкапсулирую в классах страниц, а зависимости передаю через композицию.',
    source: 'text',
    skipped: false,
    answeredAt: now,
    evaluation: {
      questionId: 'oop-question',
      score: 85,
      clarityScore: 85,
      technicalAccuracyScore: 90,
      specificityScore: 80,
      confidenceScore: 85,
      levelEstimate: 'middle',
      verdict: 'Практическое применение ООП раскрыто уверенно.',
      feedback: 'Ответ технически корректен и привязан к реальной архитектуре UI-тестов.',
      goodPoints: ['Page Object показан как рабочий инструмент, а не определение из учебника.'],
      missingPoints: ['Коротко обозначить, где наследование делает тесты хрупкими.'],
      weakPoints: [],
      technicalCorrections: [],
      suggestedBetterAnswer: 'В UI-тестах я применяю Page Object: локаторы и действия инкапсулирую в классах страниц, а тест оставляю на уровне бизнес-сценария. Зависимости передаю через композицию; наследование использую только для действительно общего поведения, чтобы не создавать хрупкую иерархию.',
      followUpQuestions: ['Когда вы выберете композицию вместо наследования?'],
      evaluationSource: 'ai',
    },
  }],
};

const app = await electron.launch({ executablePath, timeout: 30_000 });
let page;
let originalStorage;

async function captureScreenshot(targetPath) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.bringToFront();
      await page.screenshot({ path: targetPath, animations: 'disabled', timeout: 15_000 });
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(500);
    }
  }
  throw lastError;
}

try {
  page = app.windows()[0] ?? await app.waitForEvent('window', { timeout: 10_000 });
  await page.waitForLoadState('domcontentloaded');
  originalStorage = await page.evaluate((key) => localStorage.getItem(key), storageKey);
  await page.evaluate(({ key, session }) => {
    const existing = JSON.parse(localStorage.getItem(key) || '[]');
    localStorage.setItem(key, JSON.stringify([session, ...existing.filter((item) => item?.id !== session.id)]));
    window.location.hash = `#/practice/session?session=${encodeURIComponent(session.id)}`;
  }, { key: storageKey, session: fixture });

  await page.waitForFunction(
    () => document.querySelector('.prep-evaluation-card')?.textContent?.includes('Практическое применение ООП'),
    undefined,
    { timeout: 10_000 },
  );

  const results = [];
  for (const theme of ['light', 'dark']) {
    await page.evaluate((themeName) => {
      document.documentElement.dataset.theme = themeName;
      document.querySelector('.prep-evaluation-card')?.scrollIntoView({ block: 'start' });
    }, theme);
    await page.waitForTimeout(200);

    const state = await page.evaluate(() => {
      const card = document.querySelector('.prep-evaluation-card');
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const rect = card?.getBoundingClientRect();
      return {
        viewport,
        card: rect ? {
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          scrollWidth: card?.scrollWidth ?? 0,
          clientWidth: card?.clientWidth ?? 0,
        } : null,
        text: card?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      };
    });
    const screenshot = path.join(outputDir, `practice-feedback-${theme}.png`);
    await captureScreenshot(screenshot);
    results.push({ theme, screenshot, ...state });
  }

  const issues = results.flatMap((result) => {
    if (!result.card) return [`${result.theme}: feedback card is missing`];
    if (result.card.scrollWidth > result.card.clientWidth + 1) return [`${result.theme}: horizontal overflow`];
    if (!result.text.includes('Сначала исправить')) return [`${result.theme}: primary correction is not visible`];
    if (!result.text.includes('Готовый сильный ответ')) return [`${result.theme}: stronger answer is not visible`];
    return [];
  });
  fs.writeFileSync(path.join(outputDir, 'audit.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.map(({ text, ...result }) => ({
    ...result,
    text: text.slice(0, 500),
  })), null, 2));
  if (issues.length) throw new Error(`Practice feedback UI audit failed:\n- ${issues.join('\n- ')}`);
} finally {
  if (page && originalStorage !== undefined) {
    await page.evaluate(({ key, raw }) => {
      if (raw == null) localStorage.removeItem(key);
      else localStorage.setItem(key, raw);
    }, { key: storageKey, raw: originalStorage }).catch(() => undefined);
  }
  await app.close().catch(() => undefined);
}
