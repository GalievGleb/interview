import type { AppliedCorrection, IntentCorrection } from '@interview/shared';
import type { PreparedTranscript } from './prepareTranscriptForLlm';
import type { SessionDetail } from './api';

export type Speaker = 'me' | 'other';

export interface TranscriptLine {
  text: string;
  normalized?: string;
  corrected?: string;
  isFinal: boolean;
  speaker: Speaker;
}

export interface ExchangeLatency {
  /** Real STT latency for this utterance (speech-end → final). NOT session-elapsed. */
  sttLatencyMs: number | null;
  llmLatencyMs: number;
  totalLatencyMs: number;
  /** Optional per-stage breakdown (live mode), all relative to the utterance. */
  breakdown?: {
    speechEndToFinalMs?: number;
    speechStartToFinalMs?: number;
    finalToAnswerStartMs?: number;
    llmFirstTokenMs?: number;
    llmTotalMs?: number;
    /** Diagnostic only: wall-clock since the session started. Never use as STT latency. */
    sessionElapsedToFinalMs?: number;
  };
}

export interface CopilotAnswerPipeline {
  rawTranscript: string;
  glossaryCorrected: string;
  intentCorrected: string;
  resolvedQuestion: string;
  previousTopic?: string | null;
  currentCanonicalTopic?: string | null;
  isFollowUp?: boolean;
  usedPreviousContext?: boolean;
  wasPreviousTopicUsed?: boolean;
  followUpReason?: string;
  resetPreviousTopic?: boolean;
  resetPreviousTopicReason?: string;
  questionIntent?: string;
  answerStrategy?: string;
  hallucinationRisk?: string;
  corrections?: AppliedCorrection[];
  intentCorrections?: IntentCorrection[];
  intentConfidence?: string;
  intentReason?: string;
  ambiguity?: string;
  resumeContextUsed?: boolean;
  resumeContextLevel?: string;
  resumeContextReason?: string;
  llmCorrectedTranscript?: string;
  /** Python Knowledge Pack usage for this exchange (server-reported). */
  knowledge?: {
    knowledgePackUsed?: boolean;
    knowledgePackName?: string | null;
    knowledgeSource?: string;
    retrievedItemsCount?: number;
    injectedContextTokens?: number;
    knowledgeRetrievalMs?: number;
    answerLatencyWithKnowledgeMs?: number;
  };
  /** @deprecated use entry.latency.llmLatencyMs */
  timeToAnswerMs?: number;
  /** @deprecated use entry.latency.sttLatencyMs */
  timeToFinalMs?: number;
}

export interface CopilotAnswerEntry {
  id: string;
  question: string;
  spoken: string;
  ts: number;
  source?: 'live' | 'manual';
  pipeline?: CopilotAnswerPipeline;
  latency?: ExchangeLatency;
}

export interface InterviewSessionExport {
  exportedAt: string;
  sessionId: string | null;
  mode: 'interview_copilot' | 'stored_session';
  title?: string | null;
  startedAt: string | null;
  endedAt: string | null;
  active: boolean;
  summary?: string | null;
  transcript: Array<{
    speaker: string;
    text: string;
    isFinal?: boolean;
    normalized?: string;
    ts?: string;
  }>;
  exchanges: Array<{
    id: string;
    ts: string;
    source: 'live' | 'manual' | 'stored';
    question: {
      resolved: string;
      raw?: string;
      glossaryCorrected?: string;
      intentCorrected?: string;
      llmCorrected?: string;
    };
    answer: {
      spoken: string;
      short?: string | null;
      detailed?: string | null;
      english?: string | null;
      risk?: string | null;
    };
    latency?: ExchangeLatency;
    pipeline?: CopilotAnswerPipeline;
  }>;
}

