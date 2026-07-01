import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  STT_PRIVACY_LOCAL,
  STT_RESOURCE_USAGE_LOCAL,
  WHISPER_MODEL_CARDS,
} from '@interview/shared';
import {
  api,
  type SttDeviceId,
  type SttDeviceInfo,
  type SttModelStatus,
  type SttSettingsDto,
  type WhisperQualityId,
} from '../lib/api';

const QUALITIES: WhisperQualityId[] = ['fast', 'balanced', 'quality', 'max'];

const METERS: Record<WhisperQualityId, { speed: number; acc: number; res: number }> = {
  fast: { speed: 3, acc: 1, res: 1 },
  balanced: { speed: 2, acc: 2, res: 2 },
  quality: { speed: 1, acc: 3, res: 3 },
  max: { speed: 1, acc: 3, res: 3 },
};

function Meter({ label, level, kind }: { label: string; level: number; kind: 'speed' | 'acc' | 'res' }) {
  const on =
    kind === 'speed'
      ? 'sc-meter__seg--on-speed'
      : kind === 'acc'
        ? 'sc-meter__seg--on-acc'
        : 'sc-meter__seg--on-res';
  return (
    <div className="flex items-center gap-2">
      <span className="w-[68px] text-[10px] uppercase tracking-wide text-ink-faint">{label}</span>
      <span className="sc-meter">
        {[0, 1, 2].map((i) => (
          <span key={i} className={`sc-meter__seg ${i < level ? on : ''}`} />
        ))}
      </span>
    </div>
  );
}

