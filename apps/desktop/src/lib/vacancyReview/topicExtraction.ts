/**
 * Heuristic topic extraction from a vacancy. General-purpose (QA, backend,
 * frontend, data, devops, mobile…), NOT a hardcoded QA list. Each matched topic
 * carries the vacancy phrase it was derived from.
 *
 * This is the deterministic stand-in for the real LLM extraction — the public
 * shape (InterviewTopic[]) is what a backend `/vacancy/analyze` call will return.
 */
import type {
  Difficulty,
  InterviewTopic,
  SeniorityLevel,
  TopicImportance,
} from './types';

interface TopicDef {
  id: string;
  title: string;
  category: string;
  keywords: string[];
  expectedKnowledge: string;
  sampleQuestions: string[];
}

// Broad catalogue — a topic only appears if its keywords are in the vacancy.
const TOPIC_CATALOGUE: TopicDef[] = [
  {
    id: 'python',
    title: 'Python basics',
    category: 'Language',
    keywords: ['python', 'питон', 'pytest'],
    expectedKnowledge: 'Core types, comprehensions, OOP, error handling, idioms.',
    sampleQuestions: [
      'Чем list отличается от tuple и когда что выбираешь?',
      'Как работают генераторы и зачем нужен yield?',
      'Что такое контекстный менеджер и где ты его применял?',
    ],
  },
  {
    id: 'pytest',
    title: 'Pytest',
    category: 'Testing',
    keywords: ['pytest', 'пайтест', 'fixtures', 'фикстур'],
    expectedKnowledge: 'Fixtures, scopes, conftest, parametrize, markers.',
    sampleQuestions: [
      'Какие бывают scope у фикстур и зачем нужен conftest?',
      'Как параметризуешь тесты и зачем?',
    ],
  },
  {
    id: 'ui-automation',
    title: 'UI automation (Playwright / Selenium)',
    category: 'Testing',
    keywords: ['playwright', 'selenium', 'плейрайт', 'селениум', 'ui-тест', 'ui тест', 'e2e'],
    expectedKnowledge: 'Locators, waits, page objects, flaky-test handling.',
    sampleQuestions: [
      'Как борешься с flaky UI-тестами?',
      'Чем Playwright удобнее Selenium на динамических интерфейсах?',
    ],
  },
  {
    id: 'api-testing',
    title: 'API testing',
    category: 'Testing',
    keywords: ['api', 'rest', 'http', 'httpx', 'requests', 'postman', 'swagger', 'graphql'],
    expectedKnowledge: 'Status codes, schema/body checks, negative cases, auth.',
    sampleQuestions: [
      'Что проверяешь в API-ответе кроме статус-кода 200?',
      'Какие негативные сценарии для API ты закладываешь?',
    ],
  },
  {
    id: 'sql',
    title: 'SQL',
    category: 'Data',
    keywords: ['sql', 'postgres', 'mysql', 'база данных', 'бд', 'database', 'запрос'],
    expectedKnowledge: 'Joins, aggregation, filtering, basic optimization.',
    sampleQuestions: [
      'Чем INNER JOIN отличается от LEFT JOIN?',
      'Как проверишь данные в БД после действия в UI?',
    ],
  },
  {
    id: 'cicd',
    title: 'CI/CD',
    category: 'Infrastructure',
    keywords: ['ci/cd', 'cicd', 'gitlab ci', 'jenkins', 'pipeline', 'пайплайн', 'github actions'],
    expectedKnowledge: 'Stages/jobs, running tests, artifacts, failure analysis.',
    sampleQuestions: [
      'Как ты настраивал запуск автотестов в CI/CD?',
      'Что делаешь, когда pipeline падает — как ищешь причину?',
    ],
  },
  {
    id: 'docker',
    title: 'Docker',
    category: 'Infrastructure',
    keywords: ['docker', 'докер', 'container', 'контейнер', 'kubernetes', 'k8s'],
    expectedKnowledge: 'Images, containers, reproducible test environments.',
    sampleQuestions: [
      'Зачем Docker для автотестов и как ты его использовал?',
      'Чем образ отличается от контейнера?',
    ],
  },
  {
    id: 'reporting',
    title: 'Test reports (Allure)',
    category: 'Testing',
    keywords: ['allure', 'аллюр', 'report', 'отчёт', 'отчет'],
    expectedKnowledge: 'Artifacts, screenshots, logs, failure triage.',
    sampleQuestions: ['Как Allure-отчёты помогали тебе разбирать падения?'],
  },
  {
    id: 'git',
    title: 'Git',
    category: 'Tools',
    keywords: ['git', 'гит', 'version control', 'merge', 'branch', 'rebase'],
    expectedKnowledge: 'Branching, merge vs rebase, conflict resolution.',
    sampleQuestions: ['Чем merge отличается от rebase и что используешь?'],
  },
  {
    id: 'test-design',
    title: 'Test design',
    category: 'Testing',
    keywords: ['тест-дизайн', 'test design', 'эквивалент', 'граничны', 'boundary', 'test case', 'тест-кейс'],
    expectedKnowledge: 'Equivalence classes, boundary values, test cases, checklists.',
    sampleQuestions: ['Какие техники тест-дизайна ты применяешь и зачем?'],
  },
  {
    id: 'regression',
    title: 'Regression / smoke testing',
    category: 'Testing',
    keywords: ['регресс', 'regression', 'smoke', 'смоук', 'санити', 'sanity'],
    expectedKnowledge: 'Smoke vs regression, when each runs, suite maintenance.',
    sampleQuestions: ['Чем smoke-набор отличается от regression и когда что гоняешь?'],
  },
  {
    id: 'js-ts',
    title: 'JavaScript / TypeScript',
    category: 'Language',
    keywords: ['javascript', 'typescript', 'js', 'ts', 'node', 'react', 'vue', 'angular'],
    expectedKnowledge: 'Types, async, closures, framework fundamentals.',
    sampleQuestions: ['Чем отличается == от === и почему это важно?'],
  },
  {
    id: 'backend',
    title: 'Backend fundamentals',
    category: 'Engineering',
    keywords: ['backend', 'микросервис', 'microservice', 'fastapi', 'django', 'flask', 'spring'],
    expectedKnowledge: 'Request lifecycle, REST design, data flow.',
    sampleQuestions: ['Как устроен жизненный цикл запроса в твоём бэкенде?'],
  },
  {
    id: 'linux',
    title: 'Linux / shell',
    category: 'Tools',
    keywords: ['linux', 'линукс', 'bash', 'shell', 'grep', 'терминал', 'cli'],
    expectedKnowledge: 'Navigation, logs, processes, useful commands.',
    sampleQuestions: ['Какие команды Linux чаще всего используешь в работе?'],
  },
  {
    id: 'behavioral',
    title: 'Behavioral questions',
    category: 'Soft skills',
    keywords: ['команд', 'communication', 'agile', 'scrum', 'soft', 'коммуникац'],
    expectedKnowledge: 'Teamwork, conflict, ownership, real examples.',
    sampleQuestions: ['Расскажи про сложную ситуацию в команде и как её решил.'],
  },
];