export function buildPipelineFromPrepared(
  prepared: PreparedTranscript,
  extra: Partial<CopilotAnswerPipeline> = {},
): CopilotAnswerPipeline {
  return {
    rawTranscript: prepared.rawTranscript,
    glossaryCorrected: prepared.corrected,
    intentCorrected: prepared.intentCorrected,
    resolvedQuestion: prepared.resolvedQuestion,
    previousTopic: extra.previousTopic ?? null,
    currentCanonicalTopic: prepared.canonicalTopic ?? null,
    isFollowUp: prepared.followUp.isFollowUp,
    usedPreviousContext: prepared.followUp.usedPreviousContext,
    wasPreviousTopicUsed: prepared.followUp.wasPreviousTopicUsed,
    followUpReason: prepared.followUp.reason,
    resetPreviousTopic: prepared.followUp.resetPreviousTopic,
    resetPreviousTopicReason: prepared.followUp.resetPreviousTopicReason,
    questionIntent: prepared.answerStrategy.questionIntent,
    answerStrategy: prepared.answerStrategy.answerStrategy,
    hallucinationRisk: prepared.followUp.hallucinationRisk,
    corrections: prepared.correction.corrections,
    intentCorrections: prepared.intent.intentCorrections,
    intentConfidence: prepared.intent.confidence !== 'none' ? prepared.intent.confidence : undefined,
    intentReason: prepared.intent.reason,
    ambiguity: prepared.intent.ambiguity,
    resumeContextUsed: prepared.answerStrategy.resumeContextUsed,
    resumeContextLevel: prepared.answerStrategy.resumeContextLevel,
    resumeContextReason: prepared.answerStrategy.resumeContextReason,
    ...extra,
  };
}

function exchangeFromEntry(entry: CopilotAnswerEntry): InterviewSessionExport['exchanges'][number] {
  const pipeline = entry.pipeline;
  return {
    id: entry.id,
    ts: new Date(entry.ts).toISOString(),
    source: entry.source ?? 'live',
    question: {
      resolved: entry.question,
      raw: pipeline?.rawTranscript,
      glossaryCorrected: pipeline?.glossaryCorrected,
      intentCorrected: pipeline?.intentCorrected,
      llmCorrected: pipeline?.llmCorrectedTranscript,
    },
    answer: { spoken: entry.spoken },
    latency: entry.latency,
    pipeline,
  };
}

export function buildExchangeLatency(
  sttLatencyMs: number | null | undefined,
  llmLatencyMs: number,
  breakdown?: ExchangeLatency['breakdown'],
): ExchangeLatency {
  const stt = sttLatencyMs != null ? Math.round(sttLatencyMs) : null;
  const llm = Math.round(llmLatencyMs);
  const rounded =
    breakdown &&
    Object.fromEntries(
      Object.entries(breakdown)
        .filter(([, v]) => v != null && Number.isFinite(v))
        .map(([k, v]) => [k, Math.round(v as number)]),
    );
  return {
    sttLatencyMs: stt,
    llmLatencyMs: llm,
    totalLatencyMs: (stt ?? 0) + llm,
    ...(rounded && Object.keys(rounded).length ? { breakdown: rounded } : {}),
  };
}

export function buildCopilotSessionExport(input: {
  sessionId?: string | null;
  startedAt?: number | null;
  active?: boolean;
  transcriptLines: TranscriptLine[];
  exchanges: CopilotAnswerEntry[];
  pending?: { question: string; answer: string; source?: 'live' | 'manual' } | null;
}): InterviewSessionExport {
  const sorted = [...input.exchanges].sort((a, b) => a.ts - b.ts);
  const exchanges = sorted.map(exchangeFromEntry);

  if (input.pending?.question.trim() || input.pending?.answer.trim()) {
    exchanges.push({
      id: 'pending',
      ts: new Date().toISOString(),
      source: input.pending.source ?? 'live',
      question: { resolved: input.pending.question.trim() },
      answer: { spoken: input.pending.answer.trim() },
    });
  }

  return {
    exportedAt: new Date().toISOString(),
    sessionId: input.sessionId ?? null,
    mode: 'interview_copilot',
    startedAt: input.startedAt ? new Date(input.startedAt).toISOString() : null,
    endedAt: input.active ? null : new Date().toISOString(),
    active: Boolean(input.active),
    transcript: input.transcriptLines.map((line) => ({
      speaker: line.speaker,
      text: line.text,
      isFinal: line.isFinal,
      normalized: line.normalized,
    })),
    exchanges,
  };
}

