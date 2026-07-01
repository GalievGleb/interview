import type { AppliedCorrection, IntentCorrection } from '@interview/shared';

export interface SttDebugInfo {
  rawTranscript: string;
  glossaryCorrected: string;
  intentCorrected: string;
  /** @deprecated use intentCorrected */
  correctedTranscript: string;
  interimTranscript?: string;
  finalTranscript?: string;
  correctedFinalTranscript?: string;
  llmCorrectedTranscript?: string;
  corrections: AppliedCorrection[];
  intentCorrections: IntentCorrection[];
  intentConfidence?: string;
  intentReason?: string;
  ambiguity?: string;
  questionIntent?: string;
  answerStrategy?: string;
  resumeContextUsed?: boolean;
  resumeContextLevel?: string;
  resumeContextReason?: string;
  resolvedQuestion?: string;
  previousTopic?: string;
  currentCanonicalTopic?: string;
  isFollowUp?: boolean;
  usedPreviousContext?: boolean;
  followUpReason?: string;
  answerTriggered?: boolean;
  waitReason?: string;
  resetPreviousTopic?: boolean;
  resetPreviousTopicReason?: string;
  wasPreviousTopicUsed?: boolean;
  hallucinationRisk?: string;
  resumeFactSource?: string;
  sttEngine?: string;
  sttModel?: string;
  partialSttModel?: string;
  sampleRate?: number;
  timeToFinalMs?: number;
  timeToAnswerMs?: number;
  timeToFirstPartialMs?: number;
  finalTranscriptionMs?: number;
  correctionMs?: number;
  llmFirstTokenMs?: number;
  llmTotalMs?: number;
  totalEndToEndMs?: number;
}

interface SttDebugPanelProps {
  debug: SttDebugInfo | null;
  show: boolean;
  onToggle: () => void;
}