// Always probe for these even if not literally in the text — they are near-universal
// in a technical interview when there's a clear role.
const ALWAYS_TOPICS = ['behavioral', 'project-experience'];

const PROJECT_TOPIC: TopicDef = {
  id: 'project-experience',
  title: 'Project experience',
  category: 'Experience',
  keywords: [],
  expectedKnowledge: 'Concrete real projects: role, stack, impact, ownership.',
  sampleQuestions: [
    'Расскажи про свой самый показательный проект и твою роль в нём.',
    'С каким стеком ты работал и за что отвечал?',
  ],
};

function firstSentenceWith(text: string, keyword: string): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(keyword.toLowerCase());
  if (idx < 0) return '';
  const start = Math.max(0, text.lastIndexOf('\n', idx), text.lastIndexOf('.', idx) + 1);
  let end = text.length;
  for (const sep of ['\n', '.', ';', '·', '•']) {
    const e = text.indexOf(sep, idx);
    if (e >= 0 && e < end) end = e;
  }
  return text.slice(start, end).replace(/^[\s•·\-–]+/, '').trim().slice(0, 140);
}

function importanceFor(text: string, keyword: string): TopicImportance {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(keyword.toLowerCase());
  const window = lower.slice(Math.max(0, idx - 60), idx + 60);
  if (/(must|required|обязательн|требуется|необходим|strong|уверенн)/.test(window)) return 'high';
  if (/(nice to have|желательн|плюс|optional|будет плюсом|преимуществ)/.test(window)) return 'low';
  return 'medium';
}

