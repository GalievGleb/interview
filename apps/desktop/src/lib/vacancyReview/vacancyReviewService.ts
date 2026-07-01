/**
 * Vacancy Smoke Review — logic layer (mock AI behind a stable interface).
 *
 * Every function here is the deterministic stand-in for a backend/LLM call. The
 * INPUT/OUTPUT shapes are the contract a real `/vacancy/*` endpoint will honour,
 * so swapping mock → real touches only this module. UI never calls heuristics
 * directly — it goes through these functions.
 */
import { api } from '../api';
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
  if (!input.resumeText) riskAreas.push('Resume context missing — answers can’t be grounded in real experience.');
  if (!input.legendText) riskAreas.push('Legend not connected — bridging answers may sound generic.');
  const highTopics = topics.filter((t) => t.importance === 'high');
  if (highTopics.length) {
    riskAreas.push(`High-weight topics to nail: ${highTopics.map((t) => t.title).join(', ')}.`);
  }
  const gaps = competencies.filter((c) => c.resumeMatch === 'gap' && c.priority !== 'low');
  if (gaps.length) {
    riskAreas.push(`Пробелы против резюме: ${gaps.map((c) => c.name).join(', ')}.`);
  }
  if (!topics.length) riskAreas.push('Could not extract clear topics — paste a fuller vacancy text.');

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
export function buildSmokePlan(analysis: VacancyAnalysis): SmokeQuestion[] {
  // TODO(real-ai): POST /vacancy/plan { analysisId } → grounded questions.
  const topics = analysis.interviewTopics;
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

/** Build a SmokeQuestion from a topic, carrying its interviewer metadata. */
function questionFromTopic(
  topic: InterviewTopic,
  question: string,
  index: number,
  total: number,
): SmokeQuestion {
  const signals =
    topic.expectedAnswerPoints?.length
      ? topic.expectedAnswerPoints.slice(0, 5)
      : topic.expectedKnowledge
          .replace(/[.,]/g, '')
          .split(/\s+/)
          .filter((w) => w.length > 3)
          .slice(0, 5);
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

/**
 * Next round: ≤4 questions focused on the weakest topics after a first pass.
 * Weakest = lowest topic scores in the report, falling back to high-importance
 * topics if there's no report yet.
 */
export function buildFollowUpRound(session: SmokeReviewSession): SmokeQuestion[] {
  const analysis = session.vacancyAnalysis;
  const byId = new Map(analysis.interviewTopics.map((t) => [t.id, t]));
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
  const askedQuestions = new Set(session.questions.map((q) => q.question));
  return topics.slice(0, 4).map((topic, i) => {
    const fresh = topic.sampleQuestions.find((q) => !askedQuestions.has(q));
    return questionFromTopic(topic, fresh || topic.sampleQuestions[0] || 'Расскажи про эту тему.', i, 4);
  });
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
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
  const text = (answerText || '').trim();
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
      };
    } catch {
      // Fall through to the heuristic.
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
  const lower = text.toLowerCase();

  const mentioned = question.expectedSignals.filter((s) => lower.includes(s.toLowerCase()));
  const missingPoints = question.expectedSignals.filter((s) => !lower.includes(s.toLowerCase()));

  const clarityScore = clamp(words === 0 ? 0 : Math.min(100, 30 + words * 1.6));
  const technicalAccuracyScore = clamp(
    question.expectedSignals.length
      ? (mentioned.length / question.expectedSignals.length) * 100
      : Math.min(100, words * 2),
  );
  const specificityScore = clamp((SPECIFIC_RE.test(text) ? 70 : 25) + Math.min(25, words / 4));
  const confidenceScore = clamp((HEDGE_RE.test(text) ? 35 : 70) + (/(я |мы )/i.test(text) ? 15 : 0));

  const score = clamp(
    technicalAccuracyScore * 0.4 +
      specificityScore * 0.25 +
      clarityScore * 0.2 +
      confidenceScore * 0.15,
  );

  // Over-claim: confidently claims hands-on experience without resume context.
  const overclaimed =
    !analysis.hasResume && /(я (?:настраивал|внедрял|строил|делал)|большой опыт|постоянно)/i.test(text);

  const goodPoints: string[] = [];
  if (mentioned.length) goodPoints.push(`Упомянул: ${mentioned.join(', ')}`);
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

  const suggestedBetterAnswer = buildBridgeAnswer(question, missingPoints, analysis);

  // Weak points: distinct from "missing" — these are quality issues in what WAS said.
  const weakPoints: string[] = [];
  if (words > 0 && words < 25) weakPoints.push('Ответ короткий — не раскрыта глубина.');
  if (!SPECIFIC_RE.test(text)) weakPoints.push('Нет конкретных инструментов и действий.');
  if (!/(проект|компан|у нас|я настро|я внедр|я сдела|в работе)/i.test(text))
    weakPoints.push('Нет примера из реального проекта.');
  if (HEDGE_RE.test(text)) weakPoints.push('Много неуверенных формулировок.');

  const betterStructure = [
    'Краткий вывод — ответь на вопрос одним предложением.',
    'Контекст проекта — где и с чем работал.',
    'Задача или проблема, которую решал.',
    'Что именно сделал ты.',
    'Инструменты и подход.',
    'Результат — что изменилось, метрика если есть.',
    'Ограничение или вывод.',
  ];

  const topic = analysis.interviewTopics.find((t) => t.id === question.topicId);
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
    score >= 80 ? 'lead' : score >= 62 ? 'senior' : score >= 42 ? 'middle' : 'junior';

  const verdict =
    words === 0
      ? 'Пропуск — ответа нет.'
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
  };
}

function buildBridgeAnswer(
  question: SmokeQuestion,
  missing: string[],
  analysis: VacancyAnalysis,
): string {
  const topic = analysis.interviewTopics.find((t) => t.id === question.topicId);
  const name = topic?.title ?? 'эту тему';
  const focus = missing.slice(0, 3).join(', ');
  const base = `Прямо отвечаю по сути: коротко объясняю ${name.toLowerCase()}${
    focus ? ` и обязательно упоминаю ${focus}` : ''
  }, затем привожу один конкретный пример из практики (инструмент, действие, результат).`;
  if (!analysis.hasResume) {
    return `${base} Если прямого опыта нет — честно: «В продакшене глубоко с этим не работал, но понимаю идею и могу объяснить, как бы подошёл».`;
  }
  return base;
}

/** Aggregate answered questions into a readiness report. (LLM seam optional) */
export function buildReadinessReport(session: SmokeReviewSession): ReadinessReport {
  // TODO(real-ai): optionally POST /vacancy/report for richer narrative.
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
    .map((title) => `Practice this topic: ${title}`);
  if (!analysis.hasResume) nextPracticePlan.push('Attach your resume so answers can be grounded in real experience.');

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
