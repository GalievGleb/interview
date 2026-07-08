import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { useI18n, type I18nKey } from '../lib/i18n';
import { launchLive } from '../lib/launchLive';

/**
 * Демо «как это работает» — скриптованная live-сессия без микрофона, STT и
 * AI-ключей. Человек видит главный сценарий продукта (речь → вопрос → готовый
 * ответ за секунды) ДО того, как что-либо настроил. Ничего не отправляется
 * и не записывается — это воспроизведение заготовленного сценария.
 */

interface DemoTurn {
  /** Реплика интервьюера, появляется частями — как partial'ы из STT. */
  speech: string[];
  question: string;
  answer: string;
}

interface DemoLine {
  speaker: 'other' | 'me';
  text: string;
  final: boolean;
}

type Phase = 'idle' | 'listening' | 'transcribing' | 'answering' | 'done';

const PHASE_KEY: Record<Phase, I18nKey> = {
  idle: 'demo.phase.idle',
  listening: 'demo.phase.listening',
  transcribing: 'demo.phase.transcribing',
  answering: 'demo.phase.answering',
  done: 'demo.phase.done',
};

export default function DemoPage() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { hasAnyKey, hasStt } = useApp();
  const demoTurns = useMemo<DemoTurn[]>(
    () => [
      {
        speech: [t('demo.t1.s1'), t('demo.t1.s2')],
        question: t('demo.t1.q'),
        answer: t('demo.t1.a'),
      },
      {
        speech: [t('demo.t2.s1'), t('demo.t2.s2')],
        question: t('demo.t2.q'),
        answer: t('demo.t2.a'),
      },
    ],
    [t],
  );
  const [phase, setPhase] = useState<Phase>('idle');
  const [lines, setLines] = useState<DemoLine[]>([]);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [sttMs, setSttMs] = useState<number | null>(null);
  const [llmMs, setLlmMs] = useState<number | null>(null);
  const runRef = useRef(0);

  const stop = useCallback(() => {
    runRef.current += 1;
  }, []);

  useEffect(() => stop, [stop]);

  const play = useCallback(async () => {
    const run = ++runRef.current;
    const alive = () => runRef.current === run;
    const sleep = (ms: number) =>
      new Promise<void>((r) => {
        setTimeout(r, ms);
      });

    setLines([]);
    setQuestion('');
    setAnswer('');
    setSttMs(null);
    setLlmMs(null);

    for (const turn of demoTurns) {
      if (!alive()) return;
      setPhase('listening');
      setQuestion('');
      setAnswer('');

      // Реплика интервьюера приходит частями, как partial'ы из Whisper.
      for (let i = 0; i < turn.speech.length; i += 1) {
        if (!alive()) return;
        const text = turn.speech[i];
        const final = i === turn.speech.length - 1;
        setLines((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.speaker === 'other' && !last.final) {
            next[next.length - 1] = { speaker: 'other', text, final };
          } else {
            next.push({ speaker: 'other', text, final });
          }
          return next;
        });
        await sleep(final ? 500 : 900);
      }

      if (!alive()) return;
      setPhase('transcribing');
      await sleep(600);
      if (!alive()) return;
      setSttMs(600);
      setQuestion(turn.question);
      setPhase('answering');

      // Ответ стримится токенами — как настоящий SSE от модели.
      const words = turn.answer.split(' ');
      const llmStart = 900;
      await sleep(llmStart);
      for (let i = 0; i < words.length; i += 1) {
        if (!alive()) return;
        setAnswer(words.slice(0, i + 1).join(' '));
        await sleep(38);
      }
      if (!alive()) return;
      setLlmMs(llmStart + words.length * 38);
      await sleep(1600);
    }

    if (!alive()) return;
    setPhase('done');
  }, [demoTurns]);

  const setupReady = hasAnyKey && hasStt;

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="sc-badge sc-badge--accent">{t('demo.badge')}</span>
        <h1 className="text-lg font-bold text-ink">{t('demo.title')}</h1>
        <span className="ml-auto flex items-center gap-2 text-[12px] text-ink-muted">
          <span
            className={`sc-dot ${
              phase === 'answering' || phase === 'transcribing'
                ? 'sc-dot--processing animate-pulse'
                : phase === 'listening'
                  ? 'sc-dot--live'
                  : ''
            }`}
          />
          {t(PHASE_KEY[phase])}
        </span>
        {sttMs !== null && (
          <span className="sc-badge font-mono text-[11px]">STT {(sttMs / 1000).toFixed(1)}s</span>
        )}
        {llmMs !== null && (
          <span className="sc-badge font-mono text-[11px]">LLM {(llmMs / 1000).toFixed(1)}s</span>
        )}
      </div>

      <p className="mb-4 text-sm text-ink-muted">{t('demo.disclaimer')}</p>

      {phase === 'idle' ? (
        <div className="sc-card flex flex-1 flex-col items-center justify-center gap-4 p-10 text-center">
          <p className="max-w-md text-sm text-ink-muted">{t('demo.intro')}</p>
          <button type="button" className="btn-primary" onClick={() => void play()}>
            {t('demo.start')}
          </button>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,360px)_1fr] gap-4">
          {/* Транскрипт */}
          <div className="sc-card flex min-h-0 flex-col p-4">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
              {t('overlay.liveTranscript')}
            </p>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
              {lines.map((line, i) => (
                <div key={i} className="text-[13px] leading-relaxed">
                  <span className="mr-1.5 text-[11px] font-semibold uppercase text-sky-400">
                    {t('history.speaker.other')}
                  </span>
                  <span className={line.final ? 'text-ink' : 'text-ink-muted'}>
                    {line.text}
                    {!line.final && <span className="animate-pulse">▍</span>}
                  </span>
                </div>
              ))}
              {lines.length === 0 && (
                <p className="text-[13px] text-ink-faint">{t('demo.waiting')}</p>
              )}
            </div>
          </div>

          {/* Ответ */}
          <div className="sc-card flex min-h-0 flex-col p-4">
            {question ? (
              <>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                  {t('prep.smoke.question')}
                </p>
                <p className="mb-3 text-[13.5px] font-semibold text-ink">{question}</p>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                  {t('demo.hintLabel')}
                </p>
                <div className="min-h-0 flex-1 overflow-y-auto text-[14px] leading-relaxed text-ink">
                  {answer}
                  {phase === 'answering' && <span className="animate-pulse text-accent">▍</span>}
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-[13px] text-ink-faint">
                {phase === 'done' ? t('demo.phase.done') : t('demo.answerHint')}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Финал: куда идти дальше */}
      {phase === 'done' && (
        <div className="sc-card mt-4 flex flex-wrap items-center gap-3 p-4">
          <p className="min-w-0 flex-1 text-sm text-ink-muted">
            {setupReady ? t('demo.finalReady') : t('demo.finalNotReady')}
          </p>
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => void play()}
          >
            {t('demo.again')}
          </button>
          <button
            type="button"
            className="btn-primary btn-sm"
            onClick={() =>
              setupReady ? launchLive(() => navigate('/overlay')) : navigate('/settings?tab=ai')
            }
          >
            {setupReady ? t('demo.startLive') : t('demo.setup')}
          </button>

        </div>
      )}
    </div>
  );
}