export function buildStoredSessionExport(session: SessionDetail): InterviewSessionExport {
  return {
    exportedAt: new Date().toISOString(),
    sessionId: session.id,
    mode: 'stored_session',
    title: session.title,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    active: false,
    summary: session.summary,
    transcript: session.transcripts.map((t) => ({
      speaker: t.speaker,
      text: t.text,
      ts: t.ts,
      isFinal: true,
    })),
    exchanges: session.answers.map((a) => ({
      id: a.id,
      ts: session.started_at,
      source: 'stored',
      question: { resolved: a.question },
      answer: {
        spoken: a.spoken ?? a.short ?? '',
        short: a.short,
        detailed: a.detailed,
        english: a.english,
        risk: a.risk,
      },
    })),
  };
}

function formatPipelineTxt(pipeline: CopilotAnswerPipeline | undefined): string[] {
  if (!pipeline) return [];
  const lines: string[] = [];
  if (pipeline.rawTranscript) lines.push(`Raw transcript: ${pipeline.rawTranscript}`);
  if (pipeline.glossaryCorrected && pipeline.glossaryCorrected !== pipeline.rawTranscript) {
    lines.push(`Glossary corrected: ${pipeline.glossaryCorrected}`);
  }
  if (pipeline.intentCorrected && pipeline.intentCorrected !== pipeline.glossaryCorrected) {
    lines.push(`Intent corrected: ${pipeline.intentCorrected}`);
  }
  if (pipeline.llmCorrectedTranscript && pipeline.llmCorrectedTranscript !== pipeline.intentCorrected) {
    lines.push(`LLM corrected: ${pipeline.llmCorrectedTranscript}`);
  }
  if (pipeline.resolvedQuestion && pipeline.resolvedQuestion !== pipeline.intentCorrected) {
    lines.push(`Resolved question: ${pipeline.resolvedQuestion}`);
  }
  if (pipeline.previousTopic) lines.push(`Previous topic: ${pipeline.previousTopic}`);
  if (pipeline.currentCanonicalTopic) lines.push(`Current topic: ${pipeline.currentCanonicalTopic}`);
  if (pipeline.isFollowUp != null) lines.push(`Follow-up: ${pipeline.isFollowUp}`);
  if (pipeline.usedPreviousContext != null) {
    lines.push(`Used previous context: ${pipeline.usedPreviousContext}`);
  }
  if (pipeline.followUpReason) lines.push(`Follow-up reason: ${pipeline.followUpReason}`);
  if (pipeline.questionIntent) lines.push(`Question intent: ${pipeline.questionIntent}`);
  if (pipeline.answerStrategy) lines.push(`Answer strategy: ${pipeline.answerStrategy}`);
  if (pipeline.hallucinationRisk) lines.push(`Hallucination risk: ${pipeline.hallucinationRisk}`);
  if (pipeline.corrections?.length) {
    lines.push(
      `Glossary fixes: ${pipeline.corrections.map((c) => `${c.from} → ${c.to}`).join('; ')}`,
    );
  }
  return lines;
}

function formatLatencyTxt(latency: ExchangeLatency | undefined): string[] {
  if (!latency) return [];
  const lines = [`LLM: ${latency.llmLatencyMs} ms`, `Total: ${latency.totalLatencyMs} ms`];
  if (latency.sttLatencyMs != null) {
    lines.unshift(`STT: ${latency.sttLatencyMs} ms`);
  }
  return lines;
}

