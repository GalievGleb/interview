/**
 * Vacancy Smoke Review — logic layer (mock AI behind a stable interface).
 *
 * Every function here is the deterministic stand-in for a backend/LLM call. The
 * INPUT/OUTPUT shapes are the contract a real `/vacancy/*` endpoint will honour,
 * so swapping mock → real touches only this module. UI never calls heuristics
 * directly — it goes through these functions.
 */
import { api } from '../api';
import { cleanVoiceAnswerTranscriptText } from '../voiceAnswerTranscript';
import { conceptSignalsForQuestion } from './conceptSignals';
import { difficultyForIndex, detectRole, detectSeniority, extractTopics } from './topicExtraction';
import { readinessLabelFromScore, topicStatusFromScore } from './readiness';
import type {
  Competency,
  CompetencyLevel,
  InterviewTopic,
  QuestionLevel,
  ReadinessReport,
  ResumeMatch,
  SeniorityLevel,
  SmokeAnswerEvaluation,
  SmokeQuestion,
  SmokeReviewSession,
  TopicImportance,
  TopicScore,
  VacancyAnalysis,
  VacancyReviewInput,
} from './types';

const uid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}`;

/** Trim grounding text before we denormalize it onto the analysis/session. */
const RESUME_CAP = 4000;
const LEGEND_CAP = 2000;

const QUESTION_LEVEL: QuestionLevel[] = ['junior', 'middle', 'senior', 'lead'];
function asQuestionLevel(v: string | undefined): QuestionLevel | undefined {
  return v && (QUESTION_LEVEL as string[]).includes(v) ? (v as QuestionLevel) : undefined;
}

/** The depth an interviewer targets for THIS candidate, from vacancy seniority. */
function seniorityToLevel(s: SeniorityLevel): QuestionLevel {
  if (s === 'lead') return 'lead';
  if (s === 'senior') return 'senior';
  if (s === 'junior' || s === 'intern') return 'junior';
  return 'middle';
}

const HEDGE_RE = /(не знаю|не уверен|наверное|кажется|emм|не помню|не сталкивался|hard to say)/i;
const SPECIFIC_RE =
  /(\d|playwright|pytest|docker|allure|gitlab|jenkins|httpx|selenium|sql|postgres|api|ci\/cd|fixture|в проекте|на проекте|я настраивал|я писал|я делал|я использовал)/i;

// ── Voice-answer preprocessing (ASR/noise) — mock heuristics ──
const NOISE_URL_RE = /((?:https?:\/\/|www\.)\S+|[a-z0-9-]+\.(?:com|ru|org|net|io|ai)\b\S*)/gi;
const NOISE_PHRASE_RE =
  /(patreon|подпис|подпиш|донат|реклам|лайк|колокольчик|наш канал|ваши вопросы по|экспериментальный сайт|в этом видео|это будет в.*видео|www\.|меня\s+не\s+записыва|не\s+записыва(?:ет|лось)|запись\s+не\s+ид[её]т|микрофон\s+не\s+работ|не\s+слышно|всем\s+проблем|в\s*ч[её]м\s+проблем)/i;
const NOISE_MIC_CHECK_RE = /^(?:раз|м{3,}|э{3,}|е{3,}|m{3,}|[\s,.-])+$/i;
const NOISE_LONG_FILLER_RE = /(?:^|[\s.,!?;:])(?:м{4,}|э{4,}|е{4,}|m{4,}|uh{3,}|um{3,})(?=$|[\s.,!?;:])/i;
// Leadership / project questions — where ownership must actually be shown.
const LEADERSHIP_ROLE_RE = /(моя роль|я отвеч|в моей зоне|я принима|я выбира|я развива|я строил|технически отвеч)/i;
const LEADERSHIP_TEAM_RE = /(команд|ревью|code review|менторинг|наставн|приоритиз|стратег)/i;
const RESULT_RE = /(результат|эффект|сократи|упрости|ускори|стабильн|поддерж|снизил)/i;

const SIGNAL_STOP_WORDS = new Set([
  'candidate',
  'should',
  'must',
  'explain',
  'describe',
  'кандидат',
  'должен',
  'должна',
  'должны',
  'объяснить',
  'объясняет',
  'рассказать',
  'показать',
  'формировать',
  'развивать',
  'понимать',
  'знать',
  'уметь',
  'может',
  'нужно',
]);

const TOOL_ALIASES: Array<{ label: string; re: RegExp }> = [
  { label: 'Requests', re: /\brequests?\b/i },
  { label: 'HTTPX', re: /\bhttpx\b/i },
  { label: 'Playwright', re: /\bplaywright\b|плейрайт/i },
  { label: 'Selenium', re: /\bselenium\b|селениум/i },
  { label: 'pytest', re: /\bpytest\b|пайтест/i },
  { label: 'pytest-xdist', re: /\bpytest[-\s]?xdist\b|\bxdist\b|\bxdisk\b|иксдист|иксдиск/i },
  { label: 'Pydantic', re: /\bpydantic\b|\bpydentic\b|пайдентик|пидантик/i },
  { label: 'Allure', re: /\ballure\b|аллюр|алюр/i },
  { label: 'GitLab CI', re: /\bgitlab(?:\s+ci)?\b|\bci\/cd\b|\bcicd\b|пайплайн/i },
  { label: 'Jenkins', re: /\bjenkins\b/i },
  { label: 'Docker', re: /\bdocker\b|докер/i },
  { label: 'Postman', re: /\bpostman\b/i },
  { label: 'XPath', re: /\bxpath\b|икспас|икспат/i },
];

const IMPORTANCE: TopicImportance[] = ['high', 'medium', 'low'];
function asImportance(v: string): TopicImportance {
  return (IMPORTANCE as string[]).includes(v) ? (v as TopicImportance) : 'medium';
}

/**
 * Analyze a vacancy → topics, role, seniority, risks. Tries the real LLM
 * (/vacancy/analyze) and falls back to the deterministic mock if the backend or
 * model is unavailable — so the feature always works.
 */
export async function analyzeVacancy(input: VacancyReviewInput): Promise<VacancyAnalysis> {
  try {
    const r = await api.vacancyAnalyze({
      vacancyText: input.vacancyText,
      targetRole: input.targetRole,
      language: input.language,
      resumeText: input.resumeText,
      legendText: input.legendText,
    });
    if (r.interviewTopics?.length) {
      const topics: InterviewTopic[] = r.interviewTopics.map((t) => ({
        id: t.id,
        title: t.title,
        category: t.category || 'General',
        importance: asImportance(t.importance),
        level: asQuestionLevel(t.level),
        expectedKnowledge: t.expectedKnowledge,
        sampleQuestions: t.sampleQuestions?.length ? t.sampleQuestions : ['Расскажи про эту тему.'],
        whyAsked: t.whyAsked || undefined,
        expectedAnswerPoints: t.expectedAnswerPoints?.length ? t.expectedAnswerPoints : undefined,
        relatedVacancyTopics: t.relatedVacancyTopics?.length ? t.relatedVacancyTopics : undefined,
        relatedResumeEvidence: t.relatedResumeEvidence?.length ? t.relatedResumeEvidence : undefined,
        vacancyEvidence: t.vacancyEvidence,
      }));
      const competencies: Competency[] | undefined = r.competencies?.length
        ? r.competencies.map((c) => ({
            name: c.name,
            priority: asImportance(c.priority),
            expectedLevel: (['basic', 'practical', 'advanced', 'lead'] as string[]).includes(
              c.expectedLevel,
            )
              ? (c.expectedLevel as CompetencyLevel)
              : 'practical',
            resumeMatch: (['strong', 'partial', 'gap'] as string[]).includes(c.resumeMatch)
              ? (c.resumeMatch as ResumeMatch)
              : 'gap',
            note: c.note ?? '',
          }))
        : undefined;
      return {
        id: uid(),
        vacancyText: input.vacancyText,
        targetRole: r.targetRole || detectRole(input.vacancyText, input.targetRole),
        seniorityLevel: (
          ['intern', 'junior', 'middle', 'senior', 'lead', 'unknown'] as const
        ).includes(r.seniorityLevel as never)
          ? (r.seniorityLevel as VacancyAnalysis['seniorityLevel'])
          : 'unknown',
        language: input.language,
        extractedRequirements: r.extractedRequirements ?? [],
        optionalSkills: r.optionalSkills ?? [],
        competencies,
        interviewTopics: topics,
        projectQuestions: r.projectQuestions ?? [],
        riskAreas: r.riskAreas ?? [],
        hasResume: Boolean(input.resumeText),
        hasLegend: Boolean(input.legendText),
        analysisSource: 'ai',
        resumeText: input.resumeText?.slice(0, RESUME_CAP),
        legendText: input.legendText?.slice(0, LEGEND_CAP),
        createdAt: Date.now(),
      };
    }
  } catch {
    // Backend/model unavailable — fall through to the deterministic mock.
  }
  return analyzeVacancyMock(input);
}

/** Deterministic fallback analysis (no backend). */
export function analyzeVacancyMock(input: VacancyReviewInput): VacancyAnalysis {
  const { topics: rawTopics, requirements, optionalSkills } = extractTopics(input.vacancyText);
  const targetRole = detectRole(input.vacancyText, input.targetRole);
  const seniorityLevel = detectSeniority(input.vacancyText, targetRole);
  const resume = (input.resumeText || '').toLowerCase();
  const level = seniorityToLevel(seniorityLevel);

  // Enrich each topic with the richer interviewer metadata deterministically.
  const topics: InterviewTopic[] = rawTopics.map((t) => {
    const points = t.expectedKnowledge
      .replace(/\.$/, '')
      .split(/[,;]/)
      .map((p) => p.trim())
      .filter(Boolean);
    const match = resumeMatchFor(t.title, resume, Boolean(input.resumeText));
    return {
      ...t,
      level,
      whyAsked: `Проверяем «${t.title.toLowerCase()}» — тема заявлена в вакансии${
        t.importance === 'high' ? ' как критичная' : ''
      }.`,
      expectedAnswerPoints: points.length ? points : undefined,
      relatedVacancyTopics: [t.title],
      relatedResumeEvidence:
        match === 'strong' ? [`Опыт по «${t.title}» из резюме`] : undefined,
    };
  });

  const competencies: Competency[] = topics.map((t) => ({
    name: t.title,
    priority: t.importance,
    expectedLevel: expectedLevelFor(t.importance, level),
    resumeMatch: resumeMatchFor(t.title, resume, Boolean(input.resumeText)),
    note:
      resumeMatchFor(t.title, resume, Boolean(input.resumeText)) === 'gap'
        ? 'Нет явного подтверждения в резюме — проверить глубже.'
        : 'Есть релевантный опыт — можно копать в детали.',
  }));

  const riskAreas: string[] = [];
  if (!input.resumeText)
    riskAreas.push('Резюме не подключено — ответы не будут опираться на ваш реальный опыт.');
  if (!input.legendText)
    riskAreas.push('История опыта не подключена — связки в ответах могут звучать обобщённо.');
  const highTopics = topics.filter((t) => t.importance === 'high');
  if (highTopics.length) {
    riskAreas.push(`Темы с высоким весом: ${highTopics.map((t) => t.title).join(', ')}.`);
  }
  const gaps = competencies.filter((c) => c.resumeMatch === 'gap' && c.priority !== 'low');
  if (gaps.length) {
    riskAreas.push(`Пробелы против резюме: ${gaps.map((c) => c.name).join(', ')}.`);
  }
  if (!topics.length)
    riskAreas.push('Не удалось выделить чёткие темы — вставьте более полный текст вакансии.');

  const projectQuestions = topics
    .filter((t) => t.importance !== 'low')
    .slice(0, 4)
    .map((t) => `Расскажи, как ты применял ${t.title.toLowerCase()} на реальном проекте.`);

  return {
    id: uid(),
    vacancyText: input.vacancyText,
    targetRole,
    seniorityLevel,
    language: input.language,
    extractedRequirements: requirements,
    optionalSkills,
    competencies,
    interviewTopics: topics,
    projectQuestions,
    riskAreas,
    hasResume: Boolean(input.resumeText),
    hasLegend: Boolean(input.legendText),
    analysisSource: 'heuristic',
    resumeText: input.resumeText?.slice(0, RESUME_CAP),
    legendText: input.legendText?.slice(0, LEGEND_CAP),
    createdAt: Date.now(),
  };
}

/** Heuristic résumé coverage for a topic (mock only). */
function resumeMatchFor(title: string, resumeLower: string, hasResume: boolean): ResumeMatch {
  if (!hasResume) return 'gap';
  const words = title
    .toLowerCase()
    .split(/[^a-zа-яё0-9+]+/i)
    .filter((w) => w.length > 2);
  const hit = words.some((w) => resumeLower.includes(w));
  if (hit) return 'strong';
  return 'partial';
}

/** Expected depth from importance + role seniority (mock only). */
function expectedLevelFor(importance: TopicImportance, level: QuestionLevel): CompetencyLevel {
  if (level === 'lead' && importance === 'high') return 'lead';
  if (level === 'lead' || level === 'senior') return 'advanced';
  if (importance === 'high') return 'practical';
  return 'basic';
}

/** Build an 8–15 question smoke plan, grouped by topic, gradually harder. */
export function buildSmokePlan(
  analysis: VacancyAnalysis,
  selectedTopicIds?: string[],
): SmokeQuestion[] {
  // TODO(real-ai): POST /vacancy/plan { analysisId } → grounded questions.
  // Пустой/отсутствующий выбор = все темы; иначе тренируем только отмеченные
  // (ученик снимает темы, где уже уверенно разбирается).
  const topics =
    selectedTopicIds && selectedTopicIds.length
      ? analysis.interviewTopics.filter((t) => selectedTopicIds.includes(t.id))
      : analysis.interviewTopics;
  if (!topics.length) return [];
  const target = Math.min(15, Math.max(8, topics.length + 3));

  // Round-robin one question per topic (high importance first) until we hit target.
  const pool: { topic: InterviewTopic; question: string }[] = [];
  let round = 0;
  while (pool.length < target) {
    let added = false;
    for (const topic of topics) {
      const q = topic.sampleQuestions[round];
      if (!q) continue;
      pool.push({ topic, question: q });
      added = true;
      if (pool.length >= target) break;
    }
    round += 1;
    if (!added) break; // ran out of sample questions
  }

  return pool.slice(0, target).map((p, i) => questionFromTopic(p.topic, p.question, i, pool.length));
}

function norm(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[–—]/g, '-');
}

function dedupe(items: string[], limit = 5): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const value = raw.replace(/\s+/g, ' ').trim();
    if (!value) continue;
    const key = norm(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function isPlatformSupportQuestionText(text: string): boolean {
  return (
    /(платформ|фреймворк|framework)/.test(text) &&
    /(поддерж|развив|support|maintenance)/.test(text) &&
    /(автотест|automation|test)/.test(text)
  );
}

/**
 * Обратно-совместимый реэкспорт: сигналы концепта из вопроса теперь живут в
 * data-driven conceptSignals.ts и покрывают много ролей (Python, JS/Frontend,
 * SQL, Docker, REST, system design), а не только Python.
 */
export function pythonConceptSignals(question: string): string[] | null {
  return conceptSignalsForQuestion(question);
}

function domainSignalsForQuestion(topic: InterviewTopic, question: string): string[] | null {
  // Same rule as buildBridgeAnswer: classify from topic title + the actual
  // question, not the whole-topic expectedKnowledge summary — otherwise every
  // question under a topic gets graded against the SAME generic signal list,
  // even when that topic's sample questions test genuinely different things.
  const text = norm(`${topic.title} ${question}`);
  // Конкретный технический концепт определяем по самому ВОПРОСУ (не по теме),
  // иначе все вопросы под темой грейдятся по одному generic-чеклисту.
  const concept = conceptSignalsForQuestion(question);
  if (concept) return concept;
  if (isPlaywrightVsSeleniumQuestion(text)) {
    return [
      'встроенный auto-wait вместо explicit wait',
      'web-first assertions с retry',
      'работа с shadow DOM и динамическим контентом',
      'скорость и протокол без classic WebDriver',
      'trace viewer и встроенный debugging/pause',
    ];
  }
  if (isPlatformSupportQuestionText(text)) {
    return [
      'UI-автоматизация',
      'API-клиенты и проверки',
      'pytest-xdist и параллельные запуски',
      'валидация данных и модели',
      'отчётность и CI/CD',
    ];
  }

  const asksToolChoice =
    /(выбор|выбира|выбрать|фактор)/.test(text) &&
    /(инструмент|tool|автоматизац|тест)/.test(text);
  if (asksToolChoice) {
    return [
      'тип тестов и задача',
      'стек проекта и команды',
      'поддерживаемость инструмента',
      'интеграция с CI/CD',
      'отчётность и разбор падений',
    ];
  }
  return null;
}

function sanitizeSignal(raw: string): string | null {
  const cleaned = raw
    .replace(/^[\s\-–—•·*\d.)]+/, '')
    .replace(/[.,;:]+$/g, '')
    .replace(/^(кандидат\s+)?(должен|должна|должны)\s+(объяснить|рассказать|показать)\s+/i, '')
    .replace(/^(candidate\s+)?(should|must)\s+(explain|describe|show)\s+/i, '')
    .trim();
  if (!cleaned) return null;
  const low = norm(cleaned);
  if (SIGNAL_STOP_WORDS.has(low)) return null;
  if (cleaned.length < 3) return null;
  return cleaned;
}

function signalsFromTopic(topic: InterviewTopic, question: string): string[] {
  const domainSignals = domainSignalsForQuestion(topic, question);
  if (domainSignals) return domainSignals;

  const fromPoints = (topic.expectedAnswerPoints ?? [])
    .map(sanitizeSignal)
    .filter((s): s is string => Boolean(s));
  if (fromPoints.length) return dedupe(fromPoints, 5);

  const phraseCandidates = [
    ...(topic.relatedVacancyTopics ?? []),
    topic.title,
    topic.vacancyEvidence,
  ]
    .map(sanitizeSignal)
    .filter((s): s is string => Boolean(s));

  const wordCandidates = topic.expectedKnowledge
    .replace(/[.,;:()]/g, ' ')
    .split(/\s+/)
    .map(sanitizeSignal)
    .filter((s): s is string => Boolean(s))
    .filter((s) => !SIGNAL_STOP_WORDS.has(norm(s)));

  return dedupe([...phraseCandidates, ...wordCandidates], 5);
}

/** Build a SmokeQuestion from a topic, carrying its interviewer metadata. */
function questionFromTopic(
  topic: InterviewTopic,
  question: string,
  index: number,
  total: number,
): SmokeQuestion {
  const signals = signalsFromTopic(topic, question);
  return {
    id: uid(),
    topicId: topic.id,
    question,
    difficulty: difficultyForIndex(index, total),
    expectedSignals: signals,
    redFlags: ['слишком общий ответ без конкретики', 'заявлен опыт без примера'],
    level: topic.level,
    whyAsked: topic.whyAsked,
    expectedAnswerPoints: topic.expectedAnswerPoints,
    relatedVacancyTopics: topic.relatedVacancyTopics,
    relatedResumeEvidence: topic.relatedResumeEvidence,
  };
}

/** Максимум дожимов подряд: вопрос → дожим → дожим, дальше интервьюер отпускает. */
export const MAX_DRILL_DEPTH = 2;

/** Глубина цепочки дожимов над вопросом (0 — обычный вопрос плана). */
export function drillDepth(question: SmokeQuestion, questions: SmokeQuestion[]): number {
  let depth = 0;
  let cur: SmokeQuestion | undefined = question;
  while (cur?.parentQuestionId && depth <= questions.length) {
    depth += 1;
    const parentId: string = cur.parentQuestionId;
    cur = questions.find((q) => q.id === parentId);
  }
  return depth;
}

/**
 * Дожим интервьюера: превращает уточняющий вопрос из оценки в полноценный
 * SmokeQuestion той же темы. Сигналы — то, чего не хватило в родительском
 * ответе (missingPoints), поэтому оценка дожима проверяет именно пробел.
 */
export function buildDrillDownQuestion(
  parent: SmokeQuestion,
  followUpText: string,
  evaluation?: SmokeAnswerEvaluation,
): SmokeQuestion {
  const missing = (evaluation?.missingPoints ?? []).filter(Boolean).slice(0, 5);
  return {
    id: uid(),
    topicId: parent.topicId,
    question: followUpText,
    difficulty: 'hard',
    expectedSignals: missing.length ? missing : parent.expectedSignals,
    redFlags: parent.redFlags,
    level: parent.level,
    whyAsked:
      'Интервьюер дожимает после вашего прошлого ответа — проверяет глубину, а не заученную формулировку.',
    expectedAnswerPoints: missing.length ? missing : undefined,
    relatedVacancyTopics: parent.relatedVacancyTopics,
    relatedResumeEvidence: parent.relatedResumeEvidence,
    isFollowUp: true,
    parentQuestionId: parent.id,
  };
}

/**
 * Next round: ≤4 questions focused on the weakest topics after a first pass, or
 * on one specific topic when `topicId` is given ("Повторить тему").
 * Weakest = lowest topic scores in the report, falling back to high-importance
 * topics if there's no report yet.
 */
export function buildFollowUpRound(session: SmokeReviewSession, topicId?: string): SmokeQuestion[] {
  const analysis = session.vacancyAnalysis;
  const byId = new Map(analysis.interviewTopics.map((t) => [t.id, t]));
  const askedQuestions = new Set(session.questions.map((q) => q.question));

  if (topicId) {
    const topic = byId.get(topicId);
    if (!topic) return [];
    // Reuse every sample question for this one topic (fresh ones first) so a
    // single-topic repeat still gives up to 4 questions, not just one.
    const fresh = topic.sampleQuestions.filter((q) => !askedQuestions.has(q));
    const asked = topic.sampleQuestions.filter((q) => askedQuestions.has(q));
    const ordered = [...fresh, ...asked].slice(0, 4);
    const pool = ordered.length ? ordered : ['Расскажи про эту тему.'];
    return pool.map((q, i) => questionFromTopic(topic, q, i, pool.length));
  }

  const weakIds = session.report?.topicScores
    ? [...session.report.topicScores]
        .sort((a, b) => a.score - b.score)
        .slice(0, 4)
        .map((t) => t.topicId)
    : analysis.interviewTopics
        .filter((t) => t.importance === 'high')
        .slice(0, 4)
        .map((t) => t.id);

  const picked = weakIds.map((id) => byId.get(id)).filter((t): t is InterviewTopic => Boolean(t));
  const topics = picked.length ? picked : analysis.interviewTopics.slice(0, 4);

  // Prefer a not-yet-asked sample question per topic; else reuse the first.
  return topics.slice(0, 4).map((topic, i) => {
    const freshQ = topic.sampleQuestions.find((q) => !askedQuestions.has(q));
    return questionFromTopic(topic, freshQ || topic.sampleQuestions[0] || 'Расскажи про эту тему.', i, 4);
  });
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function aliasesForSignal(signal: string): string[] {
  const low = norm(signal);
  const aliases = [signal];
  if (/\bwaits?\b|wait/.test(low)) {
    aliases.push('явные ожидания', 'ожидания', 'ожидание', 'wait', 'auto-wait');
  }
  if (/тип тест|задач/.test(low)) {
    aliases.push('api', 'ui', 'e2e', 'интеграцион', 'регресс', 'smoke', 'тест');
  }
  if (/ui|интерфейс|локатор|автоматизац/.test(low)) {
    aliases.push('playwright', 'selenium', 'xpath', 'locator', 'локатор');
  }
  if (/api|клиент|контракт|провер/.test(low)) {
    aliases.push('api', 'requests', 'request', 'httpx', 'postman', 'контракт', 'payload');
  }
  if (/xdist|параллель|запуск/.test(low)) {
    aliases.push('xdist', 'xdisk', 'pytest-xdist', 'параллель');
  }
  if (/валид|модел|данн|schema|схем/.test(low)) {
    aliases.push('pydantic', 'pydentic', 'schema', 'схем', 'модел');
  }
  if (/стек|команд/.test(low)) {
    aliases.push('python', 'pytest', 'requests', 'request', 'httpx', 'playwright', 'selenium', 'docker');
  }
  if (/поддерж|зрел|стабил/.test(low)) {
    aliases.push('поддерж', 'стабил', 'удобн', 'зрел', 'новый', 'комьюнити');
  }
  if (/ci|cd|пайплайн|интеграц/.test(low)) {
    aliases.push('ci/cd', 'cicd', 'gitlab', 'jenkins', 'pipeline', 'пайплайн');
  }
  if (/отчет|отчёт|разбор|лог|паден|debug|дебаг/.test(low)) {
    aliases.push('allure', 'отчет', 'отчёт', 'лог', 'артефакт', 'скриншот', 'паден');
  }
  for (const tool of TOOL_ALIASES) {
    if (low.includes(norm(tool.label))) aliases.push(tool.label);
  }
  return dedupe(aliases, 16);
}

const SEMANTIC_SIGNAL_RULES: Array<{ label: string; signal: RegExp; answer: RegExp }> = [
  {
    label: 'waits',
    signal: /\bwaits?\b|ожидан|wait/i,
    answer: /явн[а-я\w]*\s+ожидан|auto-?wait|waitfor|жд(у|ать|ал|ала|ем)|ожида(ю|л|ем)|состояни[а-я\w]+\s+элемент/i,
  },
  {
    label: 'schema/body checks',
    signal: /schema|body|схем|модел|тип[а-я\w]*\s+пол|обязательн[а-я\w]*\s+пол|response/i,
    answer: /schema|body|pydantic|pydentic|схем|модел|тип[а-я\w]*\s+пол|обязательн[а-я\w]*\s+пол|json|структур/i,
  },
  {
    label: 'auth',
    signal: /\bauth\b|authorization|headers?|token|прав[а-я\w]*\s+доступ|авторизац/i,
    answer: /headers?|token|jwt|bearer|авторизац|аутентификац|прав[а-я\w]*\s+доступ|роль|401|403/i,
  },
  {
    label: 'negative cases',
    signal: /negative|негатив|ошибк|валидац|400|401|403|404|409|422|500/i,
    answer: /negative|негатив|невалид|ошибк[а-я\w]*\s+валидац|400|401|403|404|409|422|500|bad request|forbidden|unauthorized/i,
  },
  {
    label: 'state verification',
    signal: /state|состояни|созданн|удален|после post|после delete|get после/i,
    answer: /get после|после post|после delete|провер[а-я\w]*\s+создан|провер[а-я\w]*\s+удален|состояни|данн[а-я\w]+\s+сохранил/i,
  },
  {
    label: 'conflict resolution',
    signal: /conflict|конфликт|resolve/i,
    answer: /мерч-?конфликт|merge conflict|конфликт[а-я\w]*\s+в\s+файл|ide|консол|resolve|разбирал[а-я\w]*\s+конфликт/i,
  },
  {
    label: 'merge',
    signal: /\bmerge\b|мерж|объедин/i,
    answer: /\bmerge\b|мерж|объедин[а-я\w]*\s+ветк|merge commit/i,
  },
  {
    label: 'rebase',
    signal: /\brebase\b|ребейз|линейн/i,
    answer: /\brebase\b|ребейз|поверх\s+(main|develop|актуальн)|линейн[а-я\w]*\s+истор/i,
  },
  {
    label: 'ci/cd artifacts',
    signal: /artifact|report|allure|лог|отч[её]т|скрин|junit/i,
    answer: /artifact|артефакт|allure|лог|отч[её]т|скрин|junit|diff/i,
  },
  {
    label: 'ci/cd triggers',
    signal: /manual|nightly|schedule|trigger|запуск|распис/i,
    answer: /manual|вручн|nightly|schedule|scheduled|распис|pytest\s+-m|smoke|regression|pipeline/i,
  },
  {
    label: 'ci/cd stages/jobs',
    signal: /stage|job|pipeline|пайплайн/i,
    answer: /stage|job|pipeline|пайплайн|gitlab yaml|\.gitlab-ci\.yml/i,
  },
  {
    label: 'Teamwork',
    signal: /teamwork|team|collaboration|manual qa|tester|developer|analyst|команд|тестировщик|manual\s*qa|разработчик|аналитик/i,
    answer: /manual\s*qa|tester|developer|analyst|команд|тестировщик|тестировщики|разработчик|разработчики|аналитик|аналитиком|вместе|договорил|обсудил/i,
  },
  {
    label: 'Conflict',
    signal: /conflict|disagreement|pressure|lack of resources|competing priorities|task\/conflict|спор|конфликт|давлен|приоритет|ожидан|ресурс|сложн/i,
    answer: /спор|конфликт|разноглас|разные\s+ожидания|давлен|не\s+хватал[а-я\w]*\s+ресурс|приоритет|хотел[а-я\w]*\s+быстрее|видел[а-я\w]*\s+риск|сложн/i,
  },
  {
    label: 'Ownership',
    signal: /ownership|action|decision|responsibility|analysis|prioriti[sz]ation|implementation|действ|решени|ответствен|анализ|приорит|реализац/i,
    answer: /взял[а-я\w]*\s+на\s+себя|предложил|решил|сделал|договорил|проанализировал|анализ\s+паден|приоритиз|реализовал|внедрил|отвечал/i,
  },
  {
    label: 'Real example',
    signal: /real example|specific example|project|scenario|domain|tool|пример|проект|сценар|домен|инструмент/i,
    answer: /на\s+проекте|в\s+проекте|личн[а-я\w]*\s+кабинет|релиз|api|smoke|regression|playwright|pytest|allure|gitlab|docker|сценар/i,
  },
  {
    label: 'Result',
    signal: /result|outcome|changed|effect|результат|эффект|изменил|что\s+изменилось/i,
    answer: /в\s+результате|после\s+этого|итог|эффект|стало|изменил|релиз\s+не\s+блок|вынесли\s+в\s+отдельн|снизил|ускорил|стабилизир/i,
  },
];

function semanticRuleMatchesSignal(rule: (typeof SEMANTIC_SIGNAL_RULES)[number], signal: string): boolean {
  return rule.signal.test(norm(signal)) || norm(signal).includes(norm(rule.label));
}

function semanticMatchesAnswer(signal: string, answer: string): boolean {
  const lowAnswer = norm(answer);
  return SEMANTIC_SIGNAL_RULES.some(
    (rule) => semanticRuleMatchesSignal(rule, signal) && rule.answer.test(lowAnswer),
  );
}

function semanticCoveredLabels(expectedSignals: string[], answer: string): string[] {
  const covered: string[] = [];
  for (const signal of expectedSignals) {
    if (!semanticMatchesAnswer(signal, answer)) continue;
    const rule = SEMANTIC_SIGNAL_RULES.find((r) => semanticRuleMatchesSignal(r, signal));
    covered.push(rule?.label ?? signal);
  }
  return dedupe(covered, 8);
}

function signalMatchesAnswer(signal: string, answer: string): boolean {
  const lowAnswer = norm(answer);
  const aliasMatch = aliasesForSignal(signal).some((alias) => {
    const lowAlias = norm(alias);
    if (lowAlias.length < 3) return false;
    return lowAnswer.includes(lowAlias);
  });
  return aliasMatch || semanticMatchesAnswer(signal, answer);
}

function isLeadershipOrProjectQuestion(topic: InterviewTopic | undefined, question: SmokeQuestion): boolean {
  const text = norm(`${topic?.title ?? ''} ${topic?.category ?? ''} ${question.question}`);
  return (
    /(lead|лид|тимлид|team\s*lead|руковод|people\s*manager|ментор|наставн|команд|управлял|ownership|ответственн|роль в проекте|проектный опыт|опыт работы|свой проект)/.test(
      text,
    ) && !/(выбор|выбира|выбрать|фактор).{0,60}(инструмент|tool)/.test(text)
  );
}

// "Tell me about your project/role" is NOT a conflict story — must be checked
// before isBehavioralQuestionText, which would otherwise claim it (its trigger
// list includes "ownership", present in nearly every project-experience topic).
function isProjectExperienceQuestionText(text: string): boolean {
  const t = norm(text);
  return /расскаж[а-я\w]*\s+(?:мне\s+)?(?:про|о|об)\s+проект|самый\s+показательн[а-я\w]*\s+проект|(?:тво[а-я\w]+|ваш[а-я\w]*)\s+рол[а-я\w]+\s+в\s+проект|что\s+делал[а-я\w]*\s+на\s+(?:последнем|прошлом|текущем)\s+(?:месте|проекте)|опиши\s+проект|проект\s+из\s+резюме|с\s+каким\s+стеком|за\s+что\s+отвечал/.test(
    t,
  );
}

function buildProjectExperienceAnswer(analysis: VacancyAnalysis, answerText: string): string {
  const corpus = `${analysis.resumeText ?? ''}\n${analysis.vacancyText ?? ''}\n${answerText}`;
  const tools = mentionedToolsFrom(corpus);
  const toolText = tools.length ? ` Стек: ${tools.slice(0, 5).join(', ')}.` : '';
  const hasOwnershipLanguage = /выбира|принима[а-я\w]*\s+решени|внедри|разрабатыва|отвечал[а-я\w]*\s+за|в моей зоне|с нуля/i.test(
    answerText || '',
  );
  const role = hasOwnershipLanguage
    ? 'Моя роль была преимущественно технической: я участвовал в выборе решений по автоматизации и отвечал за практическую часть.'
    : 'Роль была технической, без преувеличения — полноценным people manager я себя не называю.';
  const roleText = analysis.targetRole ? ` под роль «${analysis.targetRole}»` : '';
  return `Самый показательный проект для меня — тот, где я на практике применял релевантный опыт${roleText}. ${role}${toolText} Точных цифр сейчас не приведу, но эффект был в более понятной поддержке автотестов и ускоренном разборе падений.`;
}

function isBehavioralQuestionText(text: string): boolean {
  return /behavior|star|teamwork|conflict|ownership|сложн|ситуац|команд|конфликт|спор|приоритет|ответствен|расскаж.*пример/i.test(
    norm(text),
  );
}

function buildBehavioralAnswer(answerText: string): string {
  const text = answerText || '';
  const team = /manual\s*qa|разработчик|аналитик|tester|developer|analyst/i.test(text)
    ? 'с manual QA, разработчиками и аналитиком'
    : 'с командой';
  const conflict = /спор|приоритет|ожидан|релиз|conflict|disagreement/i.test(text)
    ? 'был спор по приоритетам и ожиданиям перед релизом'
    : 'была неоднозначность по ожиданиям и приоритетам';
  const action = /взял|предложил|договорил|анализ|решил|prioriti|decid|propos/i.test(text)
    ? 'я взял на себя анализ, предложил конкретный подход и договорился о следующем шаге'
    : 'я разобрал ситуацию, предложил подход и помог согласовать следующий шаг';
  const result = /в результате|итог|после этого|result|outcome|вынесли/i.test(text)
    ? 'В результате стало понятнее, что делать дальше, и спорные проверки вынесли в отдельный план.'
    : 'Точных цифр сейчас не приведу, но эффект был в более понятном плане действий и меньшем количестве спорных решений.';

  return `Одна из сложных ситуаций была на проекте, где я работал ${team}. Контекст был в том, что ${conflict}. ${action}. ${result}`;
}

/**
 * Evaluate one answer. Tries the real LLM (/vacancy/evaluate); falls back to the
 * deterministic heuristic if the backend/model is unavailable.
 */
export async function evaluateAnswer(
  question: SmokeQuestion,
  answerText: string,
  analysis: VacancyAnalysis,
): Promise<SmokeAnswerEvaluation> {
  const text = cleanVoiceAnswerTranscriptText(answerText || '').trim();
  if (text) {
    try {
      const topic = analysis.interviewTopics.find((t) => t.id === question.topicId);
      const r = await api.vacancyEvaluate({
        question: question.question,
        answer: text,
        topic: topic?.title,
        level: question.level,
        expectedSignals: question.expectedSignals,
        relatedResumeEvidence: question.relatedResumeEvidence,
        resumeText: analysis.resumeText,
        vacancyText: analysis.vacancyText,
        legendText: analysis.legendText,
        language: analysis.language,
        hasResume: analysis.hasResume,
      });
      return {
        questionId: question.id,
        score: r.score,
        clarityScore: r.clarityScore,
        technicalAccuracyScore: r.technicalAccuracyScore,
        specificityScore: r.specificityScore,
        confidenceScore: r.confidenceScore,
        feedback: r.feedback,
        goodPoints: r.goodPoints ?? [],
        missingPoints: r.missingPoints ?? [],
        suggestedBetterAnswer: r.suggestedBetterAnswer,
        overclaimed: r.overclaimed,
        levelEstimate: asQuestionLevel(r.levelEstimate),
        verdict: r.verdict || undefined,
        weakPoints: r.weakPoints?.length ? r.weakPoints : undefined,
        technicalCorrections: r.technicalCorrections?.length ? r.technicalCorrections : undefined,
        betterStructure: r.betterStructure?.length ? r.betterStructure : undefined,
        followUpQuestions: r.followUpQuestions?.length ? r.followUpQuestions : undefined,
        nextTrainingFocus: r.nextTrainingFocus || undefined,
        technicalContentScore: r.technicalContentScore,
        projectSpecificityScore: r.projectSpecificityScore,
        leadershipScore: r.leadershipScore,
        ownershipScore: r.ownershipScore,
        structureScore: r.structureScore,
        speechClarityScore: r.speechClarityScore,
        detectedNoiseOrAsrErrors: r.detectedNoiseOrAsrErrors?.length
          ? r.detectedNoiseOrAsrErrors
          : undefined,
        extractedValidPoints: r.extractedValidPoints?.length ? r.extractedValidPoints : undefined,
        hallucinationGuard: r.hallucinationGuard?.length ? r.hallucinationGuard : undefined,
        coverageScore: r.coverageScore,
        normalizedAnswerSummary: r.normalizedAnswerSummary || undefined,
        evaluationSource: 'ai',
      };
    } catch (err) {
      // Причину не глотаем — она нужна для честного сообщения пользователю.
      const msg = err instanceof Error ? err.message : String(err);
      const reason: SmokeAnswerEvaluation['evaluationError'] = /слишком много времени|timeout|не отвечает/i.test(
        msg,
      )
        ? 'timeout'
        : /лимит|quota|402/i.test(msg)
          ? 'quota'
          : 'error';
      return { ...evaluateAnswerMock(question, answerText, analysis), evaluationError: reason };
    }
  }
  return evaluateAnswerMock(question, answerText, analysis);
}

/** Deterministic fallback evaluation (no backend). */
export function evaluateAnswerMock(
  question: SmokeQuestion,
  answerText: string,
  analysis: VacancyAnalysis,
): SmokeAnswerEvaluation {
  const text = (answerText || '').trim();
  const words = text ? text.split(/\s+/).length : 0;

  // Preprocess ASR/noise first — noise is a speech-quality issue, not a tech error.
  // Then reconstruct distorted technical terms (e.g. "филокит" -> "flaky
  // tests") so semantic matching runs on the intended meaning, not raw ASR.
  const detectedNoise = detectNoise(text);
  const strippedText = stripNoise(text, detectedNoise);
  // Keep the transcript exactly as OpenAI Mini returned it. Only clearly
  // unrelated recording noise is excluded from scoring.
  const cleanText = strippedText;
  const cleanLower = cleanText.toLowerCase();
  const mentioned = question.expectedSignals.filter((s) => signalMatchesAnswer(s, cleanText));
  const missingPoints = question.expectedSignals.filter((s) => !signalMatchesAnswer(s, cleanText));
  const semanticCovered = semanticCoveredLabels(question.expectedSignals, cleanText);

  const clarityScore = clamp(words === 0 ? 0 : Math.min(100, 30 + words * 1.6));
  const technicalAccuracyScore = clamp(
    question.expectedSignals.length
      ? (mentioned.length / question.expectedSignals.length) * 100
      : Math.min(100, words * 2),
  );
  const specificityScore = clamp((SPECIFIC_RE.test(cleanText) ? 70 : 25) + Math.min(25, words / 4));
  const confidenceScore = clamp((HEDGE_RE.test(text) ? 35 : 70) + (/(я |мы )/i.test(text) ? 15 : 0));
  // Speech clarity drops with each noise fragment, independent of content.
  const speechClarityScore = clamp(
    (words === 0 ? 0 : 88) - detectedNoise.length * 18 - (HEDGE_RE.test(text) ? 8 : 0),
  );

  // Leadership: only graded for leadership/project questions, and only if the
  // candidate actually showed role + ownership + result (not just right terms).
  const topic = analysis.interviewTopics.find((t) => t.id === question.topicId);
  const isBehavioralQ = isBehavioralQuestionText(
    `${topic?.title ?? ''} ${topic?.category ?? ''} ${topic?.expectedKnowledge ?? ''} ${question.question}`,
  );
  const isLeadershipQ = isLeadershipOrProjectQuestion(topic, question);
  let leadershipScore: number | undefined;
  if (isLeadershipQ && words > 0) {
    const role = LEADERSHIP_ROLE_RE.test(cleanLower) ? 1 : 0;
    const team = LEADERSHIP_TEAM_RE.test(cleanLower) ? 1 : 0;
    const result = RESULT_RE.test(cleanLower) ? 1 : 0;
    const tools = SPECIFIC_RE.test(cleanText) ? 1 : 0;
    leadershipScore = clamp(18 + (role + team + result + tools) * 20);
  }

  const score = clamp(
    isLeadershipQ && leadershipScore !== undefined
      ? technicalAccuracyScore * 0.3 +
          specificityScore * 0.25 +
          leadershipScore * 0.3 +
          clarityScore * 0.15
      : technicalAccuracyScore * 0.4 +
          specificityScore * 0.25 +
          clarityScore * 0.2 +
          confidenceScore * 0.15,
  );

  // Over-claim: confidently claims hands-on experience without resume context.
  const overclaimed =
    !analysis.hasResume && /(я (?:настраивал|внедрял|строил|делал)|большой опыт|постоянно)/i.test(text);

  const goodPoints: string[] = [];
  if (mentioned.length) goodPoints.push(`Упомянул: ${mentioned.join(', ')}`);
  if (semanticCovered.length) goodPoints.push(`Семантически покрыл: ${semanticCovered.join(', ')}`);
  if (SPECIFIC_RE.test(text)) goodPoints.push('Есть конкретика (инструменты/действия)');
  if (!HEDGE_RE.test(text) && words > 8) goodPoints.push('Уверенная подача');

  let feedback: string;
  if (words === 0) {
    feedback = 'Ответа нет — вопрос пропущен.';
  } else if (score >= 75) {
    feedback = 'Сильный ответ: по делу, с конкретикой и уверенно.';
  } else if (score >= 55) {
    feedback = 'Неплохо, но не хватает конкретных шагов и примеров из практики.';
  } else if (score >= 35) {
    feedback = 'Слишком общий ответ — добавь инструменты, действия и реальный пример.';
  } else {
    feedback = 'Ответ поверхностный или мимо темы — тему стоит подтянуть.';
  }
  if (overclaimed) {
    feedback +=
      ' Заявлен сильный опыт, но он не подтверждён резюме — лучше честный bridging-ответ.';
  }
  if (detectedNoise.length) {
    feedback += ` В записи есть шум распознавания — это не техническая ошибка, но мешает подаче.`;
  }

  const suggestedBetterAnswer = buildBridgeAnswer(question, missingPoints, analysis, cleanText);

  // Weak points: distinct from "missing" — these are quality issues in what WAS said.
  const weakPoints: string[] = [];
  if (words > 0 && words < 25) weakPoints.push('Ответ короткий — не раскрыта глубина.');
  if (!SPECIFIC_RE.test(cleanText)) weakPoints.push('Нет конкретных инструментов и действий.');
  if (!/(проект|компан|у нас|я настро|я внедр|я сдела|в работе)/i.test(cleanText))
    weakPoints.push('Нет примера из реального проекта.');
  if (isLeadershipQ && (leadershipScore ?? 0) < 50)
    weakPoints.push('Лидерская роль не раскрыта: нет задачи, зоны ответственности и результата.');
  if (HEDGE_RE.test(text)) weakPoints.push('Много неуверенных формулировок.');

  // STAR + Engineering for leadership/project questions; plain structure otherwise.
  const betterStructure = isBehavioralQ
    ? [
        'Situation — what was the context?',
        'Task/Conflict — what was difficult or disputed?',
        'Action — what exactly did you do?',
        'Result — what changed after that?',
      ]
    : isLeadershipQ
      ? [
        'Context — что за проект и домен.',
        'Role — твоя роль без преувеличения (тех-лид vs people manager).',
        'Problem — какие были проблемы в автоматизации.',
        'Actions — что именно ты сделал.',
        'Tools — какие инструменты использовал.',
        'Result — практический эффект, без выдуманных цифр.',
        'Reflection — что улучшил бы дальше / ограничения.',
      ]
    : [
        'Краткий вывод — ответь на вопрос одним предложением.',
        'Контекст проекта — где и с чем работал.',
        'Задача или проблема, которую решал.',
        'Что именно сделал ты.',
        'Инструменты и подход.',
        'Результат — что изменилось, без выдуманных метрик.',
        'Ограничение или вывод.',
      ];

  // Recovered signal from a possibly noisy/rambling answer.
  const extractedValidPoints: string[] = mentioned.map((m) => `Затронул: ${m}`);
  semanticCovered.forEach((m) => extractedValidPoints.push(`Семантически покрыл: ${m}`));
  if (SPECIFIC_RE.test(cleanText)) extractedValidPoints.push('Назвал конкретные инструменты/действия.');
  if (isLeadershipQ && LEADERSHIP_ROLE_RE.test(cleanLower))
    extractedValidPoints.push('Обозначил свою роль в проекте.');

  // What the stronger answer must NOT fabricate.
  const hallucinationGuard: string[] = [
    'Без выдуманных числовых метрик — если цифр нет, честно «точных цифр сейчас не приведу».',
    'Только инструменты из вакансии, резюме и ответа.',
  ];
  if (isLeadershipQ) {
    hallucinationGuard.push(
      'Без роли people manager, менторинга и обучения команды, если это не подтверждено — только техническое лидерство.',
    );
  }

  const followUpQuestions = missingPoints
    .slice(0, 3)
    .map((m) => `Уточни: как именно ты работал с «${m}»?`);
  if (!followUpQuestions.length && topic) {
    followUpQuestions.push(`Приведи конкретный пример по теме «${topic.title}».`);
  }

  const nextTrainingFocus = topic
    ? `Проработай «${topic.title}»${
        missingPoints.length ? `: ${missingPoints.slice(0, 3).join(', ')}` : ''
      } на конкретном примере из практики.`
    : 'Добавляй в ответы конкретику и пример из проекта.';

  const levelEstimate: QuestionLevel =
    score >= 85 ? 'lead' : score >= 70 ? 'senior' : score >= 42 ? 'middle' : 'junior';

  const verdict =
    words === 0
      ? 'Пропуск — ответа нет.'
      : isLeadershipQ && (leadershipScore ?? 0) < 50
        ? 'По содержанию база есть, но до Lead-уровня не дотягивает: не раскрыты роль, ответственность и результат.'
        : score >= 75
          ? 'Сильный, уверенный ответ по делу.'
          : score >= 55
            ? 'Нормально, но не хватает конкретики и примера.'
            : 'Пока слабо — тему нужно подтянуть и приземлить на практику.';

  return {
    questionId: question.id,
    score,
    clarityScore,
    technicalAccuracyScore,
    specificityScore,
    confidenceScore,
    feedback,
    missingPoints,
    goodPoints,
    suggestedBetterAnswer,
    overclaimed,
    levelEstimate,
    verdict,
    weakPoints: weakPoints.length ? weakPoints : undefined,
    betterStructure,
    followUpQuestions: followUpQuestions.length ? followUpQuestions : undefined,
    nextTrainingFocus,
    technicalContentScore: technicalAccuracyScore,
    projectSpecificityScore: specificityScore,
    leadershipScore,
    // ownershipScore is the project_experience_question-rubric sibling of
    // leadershipScore; the mock doesn't classify separately so it mirrors it.
    ownershipScore: leadershipScore,
    structureScore: clarityScore,
    speechClarityScore,
    detectedNoiseOrAsrErrors: detectedNoise.length ? detectedNoise : undefined,
    extractedValidPoints: extractedValidPoints.length ? extractedValidPoints : undefined,
    hallucinationGuard,
    coverageScore: question.expectedSignals.length
      ? clamp(
          (new Set([...mentioned, ...semanticCovered]).size / question.expectedSignals.length) * 100,
        )
      : technicalAccuracyScore,
    normalizedAnswerSummary: cleanText !== text.replace(/\s+/g, ' ').trim() ? cleanText : undefined,
    evaluationSource: 'heuristic',
  };
}

/**
 * Detect ASR/noise fragments in a voice answer: URLs, ad-like inserts and
 * off-topic sentences. These are speech-quality issues, not technical mistakes.
 */
function detectNoise(text: string): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const m of text.match(NOISE_URL_RE) ?? []) {
    const u = m.trim();
    if (u) found.push(u);
  }
  for (const raw of text.split(/[.!?\n•·]+/)) {
    const s = raw.trim();
    if (
      s.length > 3 &&
      (NOISE_PHRASE_RE.test(s) || NOISE_MIC_CHECK_RE.test(s) || NOISE_LONG_FILLER_RE.test(s)) &&
      !found.some((f) => s.includes(f))
    ) {
      found.push(s.length > 80 ? `${s.slice(0, 80)}…` : s);
    }
  }
  return Array.from(new Set(found)).slice(0, 6);
}

/** Remove detected noise fragments so scoring runs on the intended answer. */
function stripNoise(text: string, noise: string[]): string {
  let out = text;
  for (const n of noise) {
    const cleaned = n.replace(/…$/, '');
    if (cleaned) out = out.split(cleaned).join(' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

function mentionedToolsFrom(text: string): string[] {
  const tools: string[] = [];
  for (const tool of TOOL_ALIASES) {
    if (tool.re.test(text)) tools.push(tool.label);
  }
  return dedupe(tools, 8);
}

function buildToolChoiceAnswer(analysis: VacancyAnalysis, answerText: string): string | null {
  const corpus = `${analysis.resumeText ?? ''}\n${analysis.vacancyText ?? ''}\n${answerText}`;
  const tools = mentionedToolsFrom(corpus);
  const apiTools = tools.filter((t) => ['Requests', 'HTTPX', 'Postman'].includes(t));
  const uiTools = tools.filter((t) => ['Playwright', 'Selenium'].includes(t));
  const reportTools = tools.filter((t) => t === 'Allure');
  const ciTools = tools.filter((t) => ['GitLab CI', 'Jenkins'].includes(t));

  const apiPart = apiTools.length ? `для API — ${apiTools.join('/')}` : 'для API — инструмент под контрактные и негативные проверки';
  const uiPart = uiTools.length ? `для UI — ${uiTools.join('/')}` : 'для UI — стабильные локаторы и удобный дебаг';
  const reportPart = reportTools.length ? `для отчётности — ${reportTools.join('/')}` : 'для отчётности — понятные логи и артефакты';
  const ciPart = ciTools.length ? `запуск держал бы в ${ciTools.join('/')}` : 'запуск важно встроить в CI/CD';

  return `Я выбираю инструмент не по принципу «самый новый», а от задачи: что тестируем, какой стек у проекта, насколько инструмент поддерживается командой, как дебажить падения и как он встраивается в CI/CD. В моём опыте ${apiPart}, ${uiPart}, ${reportPart}, а ${ciPart}. Так выбор остаётся практичным и поддерживаемым.`;
}

function buildPlatformSupportAnswer(analysis: VacancyAnalysis, answerText: string): string | null {
  const corpus = `${analysis.resumeText ?? ''}\n${analysis.vacancyText ?? ''}\n${answerText}`;
  const tools = mentionedToolsFrom(corpus);
  const uiTools = tools.filter((t) => ['Playwright', 'Selenium', 'XPath'].includes(t));
  const apiTools = tools.filter((t) => ['Requests', 'HTTPX', 'Postman'].includes(t));
  const runTools = tools.filter((t) => ['pytest', 'pytest-xdist', 'Docker'].includes(t));
  const dataTools = tools.filter((t) => t === 'Pydantic');
  const reportTools = tools.filter((t) => ['Allure', 'GitLab CI', 'Jenkins'].includes(t));

  const parts = [
    uiTools.length ? `UI-слой: ${uiTools.join('/')}` : '',
    apiTools.length ? `API-слой: ${apiTools.join('/')}` : '',
    runTools.length ? `запуски: ${runTools.join('/')}` : '',
    dataTools.length ? `данные и модели: ${dataTools.join('/')}` : '',
    reportTools.length ? `отчёты и CI: ${reportTools.join('/')}` : '',
  ].filter(Boolean);

  return `Для поддержки автотестовой платформы я делил инструменты по слоям, а не просто перечислял стек. ${parts.join(', ')}. Отдельно следил за стабильными локаторами, воспроизводимым запуском и понятным разбором падений через отчёты и логи. XPath использовал точечно, когда не было более стабильного локатора.`;
}

function isGitQuestion(text: string): boolean {
  return /git|merge|rebase|мерж|ребейз|ветк|конфликт/.test(norm(text));
}

function buildGitAnswer(): string {
  return (
    'Merge и rebase — это два способа синхронизировать ветки. Merge объединяет изменения из одной ветки в другую и сохраняет историю ветвления, часто через отдельный merge commit. Rebase переносит мои локальные коммиты поверх актуального состояния main или develop, поэтому история получается более линейной. На практике я чаще использую rebase в feature-ветке перед merge request. Если возникают конфликты, разбираю их в IDE или через консоль и после этого прогоняю тесты.'
  );
}

function isApiQuestion(text: string): boolean {
  return /\bapi\b|апи|status|статус|200|schema|body|контракт|payload/.test(norm(text));
}

function buildApiAnswer(analysis: VacancyAnalysis, answerText: string): string {
  const corpus = `${analysis.resumeText ?? ''}\n${analysis.vacancyText ?? ''}\n${answerText}`;
  const tools = mentionedToolsFrom(corpus).filter((t) => ['Requests', 'HTTPX', 'Postman', 'pytest', 'Pydantic', 'Allure'].includes(t));
  const toolText = tools.length ? ` Из инструментов в моём контексте это ${tools.join(', ')}.` : '';
  return (
    `Кроме статус-кода 200 я проверяю контракт ответа: структуру JSON, обязательные поля, типы данных и бизнес-значения. Отдельно смотрю авторизацию, headers/token, права доступа и негативные кейсы: 400, 401, 403, 404, 409 или ошибки валидации. Если запрос меняет состояние, проверяю это повторным GET или связанным API-вызовом.${toolText} Результат удобно разбирать через логи и Allure-отчёт.`
  );
}

function isFlakyUiQuestion(text: string): boolean {
  return /flaky|нестабил|мига(?:ет|ющ)|retry|ретрай/.test(norm(text));
}

function buildFlakyUiAnswer(analysis: VacancyAnalysis, answerText: string): string {
  const corpus = `${analysis.resumeText ?? ''}\n${analysis.vacancyText ?? ''}\n${answerText}`;
  const tools = mentionedToolsFrom(corpus).filter((t) => ['Playwright', 'Selenium', 'Allure'].includes(t));
  const toolText = tools.length ? ` В моём стеке для этого использовал ${tools.join(', ')}.` : '';
  return (
    `С flaky UI-тестами я сначала разбираю причину, а не просто добавляю retry. Проверяю локаторы, убираю sleep, добавляю явные ожидания нужного состояния элемента или запроса, смотрю скриншоты, логи и traceback падения. Если тест нестабилен из-за данных или окружения, фиксирую это отдельно и временно могу вынести его из критичного smoke-запуска.${toolText}`
  );
}

function isPlaywrightVsSeleniumQuestion(text: string): boolean {
  const t = norm(text);
  return (
    /playwright/.test(t) &&
    /selenium/.test(t) &&
    /(удобн|лучше|преимуществ|отлич|advantage|better|чем.*удобнее)/.test(t)
  );
}

function buildPlaywrightAdvantageAnswer(analysis: VacancyAnalysis, answerText: string): string {
  const corpus = `${analysis.resumeText ?? ''}\n${analysis.vacancyText ?? ''}\n${answerText}`;
  const tools = mentionedToolsFrom(corpus).filter((t) => ['Playwright', 'Selenium'].includes(t));
  const toolText = tools.length ? ` В своей практике использовал ${tools.join(', ')}.` : '';
  return (
    `На динамических интерфейсах Playwright удобнее за счёт встроенных auto-wait и web-first assertions — не нужно вручную писать explicit wait на каждое состояние элемента, как часто приходится в Selenium. Playwright также лучше справляется с shadow DOM и асинхронной подгрузкой контента, использует более быстрый протокол вместо классического WebDriver и даёт из коробки trace viewer, скриншоты и видео падений — это ускоряет дебаг, плюс можно поставить выполнение на паузу и посмотреть состояние страницы вживую.${toolText} При этом Selenium остаётся разумным выбором для legacy-проекта с большой базой тестов — ради смены инструмента я бы её не переписывал, но для нового проекта выбрал бы Playwright.`
  );
}

function buildBridgeAnswer(
  question: SmokeQuestion,
  missing: string[],
  analysis: VacancyAnalysis,
  answerText = '',
): string {
  const topic = analysis.interviewTopics.find((t) => t.id === question.topicId);
  // Classify by topic title + the ACTUAL question asked — not topic.expectedKnowledge,
  // which is a whole-topic summary and can contain words ("flaky", "ownership", ...)
  // that don't apply to every one of that topic's sample questions.
  const topicText = norm(`${topic?.title ?? ''} ${question.question}`);
  if (isProjectExperienceQuestionText(topicText)) {
    return buildProjectExperienceAnswer(analysis, answerText);
  }
  if (isBehavioralQuestionText(topicText)) {
    return buildBehavioralAnswer(answerText);
  }
  if (isGitQuestion(topicText)) {
    return buildGitAnswer();
  }
  if (isApiQuestion(topicText)) {
    return buildApiAnswer(analysis, answerText);
  }
  if (isPlaywrightVsSeleniumQuestion(topicText)) {
    return buildPlaywrightAdvantageAnswer(analysis, answerText);
  }
  if (isFlakyUiQuestion(topicText)) {
    return buildFlakyUiAnswer(analysis, answerText);
  }
  if (isPlatformSupportQuestionText(topicText)) {
    const platformAnswer = buildPlatformSupportAnswer(analysis, answerText);
    if (platformAnswer) return platformAnswer;
  }
  if (domainSignalsForQuestion(topic ?? ({} as InterviewTopic), question.question)) {
    const toolChoiceAnswer = buildToolChoiceAnswer(analysis, answerText);
    if (toolChoiceAnswer) return toolChoiceAnswer;
  }

  const name = topic?.title ?? 'эту тему';
  const focus = missing.slice(0, 3).join(', ');
  const focusText = focus ? ` В этом контексте главное — ${focus}.` : '';
  const base = `Я строю ответ по теме «${name.toLowerCase()}» от задачи и риска: определяю критичные сценарии, что может сломаться и где команде нужна быстрая обратная связь. Для этого выделяю smoke для ключевых путей, regression для изменённых зон и негативные проверки для рискованных мест.${focusText} Точных цифр сейчас не приведу, но эффект был в более понятном плане тестирования и быстрее разборе проблем.`;
  if (!analysis.hasResume) {
    return `${base} Если прямого опыта по этой теме не было, я говорю это честно и показываю, как применил бы близкий опыт без выдуманных деталей.`;
  }
  return base;
}

/**
 * Enrich a deterministic report with the LLM coach narrative (/vacancy/report).
 * Scores stay client-computed; the model adds verdict + a sharper practice plan.
 * Returns the original report untouched if the backend/model is unavailable.
 */
export async function enrichReadinessReport(
  session: SmokeReviewSession,
  report: ReadinessReport,
): Promise<ReadinessReport> {
  if (!report.topicScores.length) return report;
  const analysis = session.vacancyAnalysis;
  try {
    const weakAnswers = session.questions
      .map((q) => {
        const ev = session.answers.find((a) => a.questionId === q.id)?.evaluation;
        if (!ev || ev.score >= 60) return null;
        return { question: q.question, missing: ev.missingPoints.slice(0, 4), score: ev.score };
      })
      .filter((w): w is NonNullable<typeof w> => w !== null)
      .slice(0, 6);
    const r = await api.vacancyReport({
      targetRole: analysis.targetRole,
      seniorityLevel: analysis.seniorityLevel,
      overallScore: report.overallScore,
      topics: report.topicScores.map((t) => ({
        title: t.title,
        score: t.score,
        status: t.status,
        missingPoints: t.missingPoints,
      })),
      weakAnswers,
      resumeText: analysis.resumeText,
      legendText: analysis.legendText,
      vacancyText: analysis.vacancyText,
      language: analysis.language,
    });
    if (!r.verdict) return report;
    return {
      ...report,
      narrativeVerdict: r.verdict,
      interviewerImpression: r.interviewerImpression || undefined,
      focusTopic: r.focusTopic || undefined,
      nextPracticePlan: r.nextPracticePlan?.length ? r.nextPracticePlan : report.nextPracticePlan,
    };
  } catch {
    return report; // офлайн/ошибка модели — детерминированный отчёт уже на экране
  }
}

/** Aggregate answered questions into a readiness report. (LLM seam optional) */
export function buildReadinessReport(session: SmokeReviewSession): ReadinessReport {
  const analysis = session.vacancyAnalysis;
  const byTopic = new Map<string, SmokeAnswerEvaluation[]>();
  for (const q of session.questions) {
    const ans = session.answers.find((a) => a.questionId === q.id);
    if (!ans?.evaluation) continue;
    const list = byTopic.get(q.topicId) ?? [];
    list.push(ans.evaluation);
    byTopic.set(q.topicId, list);
  }

  const topicScores: TopicScore[] = [];
  for (const topic of analysis.interviewTopics) {
    const evals = byTopic.get(topic.id);
    if (!evals || !evals.length) continue;
    const score = Math.round(evals.reduce((s, e) => s + e.score, 0) / evals.length);
    const status = topicStatusFromScore(score);
    const missing = Array.from(new Set(evals.flatMap((e) => e.missingPoints))).slice(0, 4);
    topicScores.push({
      topicId: topic.id,
      title: topic.title,
      category: topic.category,
      score,
      status,
      questionsAsked: evals.length,
      feedback: evals[0].feedback,
      missingPoints: missing,
      nextAction:
        status === 'strong'
          ? `Потренируй edge-кейсы по теме «${topic.title}».`
          : `Прогони 3 вопроса по «${topic.title}»${missing.length ? ` с упором на ${missing.join(', ')}` : ''}.`,
    });
  }

  const overallScore = topicScores.length
    ? Math.round(topicScores.reduce((s, t) => s + t.score, 0) / topicScores.length)
    : 0;

  const strengths = topicScores.filter((t) => t.status === 'strong').map((t) => t.title);
  const weakAreas = topicScores.filter((t) => t.status === 'weak' || t.status === 'medium').map((t) => t.title);
  const criticalGaps = topicScores.filter((t) => t.status === 'critical').map((t) => t.title);

  const nextPracticePlan = [...criticalGaps, ...weakAreas]
    .slice(0, 4)
    .map((title) => `Проработать тему: ${title}`);
  if (!analysis.hasResume)
    nextPracticePlan.push('Подключите резюме, чтобы ответы опирались на реальный опыт.');

  return {
    overallScore,
    status: readinessLabelFromScore(overallScore),
    topicScores,
    strengths,
    weakAreas,
    criticalGaps,
    nextPracticePlan,
    generatedAt: Date.now(),
  };
}