function Radio({ selected }: { selected: boolean }) {
  return (
    <span
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
        selected ? 'border-accent bg-accent text-white' : 'border-surface-border-strong'
      }`}
    >
      {selected && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )}
    </span>
  );
}

type StatusMap = Record<WhisperQualityId, SttModelStatus | null>;

const EMPTY_STATUS: StatusMap = { fast: null, balanced: null, quality: null, max: null };

/** Speech Recognition settings: mode, local model manager, device, privacy. */
export default function SpeechRecognitionSettings() {
  const navigate = useNavigate();
  const [settings, setSettings] = useState<SttSettingsDto | null>(null);
  const [statuses, setStatuses] = useState<StatusMap>(EMPTY_STATUS);
  const [device, setDevice] = useState<SttDeviceInfo | null>(null);
  const [whisperReason, setWhisperReason] = useState('');
  const [busy, setBusy] = useState<WhisperQualityId | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const refreshStatuses = useCallback(async () => {
    const entries = await Promise.all(
      QUALITIES.map(async (q) => [q, await api.sttModelStatus(q).catch(() => null)] as const),
    );
    setStatuses(Object.fromEntries(entries) as StatusMap);
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [s, prov] = await Promise.all([api.getSttSettings(), api.sttProviders()]);
        if (!alive) return;
        setSettings(s);
        const whisper = prov.providers.find((p) => p.id === 'whisper-local');
        setWhisperReason(whisper?.reason ?? '');
        await refreshStatuses();
        api.sttDevice().then((d) => alive && setDevice(d)).catch(() => undefined);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Не удалось загрузить настройки STT');
      }
    })();
    return () => {
      alive = false;
    };
  }, [refreshStatuses]);

  const anyDownloading = useMemo(
    () => QUALITIES.some((q) => statuses[q]?.status === 'downloading'),
    [statuses],
  );

  useEffect(() => {
    if (!anyDownloading) return;
    const t = setInterval(() => void refreshStatuses(), 1200);
    return () => clearInterval(t);
  }, [anyDownloading, refreshStatuses]);

  const patchSettings = useCallback(
    async (patch: Partial<SttSettingsDto>) => {
      setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
      setError('');
      try {
        const saved = await api.saveSttSettings(patch);
        setSettings(saved);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Не удалось сохранить настройки');
      }
    },
    [],
  );

  const download = useCallback(
    async (quality: WhisperQualityId) => {
      setBusy(quality);
      setError('');
      try {
        const st = await api.sttModelDownload(quality);
        setStatuses((prev) => ({ ...prev, [quality]: st }));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Не удалось начать загрузку');
      } finally {
        setBusy(null);
        void refreshStatuses();
      }
    },
    [refreshStatuses],
  );

  const removeModel = useCallback(
    async (quality: WhisperQualityId) => {
      setBusy(quality);
      setError('');
      try {
        await api.sttModelDelete(quality);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Не удалось удалить модель');
      } finally {
        setBusy(null);
        void refreshStatuses();
      }
    },
    [refreshStatuses],
  );

  const autoChoose = useCallback(() => {
    if (!device) return;
    setNote(
      `Auto-selected ${device.recommendedQuality} for ${device.totalRamGb ?? '?'} GB RAM, ` +
        `${device.hasGpu ? 'GPU available' : 'CPU only'}.`,
    );
    void patchSettings({
      local_model: device.recommendedQuality,
      device: device.recommendedDevice === 'gpu' ? 'gpu' : 'auto',
    });
  }, [device, patchSettings]);

  if (!settings) {
    return (
      <div className="card mb-5 p-5 text-sm text-ink-muted">
        {error || 'Загрузка настроек распознавания речи…'}
      </div>
    );
  }

  const deviceOptions: { id: SttDeviceId; label: string }[] = [
    { id: 'auto', label: 'Авто' },
    { id: 'cpu', label: 'CPU' },
    { id: 'gpu', label: 'GPU' },
  ];

  return (
    <div className="mb-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-ink">Распознавание речи (STT)</h3>
        <p className="mt-0.5 text-sm text-ink-muted">
          Local Whisper транскрибирует аудио на вашем устройстве — звук не уходит в облако.
        </p>
      </div>

      <div className="cockpit-alert cockpit-alert-info">
        <span>Распознавание: Local Whisper — аудио распознаётся локально и не отправляется в облако.</span>
      </div>

      {/* Live streaming models */}
      <div className="sc-card p-5">
        <p className="mb-3 text-sm font-semibold text-ink">Потоковые модели</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <span className="label">Промежуточная модель (live-субтитры)</span>
            <select
              value={settings.partial_model ?? 'fast'}
              onChange={(e) => void patchSettings({ partial_model: e.target.value as WhisperQualityId })}
              className="select-compact mt-1 w-full"
            >
              {QUALITIES.map((q) => (
                <option key={q} value={q}>
                  {WHISPER_MODEL_CARDS.find((c) => c.quality === q)?.label ?? q}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-faint">Быстрые обновления пока вы говорите (~500 мс).</p>
          </div>
          <div>
            <span className="label">Финальная модель (после паузы)</span>
            <select
              value={settings.final_model ?? settings.local_model}
              onChange={(e) =>
                void patchSettings({
                  final_model: e.target.value as WhisperQualityId,
                  local_model: e.target.value as WhisperQualityId,
                })
              }
              className="select-compact mt-1 w-full"
            >
              {QUALITIES.map((q) => (
                <option key={q} value={q}>
                  {WHISPER_MODEL_CARDS.find((c) => c.quality === q)?.label ?? q}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-faint">Точнее, когда фраза уже закончена.</p>
          </div>
        </div>
      </div>

      {/* Local model cards */}
      <div className="space-y-2.5">
        <p className="px-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Локальная модель</p>
        {WHISPER_MODEL_CARDS.map((card) => {
          const st = statuses[card.quality];
          const selected = settings.local_model === card.quality;
          const downloaded = st?.downloaded ?? false;
          const downloading = st?.status === 'downloading';
          const failed = st?.status === 'error';
          const pct = Math.round((st?.progress ?? 0) * 100);
          const m = METERS[card.quality];
          return (
            <div
              key={card.quality}
              onClick={() => downloaded && void patchSettings({ local_model: card.quality })}
              className={`sc-model-card ${selected ? 'sc-model-card--selected' : ''} ${
                downloaded ? '' : 'cursor-default'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-ink">{card.label}</p>
                    {card.recommended && <span className="sc-badge sc-badge--accent">Рекомендуется</span>}
                  </div>
                  <p className="sc-model-card__specs">
                    ~{card.approxDownloadMb} MB · RAM ≥ {card.recommendedRamGb} GB ·{' '}
                    {card.recommendedDevice.toUpperCase()} · {card.expectedSpeed}
                  </p>
                  <p className="mt-1.5 text-sm text-ink-muted">{card.description}</p>
                  <div className="mt-3 space-y-1.5">
                    <Meter label="Скорость" level={m.speed} kind="speed" />
                    <Meter label="Точность" level={m.acc} kind="acc" />
                    <Meter label="Ресурсы" level={m.res} kind="res" />
                  </div>
                </div>
                <Radio selected={selected} />
              </div>

              <div className="mt-3 flex items-center justify-between gap-3 border-t border-surface-border/60 pt-3">
                {downloaded ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
                    <span className="sc-dot sc-dot--success" /> Загружена · Готова
                  </span>
                ) : downloading ? (
                  <span className="sc-progress mr-3 flex-1">
                    <span className="sc-progress__fill" style={{ width: `${Math.max(4, pct)}%` }} />
                  </span>
                ) : (
                  <span className="text-xs text-ink-faint">Не загружена</span>
                )}

                <div className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  {downloaded ? (
                    <button
                      type="button"
                      disabled={busy === card.quality}
                      onClick={() => void removeModel(card.quality)}
                      className="btn-danger btn-sm"
                    >
                      Удалить
                    </button>
                  ) : downloading ? (
                    <span className="sc-mono text-xs text-ink-muted">{pct}%</span>
                  ) : (
                    <button
                      type="button"
                      disabled={busy === card.quality || anyDownloading}
                      onClick={() => void download(card.quality)}
                      className="btn-primary btn-sm"
                    >
                      {failed ? 'Повторить' : `Скачать ~${card.approxDownloadMb} МБ`}
                    </button>
                  )}
                </div>
              </div>
              {failed && st?.error && <p className="mt-2 text-xs text-red-400">{st.error}</p>}
            </div>
          );
        })}
        {whisperReason && !QUALITIES.some((q) => statuses[q]?.downloaded) && (
          <p className="text-xs text-amber-300">{whisperReason}</p>
        )}
      </div>

      {/* Compute device */}
      <div className="sc-card flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <p className="text-sm font-medium text-ink">Вычислительное устройство</p>
          <p className="text-xs text-ink-faint">
            Авто выбирает GPU при наличии, иначе CPU.
            {device ? ` ${device.totalRamGb ? `${device.totalRamGb} ГБ RAM` : 'RAM неизвестно'} · ${device.hasGpu ? 'GPU обнаружен' : 'только CPU'}.` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="sc-segmented" role="group" aria-label="Вычислительное устройство">
            {deviceOptions.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => void patchSettings({ device: d.id })}
                className={`sc-segmented__item ${settings.device === d.id ? 'sc-segmented__item--active' : ''}`}
              >
                {d.label}
              </button>
            ))}
          </div>
          <button type="button" onClick={autoChoose} disabled={!device} className="btn-secondary btn-sm">
            Выбрать авто
          </button>
        </div>
      </div>

      {/* Validation */}
      <div className="sc-card flex flex-wrap items-center gap-2 p-5">
        <span className="flex-1 text-sm text-ink-muted">Проверка</span>
        <button type="button" onClick={() => navigate('/benchmark')} className="btn-secondary btn-sm">
          Запустить STT-бенчмарк
        </button>
        <button type="button" onClick={() => navigate('/diagnostics')} className="btn-secondary btn-sm">
          Открыть диагностику
        </button>
      </div>

      {/* Privacy note */}
      <div className="cockpit-alert cockpit-alert-warn">
        <span>
          {STT_PRIVACY_LOCAL} {STT_RESOURCE_USAGE_LOCAL}
        </span>
      </div>

      {note && <p className="text-xs text-emerald-400">{note}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