export function formatInterviewSessionTxt(exportData: InterviewSessionExport): string {
  const parts: string[] = [
    '=== Interview Session Export ===',
    `Exported at: ${exportData.exportedAt}`,
    `Mode: ${exportData.mode}`,
    `Session ID: ${exportData.sessionId ?? 'local'}`,
  ];
  if (exportData.title) parts.push(`Title: ${exportData.title}`);
  if (exportData.startedAt) parts.push(`Started: ${exportData.startedAt}`);
  if (exportData.endedAt) parts.push(`Ended: ${exportData.endedAt}`);
  if (exportData.summary) {
    parts.push('', '--- Summary ---', exportData.summary);
  }

  if (exportData.transcript.length > 0) {
    parts.push('', '--- Transcript ---');
    for (const line of exportData.transcript) {
      const ts = line.ts ? `[${line.ts}] ` : '';
      parts.push(`${ts}[${line.speaker}] ${line.text}`);
    }
  }

  if (exportData.exchanges.length > 0) {
    parts.push('', '--- Questions & Answers ---');
    exportData.exchanges.forEach((item, index) => {
      parts.push('');
      parts.push(`### Q&A ${index + 1} (${item.source})`);
      parts.push(`Requested at: ${item.ts}`);
      const latencyLines = formatLatencyTxt(item.latency);
      if (latencyLines.length > 0) {
        parts.push('Timing:');
        latencyLines.forEach((line) => parts.push(`  ${line}`));
      }
      parts.push(`Question (resolved): ${item.question.resolved}`);
      const pipelineLines = formatPipelineTxt(item.pipeline);
      if (pipelineLines.length > 0) {
        parts.push('Pipeline:');
        pipelineLines.forEach((line) => parts.push(`  ${line}`));
      }
      parts.push(`Answer: ${item.answer.spoken}`);
      if (item.answer.detailed?.trim()) parts.push(`Detailed: ${item.answer.detailed}`);
      if (item.answer.risk?.trim()) parts.push(`Risk note: ${item.answer.risk}`);
    });
  }

  return parts.join('\n');
}

export function formatInterviewSessionJson(exportData: InterviewSessionExport): string {
  return JSON.stringify(exportData, null, 2);
}

function speakerRu(speaker: string): string {
  return speaker === 'me' ? 'Вы' : 'Интервьюер';
}

/** Человекочитаемый Markdown для разбора после собеседования (в отличие от TXT/JSON для AI). */
export function formatInterviewSessionMd(exportData: InterviewSessionExport): string {
  const parts: string[] = [`# ${exportData.title || 'Разбор интервью'}`, ''];
  const started = exportData.startedAt ? new Date(exportData.startedAt).toLocaleString() : null;
  if (started) parts.push(`**Дата:** ${started}`, '');

  if (exportData.summary) {
    parts.push('## Итоги', '', exportData.summary, '');
  }

  if (exportData.exchanges.length > 0) {
    parts.push('## Вопросы и ответы', '');
    exportData.exchanges.forEach((item, index) => {
      parts.push(`### ${index + 1}. ${item.question.resolved}`, '');
      parts.push(item.answer.spoken, '');
      if (item.answer.detailed?.trim()) {
        parts.push('<details><summary>Подробный вариант</summary>', '', item.answer.detailed, '', '</details>', '');
      }
      if (item.answer.risk?.trim()) {
        parts.push(`> Риски: ${item.answer.risk}`, '');
      }
    });
  }

  if (exportData.transcript.length > 0) {
    parts.push('## Транскрипт', '');
    for (const line of exportData.transcript) {
      parts.push(`**${speakerRu(line.speaker)}:** ${line.text}`, '');
    }
  }

  return parts.join('\n');
}

function downloadTextFile(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function exportFilename(exportData: InterviewSessionExport, ext: string): string {
  const ts = exportData.exportedAt.replace(/[:.]/g, '-');
  const sid = exportData.sessionId?.slice(0, 8) ?? 'local';
  return `interview-session-${sid}-${ts}.${ext}`;
}

export function exportInterviewSessionJson(exportData: InterviewSessionExport): void {
  downloadTextFile(
    formatInterviewSessionJson(exportData),
    exportFilename(exportData, 'json'),
    'application/json',
  );
}

export function exportInterviewSessionTxt(exportData: InterviewSessionExport): void {
  downloadTextFile(
    formatInterviewSessionTxt(exportData),
    exportFilename(exportData, 'txt'),
    'text/plain;charset=utf-8',
  );
}

export function exportInterviewSessionMd(exportData: InterviewSessionExport): void {
  downloadTextFile(
    formatInterviewSessionMd(exportData),
    exportFilename(exportData, 'md'),
    'text/markdown;charset=utf-8',
  );
}
