/**
 * Vacancy Smoke Review — data model.
 *
 * Paste a vacancy → extract likely interview topics → run a short mock →
 * readiness report. Topics are derived FROM THE VACANCY, never a generic
 * skills catalogue.
 */

export type AnswerLanguage = 'ru' | 'en';
export type SeniorityLevel = 'intern' | 'junior' | 'middle' | 'senior' | 'lead' | 'unknown';
export type TopicImportance = 'high' | 'medium' | 'low';
export type Difficulty = 'easy' | 'medium' | 'hard';

/** Per-question depth, as a real interviewer would grade it. */
export type QuestionLevel = 'junior' | 'middle' | 'senior' | 'lead';
/** Depth a vacancy expects for a competency. */
export type CompetencyLevel = 'basic' | 'practical' | 'advanced' | 'lead';
/** How well the résumé covers a vacancy competency. */
export type ResumeMatch = 'strong' | 'partial' | 'gap';

export type TopicStatus = 'strong' | 'medium' | 'weak' | 'critical';
export type ReadinessLabel = 'not_ready' | 'weak' | 'almost_ready' | 'ready' | 'strong';

/**
 * A vacancy competency scored against the résumé — the backbone of question
 * selection. `priority` = how critical for the role; `expectedLevel` = how deep
 * the vacancy needs it; `resumeMatch` = whether the candidate can back it up.
 */
export interface Competency {
  name: string;
  priority: TopicImportance;
  expectedLevel: CompetencyLevel;
  resumeMatch: ResumeMatch;
  /** One line: what to probe / where the gap is. */
  note: string;
}

/** Rich, per-question interviewer metadata (optional; absent on old sessions). */
export interface QuestionMeta {
  /** Why this question matters for THIS vacancy. */
  whyAsked?: string;
  /** 4–7 points a strong answer must cover. */
  expectedAnswerPoints?: string[];
  /** Interviewer's target depth for the question. */
  level?: QuestionLevel;
  /** Vacancy topics this question maps to. */
  relatedVacancyTopics?: string[];
  /** Résumé items that let the candidate answer it. */
  relatedResumeEvidence?: string[];
}

export interface InterviewTopic extends QuestionMeta {
  id: string;
  title: string;
  category: string;
  importance: TopicImportance;
  expectedKnowledge: string;
  sampleQuestions: string[];
  /** The phrase(s) in the vacancy that this topic was derived from. */
  vacancyEvidence: string;
}

export interface VacancyAnalysis {
  id: string;
  vacancyText: string;
  targetRole: string;
  seniorityLevel: SeniorityLevel;
  language: AnswerLanguage;
  extractedRequirements: string[];
  optionalSkills: string[];
  /** Competency map scored against the résumé (optional; absent on old data). */
  competencies?: Competency[];
  interviewTopics: InterviewTopic[];
  projectQuestions: string[];
  riskAreas: string[];
  /** Whether resume / legend context was attached during analysis. */
  hasResume: boolean;
  hasLegend: boolean;
  /**
   * Denormalized grounding text, kept so evaluation can adapt the stronger
   * answer to the candidate's real experience. Trimmed to keep storage sane.
   */
  resumeText?: string;
  legendText?: string;
  createdAt: number;
}

export interface SmokeQuestion extends QuestionMeta {
  id: string;
  topicId: string;
  question: string;
  difficulty: Difficulty;
  expectedSignals: string[];
  redFlags: string[];
}

export interface SmokeAnswerEvaluation {
  questionId: string;
  score: number; // 0..100
  clarityScore: number;
  technicalAccuracyScore: number;
  specificityScore: number;
  confidenceScore: number;
  feedback: string;
  missingPoints: string[];
  goodPoints: string[];
  suggestedBetterAnswer: string;
  /** Heuristic flag: answer claims experience not backed by resume/legend. */
  overclaimed?: boolean;
  // ── Richer interviewer feedback (optional; absent on old sessions) ──
  /** Level this single answer demonstrated. */
  levelEstimate?: QuestionLevel;
  /** Short, honest one-line verdict. */
  verdict?: string;
  /** What was weak or imprecise (distinct from what was simply missing). */
  weakPoints?: string[];
  /** Concrete technical mistakes + the correct formulation. */
  technicalCorrections?: string[];
  /** The structure the candidate should answer by (ordered steps). */
  betterStructure?: string[];
  /** 2–4 questions an interviewer would drill in with. */
  followUpQuestions?: string[];
  /** What to train next after this answer. */
  nextTrainingFocus?: string;
  // ── Voice-answer preprocessing + finer breakdown (optional) ──
  /** Knowledge + relevance of the content itself. */
  technicalContentScore?: number;
  /** How concrete the project detail was. */
  projectSpecificityScore?: number;
  /** How well a leadership/ownership role was shown (leadership Qs only). */
  leadershipScore?: number;
  /** Ownership shown specifically for project_experience_question rubric. */
  ownershipScore?: number;
  /** Structure of the answer. */
  structureScore?: number;
  /** Cleanliness of speech/delivery after ASR (not a technical penalty). */
  speechClarityScore?: number;
  /** ASR/noise fragments detected in the answer (speech-quality, not a tech error). */
  detectedNoiseOrAsrErrors?: string[];
  /** The valid points recovered from a noisy/rambling answer. */
  extractedValidPoints?: string[];
  /** What the stronger answer must NOT invent (metrics, titles, people mgmt…). */
  hallucinationGuard?: string[];
}

export interface SmokeAnswer {
  questionId: string;
  text: string;
  source: 'voice' | 'text';
  skipped: boolean;
  evaluation?: SmokeAnswerEvaluation;
  answeredAt: number;
}

export type SmokeSessionStatus = 'in_progress' | 'completed' | 'abandoned';

export interface SmokeReviewSession {
  id: string;
  vacancyAnalysisId: string;
  vacancyAnalysis: VacancyAnalysis; // denormalized so a session is self-contained
  status: SmokeSessionStatus;
  questions: SmokeQuestion[];
  answers: SmokeAnswer[];
  currentIndex: number;
  startedAt: number;
  completedAt?: number;
  report?: ReadinessReport;
}

export interface TopicScore {
  topicId: string;
  title: string;
  category: string;
  score: number; // 0..100
  status: TopicStatus;
  questionsAsked: number;
  feedback: string;
  missingPoints: string[];
  nextAction: string;
}

export interface ReadinessReport {
  overallScore: number; // 0..100
  status: ReadinessLabel;
  topicScores: TopicScore[];
  strengths: string[];
  weakAreas: string[];
  criticalGaps: string[];
  nextPracticePlan: string[];
  generatedAt: number;
}

export interface VacancyReviewInput {
  vacancyText: string;
  targetRole?: string;
  language: AnswerLanguage;
  resumeText?: string;
  legendText?: string;
}