export function detectSeniority(text: string, role: string): SeniorityLevel {
  const t = `${role} ${text}`.toLowerCase();
  if (/\blead\b|тимлид|teamlead|principal/.test(t)) return 'lead';
  if (/\bsenior\b|\bсиньор\b|\bсеньор\b|ведущ/.test(t)) return 'senior';
  if (/\bmiddle\b|\bмидл\b/.test(t)) return 'middle';
  if (/\bjunior\b|\bджуниор\b|\bджун\b/.test(t)) return 'junior';
  if (/\bintern\b|стажёр|стажер|trainee/.test(t)) return 'intern';
  const years = t.match(/(\d+)\+?\s*(?:year|год|лет|года)/);
  if (years) {
    const n = parseInt(years[1], 10);
    if (n >= 5) return 'senior';
    if (n >= 3) return 'middle';
    if (n >= 1) return 'junior';
  }
  return 'unknown';
}

export function detectRole(text: string, hinted?: string): string {
  if (hinted && hinted.trim()) return hinted.trim();
  const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  if (firstLine && firstLine.length <= 80) return firstLine;
  const lower = text.toLowerCase();
  const roles: [RegExp, string][] = [
    [/qa\s*automation|aqa|автоматизатор/, 'QA Automation Engineer'],
    [/\bqa\b|тестировщик|quality/, 'QA Engineer'],
    [/frontend|фронтенд/, 'Frontend Developer'],
    [/backend|бэкенд|бекенд/, 'Backend Developer'],
    [/data\s*(scientist|engineer|analyst)|данны/, 'Data Specialist'],
    [/devops|sre/, 'DevOps Engineer'],
    [/mobile|android|ios|мобильн/, 'Mobile Developer'],
  ];
  for (const [re, label] of roles) if (re.test(lower)) return label;
  return 'Technical role';
}

function difficultyForIndex(i: number, total: number): Difficulty {
  const ratio = total <= 1 ? 0 : i / (total - 1);
  if (ratio < 0.34) return 'easy';
  if (ratio < 0.7) return 'medium';
  return 'hard';
}

export interface ExtractionResult {
  topics: InterviewTopic[];
  requirements: string[];
  optionalSkills: string[];
}

/** Extract interview topics + requirements from the vacancy text. */
export function extractTopics(vacancyText: string): ExtractionResult {
  const text = vacancyText || '';
  const matched: InterviewTopic[] = [];
  const requirements: string[] = [];
  const optionalSkills: string[] = [];

  for (const def of TOPIC_CATALOGUE) {
    const hit = def.keywords.find((k) => text.toLowerCase().includes(k.toLowerCase()));
    if (!hit) continue;
    const importance = importanceFor(text, hit);
    const evidence = firstSentenceWith(text, hit) || def.title;
    matched.push({
      id: def.id,
      title: def.title,
      category: def.category,
      importance,
      expectedKnowledge: def.expectedKnowledge,
      sampleQuestions: def.sampleQuestions,
      vacancyEvidence: evidence,
    });
    (importance === 'low' ? optionalSkills : requirements).push(def.title);
  }

  // Ensure near-universal topics exist when there is a real role to test.
  if (matched.length > 0) {
    for (const def of [PROJECT_TOPIC, ...TOPIC_CATALOGUE.filter((d) => ALWAYS_TOPICS.includes(d.id))]) {
      if (matched.some((m) => m.id === def.id)) continue;
      if (!ALWAYS_TOPICS.includes(def.id)) continue;
      matched.push({
        id: def.id,
        title: def.title,
        category: def.category,
        importance: 'medium',
        expectedKnowledge: def.expectedKnowledge,
        sampleQuestions: def.sampleQuestions,
        vacancyEvidence: 'Стандартная часть технического интервью.',
      });
    }
    if (!matched.some((m) => m.id === 'project-experience')) {
      matched.push({
        id: PROJECT_TOPIC.id,
        title: PROJECT_TOPIC.title,
        category: PROJECT_TOPIC.category,
        importance: 'high',
        expectedKnowledge: PROJECT_TOPIC.expectedKnowledge,
        sampleQuestions: PROJECT_TOPIC.sampleQuestions,
        vacancyEvidence: 'Любое интервью проверяет реальный проектный опыт.',
      });
    }
  }

  // High-importance first, then medium, then low.
  const order = { high: 0, medium: 1, low: 2 };
  matched.sort((a, b) => order[a.importance] - order[b.importance]);
  return { topics: matched, requirements, optionalSkills };
}

export { difficultyForIndex };
