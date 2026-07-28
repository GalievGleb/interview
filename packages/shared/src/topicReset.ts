import type { AppliedCorrection } from './transcriptMetadata';
import { resolveStandaloneTopic } from './standaloneQuestion';

export const TOPIC_RESET_CANONICAL_TERMS = [
  'Page Object Model',
  'GitLab CI',
  'REST API',
  'smoke testing',
  'sanity testing',
  'regression testing',
  'equivalence classes',
  'boundary values',
  'pairwise testing',
  'pytest fixtures',
  'flaky tests',
  'HTTP methods',
  'Jenkins',
  'CI/CD',
  'Kafka',
  'Docker',
  'Allure',
  'Kubernetes',
  'Selenium',
  'Playwright',
  'HTTPX',
  'Requests',
  'Linux',
  'pytest',
  'OOP',
  'полиморфизм',
  'инкапсуляция',
  'наследование',
  'абстракция',
  'API',
  'PUT',
  'PATCH',
] as const;

const NEW_TOPIC_QUESTION_RE =
  /(?:^|\s)(?:что\s+такое|расскаж\w*\s+про|в\s+ч(?:е|ё)м\s+разниц|чем\s+отлича|какие\s+бывают|ты\s+настраивал|как\s+использовал|как\s+применял|скаж\w*\s+про)/iu;

function termInText(term: string, text: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

export function extractExplicitCanonicalTopic(
  question: string,
  _corrections: AppliedCorrection[] = [],
): string | null {
  const q = question.trim();
  if (!q) return null;
  const terms = [...TOPIC_RESET_CANONICAL_TERMS].sort((a, b) => b.length - a.length);
  for (const term of terms) {
    if (termInText(term, q)) return term;
  }
  return NEW_TOPIC_QUESTION_RE.test(q) ? resolveStandaloneTopic(q) : null;
}

export interface TopicResetResult {
  reset: boolean;
  reason?: string;
  currentTopic: string | null;
  wasPreviousTopicUsed: boolean;
}

export function shouldResetPreviousTopic(
  question: string,
  corrections: AppliedCorrection[] = [],
  previousTopic?: string | null,
): TopicResetResult {
  const currentTopic = extractExplicitCanonicalTopic(question, corrections);
  const previous = previousTopic?.trim() || null;
  if (!currentTopic) {
    return { reset: false, currentTopic: null, wasPreviousTopicUsed: false };
  }
  const reset =
    Boolean(previous && currentTopic.toLowerCase() !== previous.toLowerCase()) ||
    NEW_TOPIC_QUESTION_RE.test(question);
  return {
    reset,
    currentTopic,
    wasPreviousTopicUsed: false,
    reason: reset ? 'explicit technical topic in current question' : undefined,
  };
}

export type HallucinationRisk = 'low' | 'medium' | 'high';

const HIGH_RISK_RE =
  /(?:много\s+баг|сколько\s+баг|сколько\s+автоматизатор|сколько\s+.+\s+в\s+команд|глубок[\p{L}]+.*kafka|kafka.*глубок|rest\s*assured|все\s+600|сам\s+написал[\p{L}]*\s+.{0,15}тест)/iu;
const MEDIUM_RISK_RE =
  /(?:ты\s+сам\s+настраивал|как\s+ты\s+(?:применял|использовал)|опыт\s+(?:с\s+)?kafka|kubernetes|критичн[\p{L}]+\s+баг)/iu;

export function assessHallucinationRisk(question: string): HallucinationRisk {
  if (HIGH_RISK_RE.test(question)) return 'high';
  if (MEDIUM_RISK_RE.test(question)) return 'medium';
  return 'low';
}
