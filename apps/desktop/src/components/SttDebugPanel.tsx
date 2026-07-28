export interface SttDebugInfo {
  rawTranscript: string;
  normalizedTranscript: string;
  finalTranscript?: string;
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
  sampleRate?: number;
  timeToFinalMs?: number;
  timeToAnswerMs?: number;
  finalTranscriptionMs?: number;
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
              <Row label="Сырой транскрипт" value={debug.rawTranscript} />
              <Row label="Финальный транскрипт" value={debug.finalTranscript ?? debug.rawTranscript} />
              {debug.normalizedTranscript !== debug.rawTranscript && (
                <Row label="Нормализованный текст" value={debug.normalizedTranscript} />
              )}
              {debug.resolvedQuestion && debug.resolvedQuestion !== debug.normalizedTranscript && (
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
              <Row label="Модель STT" value={debug.sttModel ?? '—'} />
              <Row label="Частота дискретизации" value={debug.sampleRate ? `${debug.sampleRate} Гц` : '—'} />
              <Row
                label="Финальное распознавание"
                value={
                  debug.finalTranscriptionMs != null
                    ? `${Math.round(debug.finalTranscriptionMs)} мс`
                    : '—'
                }
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
