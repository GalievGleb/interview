import type { QuestionIntent } from './classifyInterviewQuestionIntent';
import type { AppliedCorrection } from './correctTranscriptWithGlossary';
import type { InterviewSessionContext } from './interviewSessionContext';
import { assessHallucinationRisk, extractExplicitCanonicalTopic, shouldResetPreviousTopic } from './topicReset';

export type FollowUpConfidence = 'high' | 'medium' | 'low';

export interface ResolveFollowUpInput {
  raw: string;
  corrected: string;
  intentCorrected: string;
  currentIntent?: QuestionIntent;
  sessionContext: InterviewSessionContext;
  corrections?: AppliedCorrection[];
}

export interface FollowUpResolutionResult {
  resolvedQuestion: string;
  usedPreviousContext: boolean;
  isFollowUp: boolean;
  resolvedTopic?: string;
  reason?: string;
  confidence: FollowUpConfidence;
  resetPreviousTopic: boolean;
  resetPreviousTopicReason?: string;
  currentTopic: string | null;
  wasPreviousTopicUsed: boolean;
  hallucinationRisk: 'low' | 'medium' | 'high';
}

const WB = '(?<![\\p{L}\\p{N}])';
const WE = '(?![\\p{L}\\p{N}])';

const NEW_TOPIC_STARTER_RE =
  /(?:^|\s)(?:что\s+такое|расскаж\w*\s+про|скаж\w*\s+про|в\s+ч(?:е|ё)м\s+разниц|чем\s+отлича|какие\s+бывают)/iu;

const FOLLOW_UP_MARKER_RE = new RegExp(
  '(?:' +
    `${WB}(?:его|её|ее|это|этот|эту|этого|такое|этим|этой|эти|он|она|оно)${WE}|` +
    'с\\s+этим|так\\s+ты\\s+его|как\\s+это\\b|' +
    'как\\s+применял|как\\s+использовал|как\\s+ты\\s+использовал|как\\s+работал\\s+с\\s+этим|как\\s+разбирал|' +
    'как\\s+ты\\s+с\\s+этим\\s+разбирал|с\\s+этим\\s+разбирал|' +
    'как\\s+ты\\s+это\\s+использовал|' +
    '(?:^|\\s)в\\s+работе|(?:^|\\s)на\\s+проект\\w*|^\\s*а\\s+как\\b|^\\s*а\\s+где\\b|' +
    '^\\s*а\\s+зачем\\b|^\\s*а\\s+пример\\b|^\\s*а\\s+какие\\b|' +
    '(?:как\\s+(?:ты\\s+)?)?проверял|(?:ты\\s+)?сам\\s+(?:его|её|ее|это|настраивал)|' +
    'зачем\\s+(?:он|она|оно|это)\\s+нужен|пример\\s+можешь\\s+привести|приведи\\s+пример|' +
    'какие\\s+ошибки\\s+бывают|как\\s+ты\\s+использовал\\s+в\\s+pipeline' +
    ')',
  'iu',
);

const SHORT_FOLLOW_UP_MAX = 100;

export function isFollowUpQuestion(question: string, corrections: AppliedCorrection[] = []): boolean {
  const q = question.trim();
  if (!q) return false;

  if (NEW_TOPIC_STARTER_RE.test(q) && extractExplicitCanonicalTopic(q, corrections)) {
    return false;
  }

  if (q.length > SHORT_FOLLOW_UP_MAX && !FOLLOW_UP_MARKER_RE.test(q)) return false;
  return FOLLOW_UP_MARKER_RE.test(q);
}

