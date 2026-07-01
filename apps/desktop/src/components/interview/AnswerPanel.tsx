import { useEffect, useRef, type ReactNode } from 'react';
import type { CopilotAnswerEntry } from '../../lib/interviewSessionExport';
import type { AnswerRevisionMode } from '../../lib/answerRevision';
import type { LiveSessionStatus } from '../ui/StatusBadge';
import AnswerActions from './AnswerActions';
import AnswerTabs, { AnswerTab } from './AnswerTabs';
import CockpitEmptyState, { AnswerEmptyIcon } from './CockpitEmptyState';
import StructuredAnswer from './StructuredAnswer';

interface AnswerPanelProps {
  tab: AnswerTab;
  onTabChange: (tab: AnswerTab) => void;
  history: CopilotAnswerEntry[];
  activeQuestion: string;
  displayStream: string;
  isGenerating: boolean;
  status: LiveSessionStatus;
  active: boolean;
  liveHint?: string;
  revising?: boolean;
  onReviseEntry?: (
    entryId: string,
    question: string,
    answer: string,
    mode: AnswerRevisionMode,
  ) => void;
  onReviseActive?: (question: string, answer: string, mode: AnswerRevisionMode) => void;
  footer?: ReactNode;
}

function GeneratingHint() {
  return (
    <div className="cockpit-empty py-6">
      <div className="mb-2 flex items-center gap-2 text-sm text-ink-muted">
        <span className="h-2 w-2 animate-pulse rounded-full bg-accent shadow-[0_0_8px_rgba(52,199,123,0.5)]" />
        Generating answer…
      </div>
    </div>
  );
}

export default function AnswerPanel({
  tab,
  onTabChange,
  history,
  activeQuestion,
  displayStream,
  isGenerating,
  status,
  active,
  liveHint,
  revising = false,
  onReviseEntry,
  onReviseActive,
  footer,
}: AnswerPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow the streaming answer — but only if the user is already near the
  // bottom, so we never yank the view while they scroll back through history.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [displayStream, history.length, isGenerating]);

  const showEmpty = history.length === 0 && !displayStream && !isGenerating;

  const statusHint =
    status === 'processing'
      ? 'Generating answer…'
      : status === 'listening' && active
        ? 'Listening…'
        : revising
          ? 'Revising answer…'
          : null;

  return (
    <div className="cockpit-panel cockpit-panel-focus flex min-h-0 flex-col lg:min-w-0 lg:flex-[1.15]">
      <AnswerTabs
        tab={tab}
        onTabChange={onTabChange}
        trailing={
          statusHint ? (
            <span>{statusHint}</span>
          ) : isGenerating && displayStream ? (
            <span>Streaming…</span>
          ) : null
        }
      />

      <div ref={scrollRef} className="answer-scroll min-h-0 flex-1 px-4 py-4">
        {showEmpty && (
          <CockpitEmptyState
            icon={<AnswerEmptyIcon />}
            title={
              liveHint
                ? liveHint
                : active
                  ? 'Waiting for a question…'
                  : 'Your answer will appear here'
            }
            hint={
              liveHint
                ? 'Speak the full question in one phrase, or use manual input below.'
                : 'Short, structured responses — ready to say aloud in the interview.'
            }
          />
        )}

        <div className="space-y-4">
          {history.map((item, i) => {
            const latestCompleted = i === history.length - 1 && !displayStream;
            return (
              <article
                key={item.id}
                className={
                  latestCompleted
                    ? 'skillcue-answer-card skillcue-answer-card--active'
                    : 'skillcue-answer-card skillcue-answer-card--past'
                }
              >
                {latestCompleted && (
                  <div className="skillcue-answer-label">
                    <span>Say this</span>
                    <span>Ready to read aloud</span>
                  </div>
                )}
                <div className="mb-3 flex items-start justify-between gap-3">
                  <p className="answer-question min-w-0 flex-1">Q: {item.question}</p>
                  <AnswerActions
                    answer={item.spoken}
                    disabled={isGenerating}
                    revising={revising}
                    onRevise={
                      onReviseEntry
                        ? (mode) => onReviseEntry(item.id, item.question, item.spoken, mode)
                        : undefined
                    }
                  />
                </div>
                <StructuredAnswer text={item.spoken} />
              </article>
            );
          })}

          {(displayStream || (isGenerating && activeQuestion)) && (
            <article
              className={
                displayStream
                  ? 'skillcue-answer-card skillcue-answer-card--active animate-scale-in'
                  : 'skillcue-answer-card skillcue-answer-card--pending'
              }
            >
              <div className="skillcue-answer-label">
                <span>Say this</span>
                <span>{displayStream ? 'Ready to read aloud' : 'Building answer'}</span>
              </div>
              {activeQuestion && (
                <div className="mb-3 flex items-start justify-between gap-3">
                  <p className="answer-question min-w-0 flex-1">Q: {activeQuestion}</p>
                  {displayStream ? (
                    <AnswerActions
                      answer={displayStream}
                      disabled={isGenerating && !displayStream}
                      revising={revising}
                      onRevise={
                        onReviseActive
                          ? (mode) => onReviseActive(activeQuestion, displayStream, mode)
                          : undefined
                      }
                    />
                  ) : null}
                </div>
              )}
              {displayStream ? (
                <StructuredAnswer text={displayStream} />
              ) : (
                <GeneratingHint />
              )}
            </article>
          )}
        </div>
      </div>

      {footer}
    </div>
  );
}
