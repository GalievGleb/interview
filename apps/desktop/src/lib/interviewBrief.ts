import type { HhQueueItem, InterviewCalendarEvent } from '../types/electron';
import type {
  SmokeReviewSession,
  VacancyAnalysis,
} from './vacancyReview/types';

export interface PreviousHrCallBrief {
  id: string;
  date: string;
  summary: string;
  details: string[];
}

export interface InterviewBrief {
  readinessScore: number | null;
  readinessLabel: string;
  readinessBasis: string;
  stageSummary: string;
  likelyTopics: string[];
  strengths: string[];
  weakAreas: string[];
  studyPlan: string[];
  companyOverview: string[];
  previousHrCalls: PreviousHrCallBrief[];
  sourceSessionId?: string;
  hasVacancyDetails: boolean;
}

export interface BuildInterviewBriefInput {
  event: InterviewCalendarEvent;
  analysis?: VacancyAnalysis | null;
  session?: SmokeReviewSession | null;
  vacancyText?: string;
  preparationNotes?: string[];
  calendarEvents?: InterviewCalendarEvent[];
}

/**
 * A manually created calendar row with only a short title is not evidence of
 * a specific vacancy. Reusing a fuzzy QA match in that case can attach another
 * employer's requirements and produce a convincing but false readiness report.
 */
export function canReuseStoredVacancyContext(event: InterviewCalendarEvent): boolean {
  return event.source === 'hh'
    || Boolean(event.vacancyUrl?.trim())
    || Boolean(event.vacancyDescription?.trim());
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .replace(/[«»"'()[\]{}.,/\\:;!?+_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hhVacancyIdentity(value?: string): string {
  return value?.match(/(?:vacancy\/|vacancyId=)(\d+)/i)?.[1] ?? '';
}

function companyIdentity(value: string): string {
  const legalForms = new Set(['ооо', 'оао', 'пао', 'ао', 'зао', 'ип', 'llc', 'ltd', 'inc']);
  return normalize(value)
    .split(' ')
    .filter((token) => !legalForms.has(token))
    .join(' ');
}

function tokens(value: string): string[] {
  return normalize(value)
    .split(' ')
    .filter((token) => token.length >= 2 && !['engineer', 'инженер', 'разработчик'].includes(token));
}

function tokensMatch(left: string, right: string): boolean {
  return left === right ||
    (left.length >= 3 && right.length >= 3 && (left.startsWith(right) || right.startsWith(left)));
}

function roleSimilarity(left: string, right: string): number {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;
  const smaller = leftTokens.length <= rightTokens.length ? leftTokens : rightTokens;
  const larger = smaller === leftTokens ? rightTokens : leftTokens;
  const matched = smaller.filter((token) => larger.some((candidate) => tokensMatch(token, candidate))).length;
  return matched / smaller.length;
}

function sameCompany(left: string, right: string): boolean {
  const a = companyIdentity(left);
  const b = companyIdentity(right);
  if (!a || !b) return false;
  return a === b || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a)));
}

