import type { StreamInterviewOpts } from './api';

export type AnswerRevisionMode = 'shorter' | 'regenerate';

const SHORTER_STRATEGY =
  'REVISION SHORTER: Answer in 40–55 words max (~3–4 short sentences), say-aloud style. ' +
  'Keep the same facts and structure (lists OK if already present). No filler openings. ' +
  'Do not mention that this is a shorter version.';

export function buildRevisionStreamOpts(
  base: StreamInterviewOpts,
  mode: AnswerRevisionMode,
  previousAnswer: string,
): StreamInterviewOpts {
  if (mode === 'regenerate') {
    return { ...base };
  }

  return {
    ...base,
    questionIntent: base.questionIntent ?? 'technical_definition',
    answerStrategy: `${SHORTER_STRATEGY}\n\nPrevious answer to shorten:\n${previousAnswer.trim()}`,
    resumeContextUsed: false,
    resumeContextLevel: 'none',
    resumeContextReason: 'Answer revision — no resume injection',
    suggestUnclearPrefix: false,
  };
}

export type PipelineStreamInput = NonNullable<Parameters<typeof pipelineToStreamOpts>[1]>;

export function pipelineToStreamOpts(
  question: string,
  pipeline?: {
    rawTranscript?: string;
    glossaryCorrected?: string;
    intentCorrected?: string;
    resolvedQuestion?: string;
    questionIntent?: string;
    answerStrategy?: string;
    previousTopic?: string | null;
    isFollowUp?: boolean;
    usedPreviousContext?: boolean;
    followUpReason?: string;
    currentCanonicalTopic?: string | null;
    corrections?: StreamInterviewOpts['corrections'];
    intentCorrections?: StreamInterviewOpts['intentCorrections'];
    intentConfidence?: string;
    intentReason?: string;
    ambiguity?: string;
    resumeContextUsed?: boolean;
    resumeContextLevel?: string;
    resumeContextReason?: string;
  },
): StreamInterviewOpts {
  return {
    rawQuestion: pipeline?.rawTranscript ?? question,
    glossaryCorrected: pipeline?.glossaryCorrected ?? question,
    intentCorrected: pipeline?.intentCorrected ?? question,
    resolvedQuestion: pipeline?.resolvedQuestion ?? question,
    previousTopic: pipeline?.previousTopic ?? undefined,
    isFollowUp: pipeline?.isFollowUp,
    usedPreviousContext: pipeline?.usedPreviousContext,
    followUpReason: pipeline?.followUpReason,
    currentCanonicalTopic: pipeline?.currentCanonicalTopic ?? undefined,
    corrections: pipeline?.corrections,
    intentCorrections: pipeline?.intentCorrections,
    intentConfidence: pipeline?.intentConfidence,
    intentReason: pipeline?.intentReason,
    ambiguity: pipeline?.ambiguity,
    questionIntent: pipeline?.questionIntent,
    answerStrategy: pipeline?.answerStrategy,
    resumeContextUsed: pipeline?.resumeContextUsed,
    resumeContextLevel: pipeline?.resumeContextLevel,
    resumeContextReason: pipeline?.resumeContextReason,
  };
}
