import type { QuestionIntent } from './classifyInterviewQuestionIntent';
import type { AppliedCorrection } from './correctTranscriptWithGlossary';
import type { InterviewSessionContext } from './interviewSessionContext';
import { assessHallucinationRisk, extractExplicitCanonicalTopic, shouldResetPreviousTopic } from './topicReset';
import { isStandaloneDefinitionQuestion, resolveStandaloneTopic } from './standaloneQuestion';

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

const EXPLICIT_FOLLOW_UP_RE = new RegExp(
  '(?:' +
    `${WB}(?:его|её|ее|это|этот|эту|этого|этим|этой|эти|он|она|оно|н[её]м|н[её]го|н[её]й)${WE}|` +
    'с\\s+этим|про\\s+это|для\\s+него|для\\s+неё|для\\s+нее|в\\s+н[её]м|в\\s+н[её]й|' +
    'чем\\s+(?:он|она|оно|это)\\s+отлича|' +
    'приведи\\s+пример\\s+(?:этого|использования)?|пример\\s+(?:этого|можешь\\s+привести)|' +
    'расскаж\\w*\\s+подробнее\\s+про\\s+это|подробнее\\s+про\\s+это|' +
    '^\\s*а\\s+(?:он|она|оно|это|зачем|где|пример|какие|в\\s+этом\\s+случае)\\b|' +
    'зачем\\s+(?:он|она|оно|это)\\s+нужен|' +
    'как\\s+ты\\s+(?:его|её|ее|это)\\s+(?:применял|использовал)|как\\s+ты\\s+это\\s+использовал|' +
    '(?:^|\\s)ты\\s+сам\\s+(?:его|её|ее|это)\\s+настраивал|' +
    'как\\s+ты\\s+(?:его|её|ее|это\\s+)?проверял|как\\s+ты\\s+с\\s+этим\\s+разбирал|' +
    'как\\s+работал\\s+с\\s+этим|как\\s+ты\\s+использовал\\s+(?:в\\s+)?pipeline|' +
    'как\\s+использовал\\s+(?:в\\s+)?pipeline|' +
    'какие\\s+(?:плюсы|минусы)(?:\\s+у\\s+(?:него|неё|нее|это))?|' +
    'какие\\s+ошибки\\s+бывают' +
    ')',
  'iu',
);

const PIPELINE_FOLLOW_UP_RE = /как\s+(?:ты\s+)?использовал\s+(?:в\s+)?pipeline/iu;

const SHORT_FOLLOW_UP_MAX = 100;

export function isFollowUpQuestion(question: string, corrections: AppliedCorrection[] = []): boolean {
  const q = question.trim();
  if (!q) return false;

  if (isStandaloneDefinitionQuestion(q, corrections)) {
    return false;
  }

  if (q.length > SHORT_FOLLOW_UP_MAX && !EXPLICIT_FOLLOW_UP_RE.test(q)) {
    return false;
  }

  return EXPLICIT_FOLLOW_UP_RE.test(q);
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

  if (PIPELINE_FOLLOW_UP_RE.test(q) && !termInQuestion(topic, q)) {
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

  if (/расскаж\w*\s+подробнее\s+про\s+это/i.test(q)) {
    return {
      text: `Расскажи подробнее про ${topic}`,
      reason: '«подробнее про это» → previous topic',
    };
  }

  if (/чем\s+(?:он|она|оно|это)\s+отлича/i.test(q)) {
    return {
      text: `Чем ${topic} отличается от других подходов?`,
      reason: '«чем он отличается» → previous topic',
    };
  }

  if (/какие\s+(?:плюсы|минусы)/i.test(q)) {
    const kind = /минусы/i.test(q) ? 'минусы' : 'плюсы';
    return {
      text: `Какие ${kind} у ${topic}?`,
      reason: `«какие ${kind}» → previous topic`,
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

  if (EXPLICIT_FOLLOW_UP_RE.test(q)) {
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
  const followUpCandidate = isFollowUpQuestion(intentCorrected, corrections);

  const resetInfo = shouldResetPreviousTopic(intentCorrected, corrections, previousTopic);
  const currentTopic =
    resetInfo.currentTopic ??
    extractExplicitCanonicalTopic(intentCorrected, corrections) ??
    (!followUpCandidate ? resolveStandaloneTopic(intentCorrected, corrections) : null);

  if (isStandaloneDefinitionQuestion(intentCorrected, corrections)) {
    return {
      resolvedQuestion: intentCorrected,
      usedPreviousContext: false,
      isFollowUp: false,
      resetPreviousTopic: Boolean(previousTopic && currentTopic),
      resetPreviousTopicReason: previousTopic
        ? 'Standalone technical term detected, previous context ignored'
        : undefined,
      currentTopic,
      wasPreviousTopicUsed: false,
      hallucinationRisk,
      confidence: 'high',
      reason: 'Standalone technical term detected, previous context ignored',
    };
  }

  if (
    !followUpCandidate &&
    (resetInfo.reset ||
      (currentTopic && previousTopic && currentTopic.toLowerCase() !== previousTopic.toLowerCase()))
  ) {
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
      isFollowUp: false,
      resetPreviousTopic: false,
      currentTopic,
      wasPreviousTopicUsed: false,
      hallucinationRisk,
      confidence: 'low',
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
