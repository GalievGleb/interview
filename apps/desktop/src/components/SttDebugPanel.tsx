import type { AppliedCorrection, IntentCorrection } from '@interview/shared';

export interface SttDebugInfo {
  rawTranscript: string;
  glossaryCorrected: string;
  intentCorrected: string;
  /** @deprecated use intentCorrected */
  correctedTranscript: string;
  llmCorrectedTranscript?: string;
  corrections: AppliedCorrection[];
  intentCorrections: IntentCorrection[];
  intentConfidence?: string;
  intentReason?: string;
  ambiguity?: string;
  sttEngine?: string;
  sttModel?: string;
  sampleRate?: number;
  timeToFinalMs?: number;
  timeToAnswerMs?: number;
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
        className="flex w-full items-center justify-between px-4 py-2 text-left text-xs text-ink-muted hover:bg-surface-hover"
      >
        <span>STT Debug {debug?.sttEngine ? `· ${debug.sttEngine}` : ''}</span>
        <span>{show ? '▾' : '▸'}</span>
      </button>
      {show && (
        <div className="space-y-2 border-t border-surface-border bg-surface-light px-4 py-3 text-xs">
          {!debug ? (
            <p className="text-ink-faint">Нет данных — задайте вопрос в live-режиме.</p>
          ) : (
            <>
              <Row label="Raw transcript" value={debug.rawTranscript} />
              <Row label="Glossary corrected" value={debug.glossaryCorrected} />
              <Row label="Intent corrected" value={debug.intentCorrected} />
              {debug.llmCorrectedTranscript &&
                debug.llmCorrectedTranscript !== debug.intentCorrected && (
                  <Row label="LLM corrected" value={debug.llmCorrectedTranscript} />
                )}
              <div>
                <p className="mb-1 font-medium text-ink-muted">Term corrections</p>
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
                <p className="mb-1 font-medium text-ink-muted">Intent corrections</p>
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
              <Row label="Confidence" value={debug.intentConfidence ?? '—'} />
              <Row label="Intent reason" value={debug.intentReason ?? '—'} />
              <Row label="Ambiguity" value={debug.ambiguity ?? '—'} />
              <Row label="STT engine" value={debug.sttEngine ?? '—'} />
              <Row label="STT model" value={debug.sttModel ?? '—'} />
              <Row label="Sample rate" value={debug.sampleRate ? `${debug.sampleRate} Hz` : '—'} />
              <Row
                label="Time to final"
                value={debug.timeToFinalMs != null ? `${Math.round(debug.timeToFinalMs)} ms` : '—'}
              />
              <Row
                label="Time to answer"
                value={debug.timeToAnswerMs != null ? `${Math.round(debug.timeToAnswerMs)} ms` : '—'}
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
