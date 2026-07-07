import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CopilotAnswerEntry } from '../../lib/interviewSessionExport';
import type { AnswerRevisionMode } from '../../lib/answerRevision';
import type { LiveSessionStatus } from '../ui/StatusBadge';
import { api, type AnswerVariantKind } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import AnswerActions from './AnswerActions';
import AnswerTabs, { ANSWER_TABS, AnswerTab } from './AnswerTabs';
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
  onEditEntry?: (entryId: string, text: string) => void;
  footer?: ReactNode;
}

function GeneratingHint() {
  const { t } = useI18n();
  return (
    <div className="cockpit-empty py-6">
      <div className="mb-2 flex items-center gap-2 text-sm text-ink-muted">
        <span className="h-2 w-2 animate-pulse rounded-full bg-accent shadow-[0_0_8px_rgba(52,199,123,0.5)]" />
        {t('answer.generating')}
      </div>
    </div>
  );
}

/** Inline-редактор текста ответа: textarea + сохранить/отменить. */
function InlineAnswerEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(initial);
  return (
    <div className="space-y-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={Math.min(14, Math.max(5, initial.split('\n').length + 2))}
        className="field w-full resize-y text-sm leading-relaxed"
        autoFocus
      />
      <div className="flex items-center justify-end gap-2">
        <button type="button" className="btn-secondary btn-sm" onClick={onCancel}>
          {t('answer.cancel')}
        </button>
        <button
          type="button"
          className="btn-primary btn-sm"
          disabled={!text.trim()}
          onClick={() => onSave(text.trim())}
        >
          {t('common.save')}
        </button>
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
  onEditEntry,
  footer,
}: AnswerPanelProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Ленивая генерация вариантов ответа по табам: кэш `${entryId}:${variant}`.
  const [variantCache, setVariantCache] = useState<Record<string, string>>({});
  const [variantLoadingKey, setVariantLoadingKey] = useState<string | null>(null);
  const [variantError, setVariantError] = useState('');

  // Follow the streaming answer — but only if the user is already near the
  // bottom, so we never yank the view while they scroll back through history.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [displayStream, history.length, isGenerating]);

  const showEmpty = history.length === 0 && !displayStream && !isGenerating;
  const latestEntry = history.length > 0 ? history[history.length - 1] : null;
  const variantTarget = tab !== 'spoken' ? latestEntry : null;
  const variantKey = variantTarget ? `${variantTarget.id}:${tab}` : null;
  const variantText = variantKey ? variantCache[variantKey] : undefined;

  useEffect(() => {
    if (!variantTarget || !variantKey || tab === 'spoken') return;
    if (variantCache[variantKey] !== undefined) return;
    let cancelled = false;
    setVariantLoadingKey(variantKey);
    setVariantError('');
    api
      .answerVariant(
        variantTarget.question,
        variantTarget.spoken,
        tab as AnswerVariantKind,
        variantTarget.id,
      )
      .then((res) => {
        if (cancelled) return;
        setVariantCache((prev) => ({ ...prev, [variantKey]: res.text }));
      })
      .catch((err) => {
        if (cancelled) return;
        setVariantError(err instanceof Error ? err.message : t('answer.variantError'));
      })
      .finally(() => {
        if (!cancelled) setVariantLoadingKey(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variantKey]);

  const statusHint =
    status === 'processing'
      ? t('answer.generating')
      : status === 'listening' && active
        ? t('answer.listening')
        : revising
          ? t('answer.revising')
          : null;

  const tabDef = ANSWER_TABS.find((td) => td.key === tab);
  const tabLabel = tabDef ? t(tabDef.labelKey) : tab;

  return (
    <div className="cockpit-panel cockpit-panel-focus flex min-h-0 flex-col lg:min-w-0 lg:flex-[1.15]">
      <AnswerTabs
        tab={tab}
        onTabChange={onTabChange}
        trailing={
          statusHint ? (
            <span>{statusHint}</span>
          ) : isGenerating && displayStream ? (
            <span>{t('answer.typing')}</span>
          ) : null
        }
      />

      <div ref={scrollRef} className="answer-scroll min-h-0 flex-1 px-4 py-4">
        {showEmpty && (
          <CockpitEmptyState
            icon={<AnswerEmptyIcon />}
            title={liveHint ? liveHint : active ? t('answer.waiting') : t('answer.willAppear')}
            hint={liveHint ? t('answer.hint.liveHint') : t('answer.hint.default')}
          />
        )}

        {tab !== 'spoken' ? (
          <div className="space-y-4">
            {!variantTarget && !showEmpty && (
              <CockpitEmptyState
                icon={<AnswerEmptyIcon />}
                title={`${t('answer.variant.emptyPre')} «${tabLabel}» ${t('answer.variant.emptyPost')}`}
                hint={`${t('answer.variant.hintPre')} «${t('answer.tab.spoken')}».`}
              />
            )}
            {variantTarget && (
              <article className="skillcue-answer-card skillcue-answer-card--active">
                <div className="skillcue-answer-label">
                  <span>{tabLabel}</span>
                  <span>{t('answer.fromLast')}</span>
                </div>
                <div className="mb-3 flex items-start justify-between gap-3">
                  <p className="answer-question min-w-0 flex-1">
                    {t('answer.questionPrefix')} {variantTarget.question}
                  </p>
                  {variantText ? <AnswerActions answer={variantText} /> : null}
                </div>
                {variantLoadingKey === variantKey ? (
                  <GeneratingHint />
                ) : variantError ? (
                  <p className="text-sm text-red-400">{variantError}</p>
                ) : variantText ? (
                  <StructuredAnswer text={variantText} />
                ) : null}
              </article>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {history.map((item, i) => {
              const latestCompleted = i === history.length - 1 && !displayStream;
              const isEditing = editingId === item.id;
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
                      <span>{t('answer.sayThis')}</span>
                      <span>{t('answer.readyToSay')}</span>
                    </div>
                  )}
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <p className="answer-question min-w-0 flex-1">{t('answer.questionPrefix')} {item.question}</p>
                    {!isEditing && (
                      <AnswerActions
                        answer={item.spoken}
                        question={item.question}
                        disabled={isGenerating}
                        revising={revising}
                        onRevise={
                          onReviseEntry
                            ? (mode) => onReviseEntry(item.id, item.question, item.spoken, mode)
                            : undefined
                        }
                        onEdit={onEditEntry ? () => setEditingId(item.id) : undefined}
                      />
                    )}
                  </div>
                  {isEditing && onEditEntry ? (
                    <InlineAnswerEditor
                      initial={item.spoken}
                      onSave={(text) => {
                        onEditEntry(item.id, text);
                        setEditingId(null);
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    <StructuredAnswer text={item.spoken} />
                  )}
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
                  <span>{t('answer.sayThis')}</span>
                  <span>{displayStream ? t('answer.readyToSay') : t('answer.composing')}</span>
                </div>
                {activeQuestion && (
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <p className="answer-question min-w-0 flex-1">{t('answer.questionPrefix')} {activeQuestion}</p>
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
        )}
      </div>

      {footer}
    </div>
  );
}
