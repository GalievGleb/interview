import { useCallback, useEffect, useMemo, useState } from 'react';
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

const QUALITIES: WhisperQualityId[] = ['fast', 'balanced', 'quality'];

type StatusMap = Record<WhisperQualityId, SttModelStatus | null>;

const EMPTY_STATUS: StatusMap = { fast: null, balanced: null, quality: null };

/** Speech Recognition settings: mode, local model manager, device, privacy. */
export default function SpeechRecognitionSettings() {
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

  return (
    <div className="card mb-5 space-y-5 p-5">
      <div>
        <h3 className="text-sm font-semibold text-ink">Распознавание речи (STT)</h3>
        <p className="mt-0.5 text-sm text-ink-muted">
          Local Whisper транскрибирует аудио локально на вашем устройстве — звук не уходит в облако.
        </p>
      </div>

      {/* Local model cards */}
      <div className="space-y-3">
        <span className="label">Локальная модель</span>
        {WHISPER_MODEL_CARDS.map((card) => {
          const st = statuses[card.quality];
          const selected = settings.local_model === card.quality;
          const downloaded = st?.downloaded ?? false;
          const downloading = st?.status === 'downloading';
          const failed = st?.status === 'error';
          const pct = Math.round((st?.progress ?? 0) * 100);
          return (
            <div
              key={card.quality}
              className={`rounded-xl border p-4 ${
                selected ? 'border-accent bg-accent-soft' : 'border-surface-border bg-surface'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-ink">{card.label}</p>
                    {card.recommended && (
                      <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent">
                        Recommended
                      </span>
                    )}
                    {downloaded && (
                      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-400">
                        Downloaded
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-sm text-ink-muted">{card.description}</p>
                  <p className="mt-1 text-xs text-ink-faint">
                    ~{card.approxDownloadMb} MB · RAM ≥ {card.recommendedRamGb} GB ·{' '}
                    {card.recommendedDevice.toUpperCase()} · {card.expectedSpeed}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  {downloaded ? (
                    <>
                      <button
                        type="button"
                        disabled={selected}
                        onClick={() => void patchSettings({ local_model: card.quality })}
                        className={selected ? 'btn-secondary btn-sm opacity-60' : 'btn-primary btn-sm'}
                      >
                        {selected ? 'Selected' : 'Use model'}
                      </button>
                      <button
                        type="button"
                        disabled={busy === card.quality}
                        onClick={() => void removeModel(card.quality)}
                        className="btn-secondary btn-sm"
                      >
                        Delete
                      </button>
                    </>
                  ) : downloading ? (
                    <span className="text-xs text-ink-muted">Downloading… {pct}%</span>
                  ) : (
                    <button
                      type="button"
                      disabled={busy === card.quality || anyDownloading}
                      onClick={() => void download(card.quality)}
                      className="btn-primary btn-sm"
                    >
                      {failed ? 'Retry' : `Download ~${card.approxDownloadMb} MB`}
                    </button>
                  )}
                </div>
              </div>
              {downloading && (
                <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-border">
                  <div
                    className="h-full rounded-full bg-accent transition-all"
                    style={{ width: `${Math.max(4, pct)}%` }}
                  />
                </div>
              )}
              {failed && st?.error && <p className="mt-2 text-xs text-red-400">{st.error}</p>}
            </div>
          );
        })}
        {whisperReason && !QUALITIES.some((q) => statuses[q]?.downloaded) && (
          <p className="text-xs text-amber-300">{whisperReason}</p>
        )}
      </div>

      {/* Device + auto-choose */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <span className="label">Устройство</span>
          <select
            value={settings.device}
            onChange={(e) => void patchSettings({ device: e.target.value as SttDeviceId })}
            className="select-compact mt-1 min-w-[140px]"
          >
            <option value="auto">Auto</option>
            <option value="cpu">CPU</option>
            <option value="gpu">GPU (if supported)</option>
          </select>
        </div>
        <button type="button" onClick={autoChoose} disabled={!device} className="btn-secondary btn-sm">
          Auto choose for my device
        </button>
        {device && (
          <span className="text-xs text-ink-faint">
            {device.totalRamGb ? `${device.totalRamGb} GB RAM` : 'RAM unknown'} ·{' '}
            {device.hasGpu ? 'GPU detected' : 'CPU only'}
          </span>
        )}
      </div>

      {/* Privacy note */}
      <div className="rounded-xl border border-surface-border bg-surface p-4 text-xs text-ink-muted">
        <p>{STT_PRIVACY_LOCAL}</p>
        <p className="mt-1">{STT_RESOURCE_USAGE_LOCAL}</p>
      </div>

      {note && <p className="text-xs text-emerald-400">{note}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