function dedupe(items: Array<string | undefined>, limit = 6): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const value = String(item ?? '').replace(/\s+/g, ' ').trim();
    if (!value) continue;
    const key = normalize(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

export function findMatchingVacancySession(
  event: Pick<InterviewCalendarEvent, 'vacancyTitle' | 'companyName' | 'sessionId' | 'vacancyUrl'>,
  sessions: SmokeReviewSession[],
): SmokeReviewSession | null {
  if (event.sessionId) {
    const exact = sessions.find((session) => session.id === event.sessionId);
    if (exact) return exact;
  }
  const eventVacancyId = hhVacancyIdentity(event.vacancyUrl);
  if (eventVacancyId) {
    const exactVacancy = sessions.find(
      (session) => hhVacancyIdentity(session.vacancyAnalysis.vacancyUrl) === eventVacancyId,
    );
    if (exactVacancy) return exactVacancy;
  }
  const ranked = sessions.map((session) => {
    const analysis = session.vacancyAnalysis;
    const analysisCompany = analysis.vacancyCompany?.trim() ?? '';
    if (!analysisCompany || !sameCompany(event.companyName, analysisCompany)) {
      return { session, score: Number.NEGATIVE_INFINITY };
    }
    const similarity = roleSimilarity(event.vacancyTitle, analysis.targetRole || analysis.vacancyText.slice(0, 160));
    const reportBonus = session.report ? 2 : 0;
    return { session, score: similarity * 8 + 6 + reportBonus };
  }).sort((left, right) => right.score - left.score || right.session.startedAt - left.session.startedAt);
  return ranked[0] && ranked[0].score >= 5 ? ranked[0].session : null;
}

export function findMatchingQueueItem(
  event: Pick<InterviewCalendarEvent, 'vacancyTitle' | 'companyName'>,
  queue: HhQueueItem[],
): HhQueueItem | null {
  const ranked = queue.map((item) => {
    if (!sameCompany(event.companyName, item.company)) {
      return { item, score: Number.NEGATIVE_INFINITY };
    }
    const similarity = roleSimilarity(event.vacancyTitle, item.title);
    return { item, score: similarity * 8 + 6 };
  }).sort((left, right) => right.score - left.score || +new Date(right.item.addedAt) - +new Date(left.item.addedAt));
  return ranked[0] && ranked[0].score >= 5 ? ranked[0].item : null;
}

function readinessFromAnalysis(analysis?: VacancyAnalysis | null): number | null {
  if (!analysis?.hasResume || !analysis.competencies?.length) return null;
  const matchScore = { strong: 90, partial: 60, gap: 25, unknown: 0 } as const;
  const priorityWeight = { high: 3, medium: 2, low: 1 } as const;
  let weighted = 0;
  let totalWeight = 0;
  for (const competency of analysis.competencies) {
    const weight = priorityWeight[competency.priority];
    weighted += matchScore[competency.resumeMatch] * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? Math.round(weighted / totalWeight) : null;
}

function readinessLabel(score: number | null, hasVacancyDetails: boolean, hasProfile: boolean): string {
  if (score == null && !hasVacancyDetails) return 'Нужны требования вакансии';
  if (score == null && !hasProfile) return 'Нужен профиль кандидата';
  if (score == null) return 'Пока без оценки';
  if (score >= 85) return 'Хорошо готов';
  if (score >= 70) return 'Почти готов';
  if (score >= 50) return 'Нужна точечная подготовка';
  return 'Есть заметные пробелы';
}

function stageSummary(type: InterviewCalendarEvent['type']): string {
  if (type === 'hr') {
    return 'Скорее всего обсудят опыт, мотивацию, формат работы, ожидания по деньгам и следующие этапы.';
  }
  if (type === 'technical') {
    return 'Скорее всего проверят глубину по ключевому стеку, попросят проектные примеры и разберут ваши технические решения.';
  }
  return 'Формат этапа не уточнён: приготовьте короткую самопрезентацию и примеры по главным требованиям вакансии.';
}

function likelyTopics(event: InterviewCalendarEvent, analysis?: VacancyAnalysis | null): string[] {
  if (event.type === 'hr') {
    return [
      'Короткая самопрезентация и релевантный опыт',
      'Почему интересна эта роль и компания',
      'Формат, график, оформление и дата выхода',
      'Зарплатные ожидания',
      'Этапы найма и вопросы к работодателю',
    ];
  }
  const importance = { high: 0, medium: 1, low: 2 } as const;
  return dedupe(
    [...(analysis?.interviewTopics ?? [])]
      .sort((left, right) => importance[left.importance] - importance[right.importance])
      .map((topic) => `${topic.title} — ${topic.whyAsked || topic.expectedKnowledge}`),
    5,
  );
}

function extractCompanyOverview(vacancyText: string, companyName: string): string[] {
  const lines = vacancyText
    .replace(/\r/g, '')
    .split(/\n+|(?<=[.!?])\s+(?=[А-ЯA-Z])/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 35 && line.length <= 360);
  const sectionHeading = /^(?:требования|обязанности|задачи|условия|что предстоит|мы ожидаем|вам предстоит|будет плюсом)\b/i;
  const requirementLine = /(?:обязанност|требован|вы будете|вам предстоит|необходим|должны|ищем специалист|будет плюсом)/i;
  const companyMarker = /(?:компан|продукт|платформ|сервис|рынок|команд|разрабатыва|занимаемся|созда[её]м)/i;
  const company = normalize(companyName);
  const preferred = lines.filter((line) => {
    if (sectionHeading.test(line) || requirementLine.test(line)) return false;
    const normalizedLine = normalize(line);
    return (company && normalizedLine.includes(company)) || companyMarker.test(line);
  });
  return dedupe(preferred.length > 0 ? preferred : lines.filter((line) => !requirementLine.test(line)), 2);
}

function previousHrCalls(
  event: InterviewCalendarEvent,
  calendarEvents: InterviewCalendarEvent[],
): PreviousHrCallBrief[] {
  const now = Date.now();
  return calendarEvents
    .filter((candidate) =>
      candidate.id !== event.id &&
      candidate.type === 'hr' &&
      sameCompany(candidate.companyName, event.companyName) &&
      Boolean(candidate.completedAt || candidate.outcome || +new Date(candidate.endAt) < now),
    )
    .sort((left, right) => +new Date(right.completedAt ?? right.endAt) - +new Date(left.completedAt ?? left.endAt))
    .slice(0, 3)
    .map((candidate) => ({
      id: candidate.id,
      date: candidate.completedAt ?? candidate.endAt,
      summary: candidate.outcome?.headline || candidate.notes || 'Подытог HR-созвона не сохранён.',
      details: dedupe([
        ...(candidate.outcome?.facts ?? []),
        ...(candidate.outcome?.conditions ?? []),
        ...(candidate.outcome?.nextSteps ?? []),
        ...(candidate.outcome?.openQuestions ?? []).map((item) => `Осталось уточнить: ${item}`),
      ], 5),
    }));
}

export function buildInterviewBrief(input: BuildInterviewBriefInput): InterviewBrief {
  const analysis = input.session?.vacancyAnalysis ?? input.analysis ?? null;
  const vacancyText = input.vacancyText || analysis?.vacancyText || '';
  const hasVacancyDetails = vacancyText.trim().length >= 80;
  const evidenceAnalysis = hasVacancyDetails ? analysis : null;
  const report = hasVacancyDetails ? input.session?.report : undefined;
  const score = hasVacancyDetails
    ? report?.overallScore ?? readinessFromAnalysis(evidenceAnalysis)
    : null;
  const strengths = dedupe(
    !hasVacancyDetails
      ? []
      : report?.strengths?.length
      ? report.strengths
      : (evidenceAnalysis?.competencies ?? [])
        .filter((item) => item.resumeMatch === 'strong')
        .map((item) => `${item.name}${item.note ? ` — ${item.note}` : ''}`),
  );
  const weakAreas = dedupe(
    !hasVacancyDetails
      ? []
      : report
      ? [...report.criticalGaps, ...report.weakAreas]
      : evidenceAnalysis?.hasResume ? [
          ...(evidenceAnalysis?.competencies ?? [])
            .filter((item) => item.resumeMatch !== 'strong' && item.priority !== 'low')
            .map((item) => `${item.name} — ${item.note || (item.resumeMatch === 'gap' ? 'нет подтверждения в резюме' : 'нужно углубить')}`),
          ...(evidenceAnalysis?.riskAreas ?? []),
        ] : [],
  );
  const studyPlan = hasVacancyDetails
    ? dedupe([
        ...(report?.nextPracticePlan ?? []),
        ...(report ? [] : (evidenceAnalysis?.interviewTopics ?? [])
          .filter((topic) => topic.importance === 'high')
          .map((topic) => `${topic.title}: ${topic.expectedKnowledge}`)),
        ...(input.preparationNotes ?? []),
      ])
    : [];

  return {
    readinessScore: score,
    readinessLabel: readinessLabel(score, hasVacancyDetails, Boolean(analysis?.hasResume)),
    readinessBasis: report
      ? 'По результатам последнего разбора этой вакансии.'
      : score != null
        ? 'Предварительно: требования вакансии сопоставлены с подтверждённым профилем.'
        : hasVacancyDetails
          ? 'Требования вакансии разобраны, но без профиля кандидата честно оценить готовность нельзя.'
          : 'Добавьте ссылку или описание вакансии — тогда требования можно будет сопоставить с вашим опытом.',
    stageSummary: stageSummary(input.event.type),
    likelyTopics: likelyTopics(input.event, evidenceAnalysis),
    strengths,
    weakAreas,
    studyPlan,
    companyOverview: hasVacancyDetails
      ? extractCompanyOverview(vacancyText, input.event.companyName)
      : [],
    previousHrCalls: previousHrCalls(input.event, input.calendarEvents ?? []),
    sourceSessionId: hasVacancyDetails ? input.session?.id : undefined,
    hasVacancyDetails,
  };
}
