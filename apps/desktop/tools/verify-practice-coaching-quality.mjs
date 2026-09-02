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
const outputPath = path.resolve(process.cwd(), '..', '..', 'output', 'practice-coaching-quality.json');
const feedbackModel = (process.env.SKILLCUE_FEEDBACK_MODEL ?? '').trim();
const keepFeedbackModel = process.env.SKILLCUE_KEEP_FEEDBACK_MODEL === '1';

const resumeText = `QA Automation Engineer, Python. Разрабатываю UI-автотесты на Python, pytest и Playwright;
API-автотесты на Python, pytest и HTTPX. Использую Page Object, фикстуры, параметризацию,
GitLab CI, Docker и Allure. Настраивал smoke и regression пайплайны, анализировал логи и артефакты.`;

const cases = [
  {
    id: 'test-design-strong',
    question: 'Какую технику тест-дизайна вы применяете в работе?',
    topic: 'Тест-дизайн',
    level: 'middle',
    expectedSignals: ['классы эквивалентности', 'граничные значения', 'пример из практики', 'выбор техники по риску'],
    answer: 'Чаще всего использую классы эквивалентности и анализ граничных значений. Например, для поля суммы выделяю валидные и невалидные классы, а затем проверяю значения на границе, сразу до и после неё. Технику выбираю по риску: для сложных комбинаций добавляю таблицу решений, чтобы не потерять важные условия.',
  },
  {
    id: 'python-wrong',
    question: 'Чем list.sort отличается от sorted в Python?',
    topic: 'Python',
    level: 'middle',
    expectedSignals: ['изменение списка на месте', 'возвращает None', 'новый список', 'любая итерируемая коллекция'],
    answer: 'sort возвращает новый список и подходит для любых коллекций, а sorted меняет исходный список на месте.',
  },
  {
    id: 'oop-practical',
    question: 'Как вы используете ООП в своей работе?',
    topic: 'Python и архитектура автотестов',
    level: 'middle',
    expectedSignals: ['инкапсуляция', 'композиция', 'Page Object', 'практический пример', 'границы наследования'],
    answer: 'В UI-тестах я использую Page Object: локаторы и действия страницы держу внутри отдельных объектов, а тесты вызывают понятные бизнес-методы. Общие зависимости передаю через композицию. Наследование оставляю только для действительно общего поведения, чтобы не получить глубокую и хрупкую иерархию.',
  },
  {
    id: 'api-partial',
    question: 'Что вы проверяете в API-ответе кроме статус-кода?',
    topic: 'API-тестирование',
    level: 'middle',
    expectedSignals: ['схема и типы полей', 'бизнес-данные', 'заголовки', 'авторизация', 'негативные сценарии', 'изменение состояния'],
    answer: 'Проверяю JSON и основные поля ответа, а ещё время ответа.',
  },
  {
    id: 'unknown-kubernetes',
    question: 'Как вы использовали Kubernetes на проекте?',
    topic: 'Kubernetes',
    level: 'senior',
    expectedSignals: ['честная граница опыта', 'pods и deployments', 'логи и диагностика', 'конфигурация окружения'],
    answer: 'Сам Kubernetes на проекте я не настраивал. Понимаю базовые сущности, но практического опыта администрирования у меня нет.',
  },
  {
    id: 'asr-noise-correct',
    question: 'Как работают фикстуры pytest и зачем нужен scope?',
    topic: 'Pytest',
    level: 'middle',
    expectedSignals: ['подготовка и очистка', 'yield', 'scope function class module session', 'зависимости фикстур', 'пример'],
    answer: 'Фикстура готовит данные до теста, а после yield делает очистку. Скоп, эм, scope выбираю по времени жизни ресурса: function для изоляции каждого теста, session для дорогого общего ресурса. Фикстуры могут зависеть друг от друга через аргументы.',
  },
];

if (!fs.existsSync(executablePath)) {
  throw new Error(`Installed SkillCue Dev executable was not found: ${executablePath}`);
}

const app = await electron.launch({ executablePath, timeout: 30_000 });
let originalVacancyModel = '';
let settingsPage;

