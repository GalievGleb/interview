import { useState } from 'react';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';

/** 👍/👎 на сгенерированный ответ — сырьё для тюнинга промптов и глоссария. */
export default function FeedbackButtons({
  question,
  answer,
  rawTranscript,
  source = 'live',
}: {
  question: string;
  answer: string;
  rawTranscript?: string | null;
  source?: 'live' | 'manual';
}) {
  const { t } = useI18n();
  const [sent, setSent] = useState<'up' | 'down' | null>(null);

  const send = (verdict: 'up' | 'down') => {
    if (sent) return;
    setSent(verdict);
    void api
      .recordFeedback({ verdict, question, answer, raw_transcript: rawTranscript ?? null, source })
      .catch(() => {
        /* best-effort — не мешаем пользователю */
      });
  };

  const base =
    'flex h-7 w-7 items-center justify-center rounded-lg border text-ink-faint transition-colors disabled:cursor-default';

  return (
    <span className="inline-flex items-center gap-1" role="group" aria-label={t('answer.feedbackAria')}>
      <button
        type="button"
        disabled={!!sent}
        onClick={() => send('up')}
        title={t('answer.good')}
        className={`${base} ${
          sent === 'up'
            ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400'
            : 'border-surface-border hover:border-surface-border-strong hover:text-ink'
        } ${sent === 'down' ? 'opacity-40' : ''}`}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
        </svg>
      </button>
      <button
        type="button"
        disabled={!!sent}
        onClick={() => send('down')}
        title={t('answer.bad')}
        className={`${base} ${
          sent === 'down'
            ? 'border-red-500/40 bg-red-500/15 text-red-400'
            : 'border-surface-border hover:border-surface-border-strong hover:text-ink'
        } ${sent === 'up' ? 'opacity-40' : ''}`}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 14V2M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
        </svg>
      </button>
    </span>
  );
}
