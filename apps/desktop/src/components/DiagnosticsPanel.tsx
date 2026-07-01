import { useEffect, useState } from 'react';
import { api, type SttDiagnostics } from '../lib/api';
import { useApp } from '../context/AppContext';
import { readSkipped, type SkippedEntry } from '../lib/skippedLog';

interface MicStatus {
  count: number;
  permission: string;
}

interface LastTimings {
  firstPartialMs: number | null;
  transcribeMs: number | null;
  sttFinalMs: number | null;
  llmFirstMs: number | null;
  llmTotalMs: number | null;
  totalMs: number;
  at: number;
}

function secs(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return `${(ms / 1000).toFixed(2)} s`;
}

function readTimings(): LastTimings | null {
  try {
    const raw = localStorage.getItem('skillcue:lastTimings');
    return raw ? (JSON.parse(raw) as LastTimings) : null;
  } catch {
    return null;
  }
}

export default function DiagnosticsPanel() {
  const { backendOnline } = useApp();
  const [diag, setDiag] = useState<SttDiagnostics | null>(null);
  const [mic, setMic] = useState<MicStatus | null>(null);
  const [timings, setTimings] = useState<LastTimings | null>(readTimings);
  const [skipped, setSkipped] = useState<SkippedEntry[]>(readSkipped);
  const [error, setError] = useState('');

  const refresh = () => {
    setTimings(readTimings());
    setSkipped(readSkipped());
    api
      .sttDiagnostics()
      .then(setDiag)
      .catch((e) => setError(e instanceof Error ? e.message : 'Нет данных'));
  };

  useEffect(() => {
    refresh();
    let alive = true;
    void (async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputs = devices.filter((d) => d.kind === 'audioinput');
        let permission = 'unknown';
        try {
          const perms = navigator.permissions as
            | { query?: (d: { name: string }) => Promise<{ state: string }> }
            | undefined;
          const p = await perms?.query?.({ name: 'microphone' });
          if (p) permission = p.state;
        } catch {
          /* Permissions API not available */
        }
        if (alive) setMic({ count: inputs.length, permission });
      } catch {
        if (alive) setMic({ count: 0, permission: 'unknown' });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const ready = diag?.reason === 'ready';

  const stages = timings
    ? [
        { name: 'STT первый partial', ms: timings.firstPartialMs ?? 0, color: '#38bdf8' },
        { name: 'STT финальный', ms: timings.transcribeMs ?? 0, color: '#34d399' },
        { name: 'LLM первый токен', ms: timings.llmFirstMs ?? 0, color: '#fbbf24' },
        {
          name: 'LLM завершение',
          ms: Math.max((timings.llmTotalMs ?? 0) - (timings.llmFirstMs ?? 0), 0),
          color: '#34c77b',
        },
      ].filter((s) => s.ms > 0)
    : [];
  const totalStage = stages.reduce((sum, s) => sum + s.ms, 0);
  let cumulative = 0;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button type="button" onClick={refresh} className="btn-secondary btn-sm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" />
          </svg>
          Обновить
        </button>
      </div>

      {/* Latency waterfall */}
      <div className="sc-card p-5">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-[15px] font-semibold text-ink">Разбивка задержки ответа</h3>
          <span className="text-xs text-ink-faint">
            Всего <span className="sc-mono font-medium text-ink">{secs(timings?.totalMs ?? totalStage)}</span>
          </span>
        </div>
        {stages.length === 0 ? (
          <div className="sc-empty rounded-xl border border-dashed border-surface-border py-8">
            Запустите ответ в live-режиме — здесь появится разбивка задержек по этапам.
          </div>
        ) : (
          <>
            <div className="flex h-9 w-full overflow-hidden rounded-lg">
              {stages.map((s) => (
                <div
                  key={s.name}
                  style={{ width: `${(s.ms / totalStage) * 100}%`, backgroundColor: s.color }}
                  title={`${s.name}: ${secs(s.ms)}`}
                />
              ))}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              {stages.map((s) => {
                cumulative += s.ms;
                return (
                  <div key={s.name}>
                    <p className="flex items-center gap-1.5 text-[11px] text-ink-faint">
                      <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: s.color }} />
                      {s.name}
                    </p>
                    <p className="sc-mono mt-1 text-lg font-semibold text-ink">{secs(s.ms)}</p>
                    <p className="sc-mono mt-0.5 text-[11px] text-ink-faint">@ {secs(cumulative)}</p>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Telemetry */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="sc-card p-5">
          <h4 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
            <span className="text-emerald-400">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4M8 22h8" />
              </svg>
            </span>
            Распознавание речи
          </h4>
          <DiagRow label="Провайдер" value={diag?.provider ?? '—'} />
          <DiagRow label="Модель" value={diag?.model ?? diag?.localModel ?? '—'} />
          <DiagRow label="Устройство" value={(diag?.device ?? '—').toUpperCase()} />
          <DiagRow
            label="Средняя задержка STT"
            value={diag?.avgBenchmarkLatencyMs != null ? secs(diag.avgBenchmarkLatencyMs) : '—'}
            ok={diag?.avgBenchmarkLatencyMs != null && diag.avgBenchmarkLatencyMs < 1500}
          />
          <DiagRow label="Время до первого partial" value={secs(timings?.firstPartialMs)} />
          <DiagRow label="Конец речи → финал" value={secs(timings?.sttFinalMs)} />
        </div>

        <div className="sc-card p-5">
          <h4 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
            <span className="text-accent">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z" />
              </svg>
            </span>
            Языковая модель
          </h4>
          <DiagRow label="Модель" value="gpt-4o-mini" />
          <DiagRow label="Первый токен LLM" value={secs(timings?.llmFirstMs)} ok={timings?.llmFirstMs != null && timings.llmFirstMs < 1500} />
          <DiagRow label="Общая задержка ответа" value={secs(timings?.llmTotalMs ?? timings?.totalMs)} />
          <DiagRow label="Стриминг" value="включён" ok />
          <DiagRow
            label="Последний ответ"
            value={timings ? new Date(timings.at).toLocaleTimeString() : '—'}
          />
        </div>
      </div>

      {/* Audio & privacy + Last errors */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="sc-card p-5">
          <h4 className="mb-3 text-sm font-semibold text-ink">Аудио и приватность</h4>
          <DiagRow
            label="Микрофон"
            value={mic ? `устройств: ${mic.count} · ${mic.permission}` : '—'}
            ok={mic ? mic.count > 0 && mic.permission !== 'denied' : undefined}
          />
          <DiagRow label="Приватность" value="Локально" ok />
          <DiagRow label="Статус модели" value={diag ? (ready ? 'готова' : diag.reason) : '—'} ok={ready} />
          <DiagRow label="Использование ресурсов" value={diag?.resourceUsage || '—'} />
        </div>

        <div className="sc-card p-5">
          <h4 className="mb-3 text-sm font-semibold text-ink">Последние ошибки</h4>
          <DiagRow label="Backend" value={backendOnline ? 'в сети' : 'не в сети'} ok={backendOnline} />
          <DiagRow label="Последняя ошибка STT" value={diag?.lastError ?? 'нет'} ok={!diag?.lastError} />
          <DiagRow
            label="Последний бенчмарк"
            value={diag?.lastBenchmarkAt ? new Date(diag.lastBenchmarkAt).toLocaleString() : '—'}
          />
        </div>
      </div>

      {skipped.length > 0 && (
        <div className="sc-card p-5">
          <h4 className="mb-3 text-sm font-semibold text-ink">Недавно пропущенные транскрипты</h4>
          <ul className="space-y-1.5">
            {skipped.map((s, i) => (
              <li key={i} className="flex items-start gap-3 text-xs">
                <span className="sc-mono shrink-0 text-ink-faint">
                  {new Date(s.at).toLocaleTimeString()}
                </span>
                <span className="shrink-0 text-amber-300">⚠ {s.reason}</span>
                <span className="sc-mono truncate text-ink-muted">{s.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}

function DiagRow({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  const tone =
    ok === undefined ? 'sc-diag-row__value' : ok ? 'sc-diag-row__value sc-diag-row__value--ok' : 'sc-diag-row__value sc-diag-row__value--warn';
  return (
    <div className="sc-diag-row">
      <span className="sc-diag-row__label">{label}</span>
      <span className={tone}>{value}</span>
    </div>
  );
}
