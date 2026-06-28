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

export type TopicStatus = 'strong' | 'medium' | 'weak' | 'critical';
export type ReadinessLabel = 'not_ready' | 'weak' | 'almost_ready' | 'ready' | 'strong';

export interface InterviewTopic {
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
  interviewTopics: InterviewTopic[];
  projectQuestions: string[];
  riskAreas: string[];
  /** Whether resume / legend context was attached during analysis. */
  hasResume: boolean;
  hasLegend: boolean;
  createdAt: number;
}

export interface SmokeQuestion {
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
