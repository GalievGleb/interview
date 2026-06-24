import type { AppliedCorrection } from './correctTranscriptWithGlossary';
import { QA_GLOSSARY } from './qaGlossary';

/** Canonical terms that start a new topic — never combine with previous topic. */
export const TOPIC_RESET_CANONICAL_TERMS = [
  'Jenkins',
  'Page Object Model',
  'pytest fixtures',
  'CI/CD',
  'Kafka',
  'Docker',
  'Allure Report',
  'Kubernetes',
  'Selenium',
  'Playwright',
  'PUT',
  'PATCH',
  'Linux',
  'HTTP methods',
  'OOP',
  'полиморфизм',
  'инкапсуляция',
  'наследование',
  'абстракция',
  'GitLab CI',
  'REST API',
  'pipeline',
  'flaky tests',
  'smoke testing',
  'regression testing',
] as const;

const NEW_TOPIC_QUESTION_RE =
  /(?:^|\s)(?:что\s+такое|расскаж\w*\s+про|в\s+ч(?:е|ё)м\s+разниц|чем\s+отлича|какие\s+бывают|ты\s+настраивал|как\s+использовал|как\s+применял|скаж\w*\s+про)/iu;

const INCIDENTAL_PIPELINE_RE = /\s(?:в|in)\s+pipeline(?:[?.!,]|$|\s)/iu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termInText(term: string, text: string): boolean {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, 'iu');
  return pattern.test(text);
}

function isIncidentalPipeline(text: string): boolean {
  return INCIDENTAL_PIPELINE_RE.test(text) && !/(?:что\s+такое|расскаж\w*\s+про)\s+pipeline/i.test(text);
}

/** Extracts the primary canonical topic from a corrected question. */
export function extractExplicitCanonicalTopic(
  question: string,
  corrections: AppliedCorrection[] = [],
): string | null {
  const q = question.trim();
  if (!q) return null;

  if (isIncidentalPipeline(q)) {
    return null;
  }

  const correctionTargets = corrections
    .map((c) => c.to.trim())
    .filter(
      (t) =>
        TOPIC_RESET_CANONICAL_TERMS.includes(t as (typeof TOPIC_RESET_CANONICAL_TERMS)[number]) &&
        t.toLowerCase() !== 'pipeline',
    )
    .sort((a, b) => b.length - a.length);
  for (const term of correctionTargets) {
    return term;
  }

  const sorted = [...QA_GLOSSARY]
    .filter((e) => TOPIC_RESET_CANONICAL_TERMS.includes(e.canonical as (typeof TOPIC_RESET_CANONICAL_TERMS)[number]))
    .sort((a, b) => b.canonical.length - a.canonical.length);

  for (const entry of sorted) {
    if (entry.canonical === 'pipeline' && isIncidentalPipeline(q)) continue;
    if (termInText(entry.canonical, q)) {
      return entry.canonical;
    }
  }

  return null;
}

export interface TopicResetResult {
  reset: boolean;
  reason?: string;
  currentTopic: string | null;
  wasPreviousTopicUsed: boolean;
}

/** True when a new explicit topic must replace previous context. */
export function shouldResetPreviousTopic(
  question: string,
  corrections: AppliedCorrection[] = [],
  previousTopic?: string | null,
): TopicResetResult {
  const prev = previousTopic?.trim() || null;
  const currentTopic = extractExplicitCanonicalTopic(question, corrections);

  if (!currentTopic) {
    return { reset: false, currentTopic: null, wasPreviousTopicUsed: false };
  }

  if (!prev) {
    return {
      reset: false,
      currentTopic,
      wasPreviousTopicUsed: false,
      reason: 'new explicit topic, no previous topic',
    };
  }

  if (currentTopic.toLowerCase() !== prev.toLowerCase()) {
    return {
      reset: true,
      currentTopic,
      wasPreviousTopicUsed: false,
      reason: `new explicit topic «${currentTopic}» differs from previous «${prev}»`,
    };
  }

  if (NEW_TOPIC_QUESTION_RE.test(question)) {
    return {
      reset: true,
      currentTopic,
      wasPreviousTopicUsed: false,
      reason: `same term «${currentTopic}» but new-topic question starter — do not merge context`,
    };
  }

  return {
    reset: false,
    currentTopic,
    wasPreviousTopicUsed: false,
    reason: 'explicit topic matches previous topic',
  };
}

export type HallucinationRisk = 'low' | 'medium' | 'high';

const HIGH_RISK_RE =
  /(?:много\s+баг|сколько\s+баг|находил[\p{L}]*\s+(?:ли\s+)?(?:ваши\s+)?автотест[\p{L}]*\s+баг|сколько\s+автоматизатор|сколько\s+.+\s+в\s+команд|глубок[\p{L}]+.*kafka|kafka.*глубок|rest\s*assured|restassured|все\s+600|написал[\p{L}]*\s+.{0,20}600\s+(?:авто)?тест|сам\s+написал[\p{L}]*\s+.{0,15}тест)/iu;

const MEDIUM_RISK_RE =
  /(?:ты\s+сам\s+настраивал|как\s+ты\s+(?:применял|использовал)|опыт\s+(?:с\s+)?kafka|kubernetes|критичн[\p{L}]+\s+баг|selenium.{0,20}playwright|playwright.{0,20}selenium)/iu;

export function assessHallucinationRisk(question: string): HallucinationRisk {
  const q = question.trim();
  if (!q) return 'low';
  if (HIGH_RISK_RE.test(q)) return 'high';
  if (MEDIUM_RISK_RE.test(q)) return 'medium';
  return 'low';
}
