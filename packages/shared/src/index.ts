export enum Plan {
  BASIC = 'BASIC',
  PRO = 'PRO',
}

export enum SubStatus {
  ACTIVE = 'ACTIVE',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
  PENDING = 'PENDING',
}

export enum PaymentProvider {
  STRIPE = 'STRIPE',
  YOOKASSA = 'YOOKASSA',
}

export enum PersonaMode {
  GENERAL = 'GENERAL',
  TECHNICAL = 'TECHNICAL',
}

export enum BillingProvider {
  STRIPE = 'stripe',
  YOOKASSA = 'yookassa',
}

export interface PlanLimits {
  sttMinutesPerMonth: number;
  llmTokensPerMonth: number;
  modes: PersonaMode[];
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  [Plan.BASIC]: {
    sttMinutesPerMonth: 300,
    llmTokensPerMonth: 500_000,
    modes: [PersonaMode.GENERAL],
  },
  [Plan.PRO]: {
    sttMinutesPerMonth: 1200,
    llmTokensPerMonth: 2_000_000,
    modes: [PersonaMode.GENERAL, PersonaMode.TECHNICAL],
  },
};

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface UserProfile {
  id: string;
  email: string;
  hwid: string | null;
}

export interface SubscriptionInfo {
  plan: Plan | null;
  status: SubStatus;
  currentPeriodEnd: string | null;
  sttMinutesUsed: number;
  llmTokensUsed: number;
  limits: PlanLimits | null;
}

export interface AuthResponse {
  user: UserProfile;
  tokens: AuthTokens;
  subscription: SubscriptionInfo;
}

export interface RegisterRequest {
  email: string;
  password: string;
  hwid?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
  hwid?: string;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface CheckoutRequest {
  plan: Plan;
  provider: BillingProvider;
  successUrl?: string;
  cancelUrl?: string;
}

export interface CheckoutResponse {
  checkoutUrl: string;
}

export interface TranscriptChunk {
  text: string;
  isFinal: boolean;
  timestamp: number;
}

export interface SuggestRequest {
  transcript: string;
  mode: PersonaMode;
}

export interface SttStreamMessage {
  type: 'audio' | 'stop';
  data?: string;
}

export interface SttResponseMessage {
  type: 'transcript' | 'error' | 'usage';
  text?: string;
  isFinal?: boolean;
  message?: string;
  minutesUsed?: number;
}

export interface SuggestStreamEvent {
  type: 'chunk' | 'done' | 'error';
  text?: string;
  message?: string;
}

export type { CorrectionResult, AppliedCorrection } from './correctTranscriptWithGlossary';
export { correctTranscriptWithGlossary, hasSuspiciousTerms, shouldRunLlmCorrection } from './correctTranscriptWithGlossary';
export type {
  IntentCorrection,
  IntentCorrectionInput,
  IntentCorrectionResult,
} from './correctQuestionIntent';
export { correctQuestionIntent } from './correctQuestionIntent';
export { QA_GLOSSARY, QA_GLOSSARY_CANONICAL_TERMS } from './qaGlossary';
export type { QaGlossaryEntry } from './qaGlossary';
export type {
  AnswerStrategyResult,
  ClassifyQuestionIntentInput,
  QuestionIntent,
  ResumeContextLevel,
} from './classifyInterviewQuestionIntent';
export {
  classifyInterviewQuestionIntent,
  getAnswerStrategyForIntent,
  shouldSuggestUnclearPrefix,
} from './classifyInterviewQuestionIntent';
export { QA_QUESTION_BANK } from './qaQuestionBank';
export type {
  InterviewSessionContext,
  SessionContextUpdate,
} from './interviewSessionContext';
export {
  createEmptySessionContext,
  MAX_RECENT_TOPICS,
  updateSessionContextAfterAnswer,
} from './interviewSessionContext';
export { extractCanonicalTopic } from './extractCanonicalTopic';
export type {
  FollowUpConfidence,
  FollowUpResolutionResult,
  ResolveFollowUpInput,
} from './resolveFollowUpQuestion';
export { isFollowUpQuestion, resolveFollowUpQuestion } from './resolveFollowUpQuestion';
export { sanitizeLiveAnswer } from './sanitizeLiveAnswer';
export {
  assessHallucinationRisk,
  extractExplicitCanonicalTopic,
  shouldResetPreviousTopic,
  TOPIC_RESET_CANONICAL_TERMS,
} from './topicReset';
export type { HallucinationRisk, TopicResetResult } from './topicReset';
export { getDangerQuestionStrategy } from './interviewAnswerSafety';