try {
  const page = app.windows()[0] ?? await app.waitForEvent('window', { timeout: 10_000 });
  settingsPage = page;
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2_000);

  if (feedbackModel) {
    const settings = await page.evaluate(async () => {
      const token = await window.electronAPI?.getApiToken?.();
      const response = await fetch('http://127.0.0.1:8001/settings/ai', {
        headers: token ? { 'X-SkillCue-Token': token } : {},
      });
      return response.json();
    });
    originalVacancyModel = settings.vacancy_review_model;
    await page.evaluate(async ({ model }) => {
      const token = await window.electronAPI?.getApiToken?.();
      const response = await fetch('http://127.0.0.1:8001/settings/ai', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'X-SkillCue-Token': token } : {}),
        },
        body: JSON.stringify({ vacancy_review_model: model }),
      });
      if (!response.ok) throw new Error(`Unable to select feedback model: ${response.status}`);
    }, { model: feedbackModel });
  }

  const results = [];
  for (const testCase of cases) {
    const startedAt = Date.now();
    const result = await page.evaluate(async ({ payload, resume }) => {
      const token = await window.electronAPI?.getApiToken?.();
      const response = await fetch('http://127.0.0.1:8001/vacancy/evaluate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'X-SkillCue-Token': token } : {}),
        },
        body: JSON.stringify({
          ...payload,
          resumeText: resume,
          vacancyText: 'QA Automation Engineer: Python, pytest, Playwright, API, Docker, CI/CD.',
          legendText: '',
          relatedResumeEvidence: [],
          language: 'ru',
          hasResume: true,
        }),
      });
      return {
        ok: response.ok,
        status: response.status,
        body: await response.json().catch(() => ({})),
      };
    }, { payload: testCase, resume: resumeText });
    results.push({ ...testCase, configuredModel: feedbackModel || 'current', latencyMs: Date.now() - startedAt, ...result });
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.map((result) => ({
    id: result.id,
    latencyMs: result.latencyMs,
    status: result.status,
    score: result.body?.score,
    verdict: result.body?.verdict,
    feedback: result.body?.feedback,
    corrections: result.body?.technicalCorrections,
    better: result.body?.suggestedBetterAnswer,
    sourceModel: result.body?.model,
  })), null, 2));

  const issues = [];
  const byId = Object.fromEntries(results.map((result) => [result.id, result]));
  for (const result of results) {
    if (!result.ok) issues.push(`${result.id}: HTTP ${result.status}`);
    if (result.latencyMs > 8_500) issues.push(`${result.id}: ${result.latencyMs} ms exceeds the coaching budget`);
    const better = String(result.body?.suggestedBetterAnswer ?? '');
    if (/в одном из моих проектов|на текущем проекте/i.test(better)) {
      issues.push(`${result.id}: unsupported project claim in the stronger answer`);
    }
  }
  if ((byId['test-design-strong']?.body?.score ?? 0) < 70) {
    issues.push('test-design-strong: strong answer scored below 70');
  }
  if ((byId['python-wrong']?.body?.score ?? 100) > 45) {
    issues.push('python-wrong: inverted sort/sorted answer scored above 45');
  }
  if (!/sort/i.test((byId['python-wrong']?.body?.technicalCorrections ?? []).join(' '))) {
    issues.push('python-wrong: decisive factual correction is missing');
  }
  if (/в\s+тестах\s+я\s+(?:чаще\s+)?использую\s+sorted/i.test(
    String(byId['python-wrong']?.body?.suggestedBetterAnswer ?? ''),
  )) {
    issues.push('python-wrong: a mentioned function was turned into an unsupported personal habit');
  }
  if ((byId['oop-practical']?.body?.score ?? 0) < 70
    || !/page object/i.test(String(byId['oop-practical']?.body?.suggestedBetterAnswer ?? ''))) {
    issues.push('oop-practical: practical OOP application was not recognized');
  }
  const apiScore = byId['api-partial']?.body?.score ?? 0;
  if (apiScore < 30 || apiScore > 75) issues.push(`api-partial: implausible score ${apiScore}`);
  const kubernetesBetter = String(byId['unknown-kubernetes']?.body?.suggestedBetterAnswer ?? '');
  if ((byId['unknown-kubernetes']?.body?.score ?? 100) > 75) {
    issues.push('unknown-kubernetes: an explicit experience gap scored above 75');
  }
  const unsupportedKubernetesClaim = /(?:использовал|настраивал|разворачивал|анализировал|проверял|участвовал|деплоил|могу\s+развернуть)[^.]{0,160}\b(?:helm|kubectl|configmaps?|secrets?|кластер)\b/i.test(kubernetesBetter);
  if (!/не\s+(?:настраивал|использовал)|нет\s+практического\s+опыта/i.test(kubernetesBetter)
    || /на\s+текущем\s+проекте|в\s+моих\s+проектах/i.test(kubernetesBetter)
    || unsupportedKubernetesClaim) {
    issues.push('unknown-kubernetes: honest experience boundary was not preserved');
  }
  if ((byId['asr-noise-correct']?.body?.score ?? 0) < 65) {
    issues.push('asr-noise-correct: correct answer with filler scored below 65');
  }
  const falseExampleComplaint = /не\s+(?:хватает|раскрыл\w*).{0,60}пример|(?:практическ|конкретн)\w*\s+пример\w*.{0,40}(?:нет|не\s+(?:привед|раскрыт|показан))|отсутств\w*.{0,60}(?:пример|подтвержден\w*\s+практик)/i;
  for (const id of ['test-design-strong', 'oop-practical', 'asr-noise-correct']) {
    const coachingText = [
      byId[id]?.body?.verdict,
      byId[id]?.body?.feedback,
      ...(byId[id]?.body?.missingPoints ?? []),
      ...(byId[id]?.body?.weakPoints ?? []),
    ].join(' ');
    if (falseExampleComplaint.test(coachingText)) {
      issues.push(`${id}: feedback denies the practical example already present in the answer`);
    }
  }
  if (issues.length > 0) {
    throw new Error(`Practice coaching quality gate failed:\n- ${issues.join('\n- ')}`);
  }
} finally {
  if (settingsPage && originalVacancyModel && !keepFeedbackModel) {
    await settingsPage.evaluate(async ({ model }) => {
      const token = await window.electronAPI?.getApiToken?.();
      await fetch('http://127.0.0.1:8001/settings/ai', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'X-SkillCue-Token': token } : {}),
        },
        body: JSON.stringify({ vacancy_review_model: model }),
      });
    }, { model: originalVacancyModel }).catch(() => undefined);
  }
  await app.close().catch(() => undefined);
}
