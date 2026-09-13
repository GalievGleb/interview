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

export enum BillingPeriod {
  MONTHLY = 'monthly',
  YEARLY = 'yearly',
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
  displayName: string | null;
  avatarUrl: string | null;
}

export interface SubscriptionInfo {
  plan: Plan | null;
  status: SubStatus;
  currentPeriodEnd: string | null;
  sttMinutesUsed: number;
  llmTokensUsed: number;
  limits: PlanLimits | null;
}

export interface ManagedLicenseResponse {
  active: boolean;
  key: string | null;
  expiresAt: string | null;
}

export interface AuthResponse {
  user: UserProfile;
  tokens: AuthTokens;
  subscription: SubscriptionInfo;
}

export interface RegistrationPendingResponse {
  verificationRequired: true;
  email: string;
}

export interface AcceptedResponse {
  accepted: true;
}

export interface PasswordChangedResponse {
  changed: true;
}

export interface RegisterRequest {
  email: string;
  password: string;
  deviceId: string;
  deviceName?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
  deviceId: string;
  deviceName?: string;
}

export interface GoogleLoginRequest {
  idToken: string;
  deviceId: string;
  deviceName?: string;
}

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface CheckoutRequest {
  plan: Plan;
  provider: BillingProvider;
  period: BillingPeriod;
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

export type {
  AppliedCorrection,
  CorrectionConfidence,
  CorrectionResult,
  IntentCorrection,
  IntentCorrectionResult,
} from './transcriptMetadata';
export type {
  SttProviderId,
  SttProviderMode,
  SttProviderDiagnostics,
} from './sttProviders';
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
export {
  extractStandaloneDefinitionTerm,
  isStandaloneDefinitionQuestion,
  resolveStandaloneTopic,
} from './standaloneQuestion';
export { sanitizeLiveAnswer, trimSpokenAnswer } from './sanitizeLiveAnswer';
export {
  scoreSpokenAnswer,
  countWords,
  FORBIDDEN_LIVE_PHRASES,
  INTERNAL_LABELS,
  type SpokenAnswerQuality,
} from './answerQuality';
export {
  assessHallucinationRisk,
  extractExplicitCanonicalTopic,
  shouldResetPreviousTopic,
  TOPIC_RESET_CANONICAL_TERMS,
} from './topicReset';
export type { HallucinationRisk, TopicResetResult } from './topicReset';
export { getDangerQuestionStrategy } from './interviewAnswerSafety';
export {
  mergeTranscriptWithBuffer,
  pushUtteranceBuffer,
  pruneUtteranceBuffer,
  shouldWaitForMoreSpeech,
  shouldForceProceedIncomplete,
} from './utteranceBuffer';
export type { UtteranceBufferEntry, UtteranceSpeaker, UtteranceWaitResult } from './utteranceBuffer';