function capitalizeQuestion(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function termInQuestion(topic: string, question: string): boolean {
  return question.toLowerCase().includes(topic.toLowerCase());
}

function buildResolvedQuestion(question: string, topic: string): { text: string; reason: string } {
  const q = question.trim();

  if (/как\s+ты\s+использовал\s+в\s+pipeline/i.test(q) && !termInQuestion(topic, q)) {
    return {
      text: `Как ты использовал ${topic} в pipeline?`,
      reason: '«как использовал в pipeline» → previous topic',
    };
  }

  if (/как\s+ты\s+(?:его|её|ее|это)\s+применял/i.test(q)) {
    const suffix = /в\s+работе/i.test(q) ? ' в работе?' : '?';
    return {
      text: `Как ты применял ${topic}${suffix}`,
      reason: 'pronoun «его/это» → previous topic in «как применял»',
    };
  }

  if (/как\s+ты\s+(?:его|её|ее|это)\s+использовал/i.test(q) || /как\s+ты\s+это\s+использовал/i.test(q)) {
    const suffix = /на\s+проект/i.test(q) ? ' на проекте?' : ' в работе?';
    return {
      text: `Как ты использовал ${topic}${suffix}`,
      reason: 'pronoun «это/его» → previous topic in «как использовал»',
    };
  }

  if (/(?:^\s*а?\s*)?(?:ты\s+)?сам\s+(?:его|её|ее|это)\s+настраивал/i.test(q)) {
    return {
      text: `Ты сам настраивал ${topic}?`,
      reason: 'pronoun «его» → previous topic in «сам настраивал»',
    };
  }

  if (/какие\s+ошибки\s+бывают/i.test(q) && !termInQuestion(topic, q)) {
    return {
      text: `Какие ошибки бывают при использовании ${topic}?`,
      reason: 'generic «какие ошибки» → previous topic',
    };
  }

  if (
    /(?:^\s*а\s+)?как\s+(?:ты\s+)?(?:его|её|ее|это\s+)?проверял/i.test(q) ||
    /как\s+ты\s+(?:его|её|ее)\s+проверял/i.test(q)
  ) {
    return {
      text: `Как ты проверял ${topic}?`,
      reason: '«как проверял» → previous topic',
    };
  }

  if (/зачем\s+(?:он|она|оно|это)\s+нужен/i.test(q)) {
    return {
      text: `Зачем нужен ${topic}?`,
      reason: '«зачем он нужен» → previous topic',
    };
  }

  if (/где\s+ты\s+(?:его|её|ее|это)\s+применял/i.test(q)) {
    return {
      text: `Где ты применял ${topic}?`,
      reason: '«где применял» → previous topic',
    };
  }

  if (/пример\s+можешь\s+привести|приведи\s+пример|^\s*а\s+пример/i.test(q)) {
    return {
      text: `Приведи пример использования ${topic}`,
      reason: '«пример» → previous topic',
    };
  }

  if (/^(?:как\s+)?(?:это\s+было\s+)?(?:на\s+проект|в\s+работ)/i.test(q)) {
    return {
      text: `Как ты применял ${topic} на проекте?`,
      reason: '«на проекте/в работе» without topic → previous topic',
    };
  }

  if (/(?:^\s*а\s+)?как\s+работал\s+с\s+этим/i.test(q)) {
    return {
      text: `Как ты работал с ${topic}?`,
      reason: '«как работал с этим» → previous topic',
    };
  }

  if (/как\s+ты\s+с\s+этим\s+разбирал/i.test(q) || /(?:как\s+(?:ты\s+)?)?(?:с\s+этим\s+)?разбирал/i.test(q)) {
    return {
      text: `Как ты разбирался с ${topic}?`,
      reason: '«как с этим разбирался» → previous topic',
    };
  }

  if (FOLLOW_UP_MARKER_RE.test(q)) {
    let resolved = q
      .replace(
        new RegExp(`${WB}(?:его|её|ее|это|этот|эту|этого|такое|этим|этой|эти|он|она|оно)${WE}`, 'giu'),
        topic,
      )
      .replace(/^\s*а\s+/i, '');
    resolved = capitalizeQuestion(resolved);
    if (!resolved.endsWith('?') && !resolved.endsWith('.')) resolved += '?';
    return { text: resolved, reason: 'generic pronoun replacement with previous topic' };
  }

  return { text: q, reason: 'no pattern matched' };
}

export function resolveFollowUpQuestion(input: ResolveFollowUpInput): FollowUpResolutionResult {
  const intentCorrected = input.intentCorrected.trim();
  const corrections = input.corrections ?? [];
  const previousTopic = input.sessionContext.lastCanonicalTopic?.trim() || null;
  const hallucinationRisk = assessHallucinationRisk(intentCorrected);

  const resetInfo = shouldResetPreviousTopic(intentCorrected, corrections, previousTopic);
  const currentTopic = resetInfo.currentTopic ?? extractExplicitCanonicalTopic(intentCorrected, corrections);
  const followUpCandidate = isFollowUpQuestion(intentCorrected, corrections);

  if (resetInfo.reset || (currentTopic && previousTopic && currentTopic.toLowerCase() !== previousTopic.toLowerCase())) {
    return {
      resolvedQuestion: intentCorrected,
      usedPreviousContext: false,
      isFollowUp: false,
      resetPreviousTopic: true,
      resetPreviousTopicReason: resetInfo.reason ?? 'new explicit topic — previous context reset',
      currentTopic,
      wasPreviousTopicUsed: false,
      hallucinationRisk,
      confidence: 'high',
      reason: resetInfo.reason,
    };
  }

  const topic = previousTopic;
  if (!topic || !followUpCandidate) {
    return {
      resolvedQuestion: intentCorrected,
      usedPreviousContext: false,
      isFollowUp: followUpCandidate,
      resetPreviousTopic: false,
      currentTopic,
      wasPreviousTopicUsed: false,
      hallucinationRisk,
      confidence: followUpCandidate ? 'medium' : 'low',
    };
  }

  if (termInQuestion(topic, intentCorrected)) {
    return {
      resolvedQuestion: intentCorrected,
      usedPreviousContext: false,
      isFollowUp: true,
      resolvedTopic: topic,
      reason: 'topic already present in question',
      resetPreviousTopic: false,
      currentTopic: currentTopic ?? topic,
      wasPreviousTopicUsed: false,
      hallucinationRisk,
      confidence: 'high',
    };
  }

  const { text, reason } = buildResolvedQuestion(intentCorrected, topic);
  return {
    resolvedQuestion: text,
    usedPreviousContext: true,
    isFollowUp: true,
    resolvedTopic: topic,
    reason,
    resetPreviousTopic: false,
    currentTopic: topic,
    wasPreviousTopicUsed: true,
    hallucinationRisk,
    confidence: 'high',
  };
}