export default function SttDebugPanel({ debug, show, onToggle }: SttDebugPanelProps) {
  return (
    <div className="border-t border-surface-border">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-1.5 text-left text-[10px] text-ink-faint hover:bg-surface-hover"
      >
        <span>Дебаг {debug?.sttEngine ? `· ${debug.sttEngine}` : ''}</span>
        <span>{show ? '▾' : '▸'}</span>
      </button>
      {show && (
        <div className="space-y-2 border-t border-surface-border bg-surface-light px-4 py-3 text-xs">
          {!debug ? (
            <p className="text-ink-faint">Нет данных — задайте вопрос в live-режиме.</p>
          ) : (
            <>
              {debug.interimTranscript && (
                <Row label="Промежуточный транскрипт" value={debug.interimTranscript} />
              )}
              <Row label="Сырой транскрипт" value={debug.rawTranscript} />
              <Row label="Финальный транскрипт" value={debug.finalTranscript ?? debug.rawTranscript} />
              <Row label="Исправлено по глоссарию" value={debug.glossaryCorrected} />
              <Row
                label="Исправленный финал"
                value={debug.correctedFinalTranscript ?? debug.glossaryCorrected}
              />
              <Row label="Исправлено по смыслу" value={debug.intentCorrected} />
              {debug.resolvedQuestion && debug.resolvedQuestion !== debug.intentCorrected && (
                <Row label="Распознанный вопрос" value={debug.resolvedQuestion} />
              )}
              <Row label="Предыдущая тема" value={debug.previousTopic ?? '—'} />
              <Row label="Текущая тема" value={debug.currentCanonicalTopic ?? '—'} />
              <Row
                label="Использована предыдущая тема"
                value={debug.wasPreviousTopicUsed != null ? String(debug.wasPreviousTopicUsed) : '—'}
              />
              <Row
                label="Сброс предыдущей темы"
                value={debug.resetPreviousTopic != null ? String(debug.resetPreviousTopic) : '—'}
              />
              <Row label="Причина сброса" value={debug.resetPreviousTopicReason ?? '—'} />
              <Row label="Риск галлюцинации" value={debug.hallucinationRisk ?? '—'} />
              <Row label="Источник фактов из резюме" value={debug.resumeFactSource ?? '—'} />
              <Row label="Уточняющий вопрос" value={debug.isFollowUp != null ? String(debug.isFollowUp) : '—'} />
              <Row
                label="Использован предыдущий контекст"
                value={debug.usedPreviousContext != null ? String(debug.usedPreviousContext) : '—'}
              />
              <Row label="Причина уточнения" value={debug.followUpReason ?? '—'} />
              <Row
                label="Ответ запущен"
                value={debug.answerTriggered != null ? String(debug.answerTriggered) : '—'}
              />
              <Row label="Причина ожидания" value={debug.waitReason ?? '—'} />
              {debug.llmCorrectedTranscript &&
                debug.llmCorrectedTranscript !== debug.intentCorrected && (
                  <Row label="Исправлено LLM" value={debug.llmCorrectedTranscript} />
                )}
              <div>
                <p className="mb-1 font-medium text-ink-muted">Исправления терминов</p>
                {debug.corrections.length === 0 ? (
                  <p className="text-ink-faint">—</p>
                ) : (
                  <ul className="space-y-0.5 text-ink">
                    {debug.corrections.map((c, i) => (
                      <li key={i}>
                        «{c.from}» → <span className="text-accent">{c.to}</span>{' '}
                        <span className="text-ink-faint">({c.confidence})</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <p className="mb-1 font-medium text-ink-muted">Исправления по смыслу</p>
                {debug.intentCorrections.length === 0 ? (
                  <p className="text-ink-faint">—</p>
                ) : (
                  <ul className="space-y-0.5 text-ink">
                    {debug.intentCorrections.map((c, i) => (
                      <li key={i}>
                        «{c.from}» → <span className="text-accent">{c.to}</span>{' '}
                        <span className="text-ink-faint">({c.confidence})</span>
                        {c.reason ? (
                          <span className="block text-ink-faint">{c.reason}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <Row label="Уверенность" value={debug.intentConfidence ?? '—'} />
              <Row label="Причина (смысл)" value={debug.intentReason ?? '—'} />
              <Row label="Неоднозначность" value={debug.ambiguity ?? '—'} />
              <Row label="Смысл вопроса" value={debug.questionIntent ?? '—'} />
              <Row label="Стратегия ответа" value={debug.answerStrategy ?? '—'} />
              <Row
                label="Использован контекст резюме"
                value={
                  debug.resumeContextUsed != null
                    ? debug.resumeContextUsed
                      ? `да (${debug.resumeContextLevel ?? 'полный'})`
                      : `нет (${debug.resumeContextLevel ?? 'нет'})`
                    : '—'
                }
              />
              <Row label="Причина (контекст резюме)" value={debug.resumeContextReason ?? '—'} />
              <Row label="Движок STT" value={debug.sttEngine ?? '—'} />
              <Row label="Финальная модель STT" value={debug.sttModel ?? '—'} />
              <Row label="Промежуточная модель STT" value={debug.partialSttModel ?? '—'} />
              <Row label="Частота дискретизации" value={debug.sampleRate ? `${debug.sampleRate} Гц` : '—'} />
              <Row
                label="Время до первого partial"
                value={
                  debug.timeToFirstPartialMs != null
                    ? `${Math.round(debug.timeToFirstPartialMs)} мс`
                    : '—'
                }
              />
              <Row
                label="Финальное распознавание"
                value={
                  debug.finalTranscriptionMs != null
                    ? `${Math.round(debug.finalTranscriptionMs)} мс`
                    : '—'
                }
              />
              <Row
                label="Коррекция по глоссарию"
                value={debug.correctionMs != null ? `${Math.round(debug.correctionMs)} мс` : '—'}
              />
              <Row
                label="Время до финала"
                value={debug.timeToFinalMs != null ? `${Math.round(debug.timeToFinalMs)} мс` : '—'}
              />
              <Row
                label="Первый токен LLM"
                value={
                  debug.llmFirstTokenMs != null ? `${Math.round(debug.llmFirstTokenMs)} мс` : '—'
                }
              />
              <Row
                label="LLM всего"
                value={debug.llmTotalMs != null ? `${Math.round(debug.llmTotalMs)} мс` : '—'}
              />
              <Row
                label="Время до ответа"
                value={debug.timeToAnswerMs != null ? `${Math.round(debug.timeToAnswerMs)} мс` : '—'}
              />
              <Row
                label="От начала до конца"
                value={
                  debug.totalEndToEndMs != null ? `${Math.round(debug.totalEndToEndMs)} мс` : '—'
                }
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-medium text-ink-muted">{label}</p>
      <p className="whitespace-pre-wrap text-ink">{value || '—'}</p>
    </div>
  );
}
