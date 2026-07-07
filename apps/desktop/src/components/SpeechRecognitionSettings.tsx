import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { WHISPER_MODEL_CARDS } from '@interview/shared';
import {
  api,
  type SpeechKitModelId,
  type SttDeviceId,
  type SttDeviceInfo,
  type SttEngineId,
  type SttModelStatus,
  type SttSettingsDto,
  type WhisperQualityId,
} from '../lib/api';
import { useI18n, type I18nKey } from '../lib/i18n';

const ENGINES: Array<{
  id: SttEngineId;
  label: string;
  labelKey?: I18nKey;
  taglineKey: I18nKey;
  privacyKey: I18nKey;
  keyField?: 'deepgram_api_key' | 'yandex_api_key';
  keyPlaceholderKey?: I18nKey;
}> = [
  {
    id: 'whisper',
    label: 'Local Whisper',
    taglineKey: 'stt.whisper.tagline',
    privacyKey: 'stt.whisper.privacy',
  },
  {
    id: 'deepgram',
    label: 'Deepgram Nova-3',
    taglineKey: 'stt.deepgram.tagline',
    privacyKey: 'stt.deepgram.privacy',
    keyField: 'deepgram_api_key',
    keyPlaceholderKey: 'stt.deepgram.keyPlaceholder',
  },
  {
    id: 'speechkit',
    label: 'Yandex SpeechKit v3',
    labelKey: 'stt.speechkit.label',
    taglineKey: 'stt.speechkit.tagline',
    privacyKey: 'stt.speechkit.privacy',
    keyField: 'yandex_api_key',
    keyPlaceholderKey: 'stt.speechkit.keyPlaceholder',
  },
];

// Модель SpeechKit: улучшения качества русского приходят сначала в general:rc
// и лишь через недели переезжают в стабильную general (релиз-ноты Яндекса).
const SPEECHKIT_MODELS: Array<{ id: SpeechKitModelId; labelKey: I18nKey }> = [
  { id: 'general', labelKey: 'stt.skModel.general' },
  { id: 'general:rc', labelKey: 'stt.skModel.rc' },
];

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
  const { t } = useI18n();
  const [settings, setSettings] = useState<SttSettingsDto | null>(null);
  const [statuses, setStatuses] = useState<StatusMap>(EMPTY_STATUS);
  const [device, setDevice] = useState<SttDeviceInfo | null>(null);
  const [whisperReason, setWhisperReason] = useState('');
  const [busy, setBusy] = useState<WhisperQualityId | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [cloudKeys, setCloudKeys] = useState({ deepgram: false, yandex: false });
  const [keyDraft, setKeyDraft] = useState('');
  const [savingKey, setSavingKey] = useState(false);

  const engineLabel = (e: (typeof ENGINES)[number]) => (e.labelKey ? t(e.labelKey) : e.label);

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
        api
          .getKeys()
          .then((k) => alive && setCloudKeys({ deepgram: k.deepgram, yandex: k.yandex }))
          .catch(() => undefined);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : t('stt.loadError'));
      }
    })();
    return () => {
      alive = false;
    };
  }, [refreshStatuses, t]);

  const anyDownloading = useMemo(
    () => QUALITIES.some((q) => statuses[q]?.status === 'downloading'),
    [statuses],
  );

  useEffect(() => {
    if (!anyDownloading) return;
    const timer = setInterval(() => void refreshStatuses(), 1200);
    return () => clearInterval(timer);
  }, [anyDownloading, refreshStatuses]);

  const patchSettings = useCallback(
    async (patch: Partial<SttSettingsDto>) => {
      setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
      setError('');
      try {
        const saved = await api.saveSttSettings(patch);
        setSettings(saved);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('stt.saveError'));
      }
    },
    [t],
  );

  const download = useCallback(
    async (quality: WhisperQualityId) => {
      setBusy(quality);
      setError('');
      try {
        const st = await api.sttModelDownload(quality);
        setStatuses((prev) => ({ ...prev, [quality]: st }));
      } catch (err) {
        setError(err instanceof Error ? err.message : t('stt.downloadError'));
      } finally {
        setBusy(null);
        void refreshStatuses();
      }
    },
    [refreshStatuses, t],
  );

  const removeModel = useCallback(
    async (quality: WhisperQualityId) => {
      setBusy(quality);
      setError('');
      try {
        await api.sttModelDelete(quality);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('stt.deleteError'));
      } finally {
        setBusy(null);
        void refreshStatuses();
      }
    },
    [refreshStatuses, t],
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
      <div className="card mb-5 p-5 text-sm text-ink-muted">{error || t('stt.loading')}</div>
    );
  }

  const deviceOptions: { id: SttDeviceId; label: string }[] = [
    { id: 'auto', label: t('stt.device.auto') },
    { id: 'cpu', label: 'CPU' },
    { id: 'gpu', label: 'GPU' },
  ];

  const engine = settings.engine ?? 'whisper';
  const activeEngine = ENGINES.find((e) => e.id === engine) ?? ENGINES[0];
  const engineKeySaved =
    engine === 'deepgram' ? cloudKeys.deepgram : engine === 'speechkit' ? cloudKeys.yandex : true;

  const saveCloudKey = async () => {
    if (!activeEngine.keyField || !keyDraft.trim()) return;
    setSavingKey(true);
    setError('');
    try {
      const status = await api.saveKeys({ [activeEngine.keyField]: keyDraft.trim() });
      setCloudKeys({ deepgram: status.deepgram, yandex: status.yandex });
      setKeyDraft('');
      setNote(t('stt.keySaved'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('stt.saveKeyError'));
    } finally {
      setSavingKey(false);
    }
  };

  return (
    <div className="mb-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-ink">{t('stt.title')}</h3>
        <p className="mt-0.5 text-sm text-ink-muted">{t('stt.desc')}</p>
      </div>

      {/* Engine selector */}
      <div className="space-y-2.5">
        {ENGINES.map((e) => {
          const selected = engine === e.id;
          const keySaved = e.id === 'deepgram' ? cloudKeys.deepgram : e.id === 'speechkit' ? cloudKeys.yandex : true;
          return (
            <div
              key={e.id}
              onClick={() => void patchSettings({ engine: e.id })}
              className={`sc-model-card ${selected ? 'sc-model-card--selected' : ''}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-ink">{engineLabel(e)}</p>
                    {e.id === 'whisper' && (
                      <span className="sc-badge sc-badge--accent">{t('stt.badge.private')}</span>
                    )}
                    {e.keyField && (
                      <span className={`sc-badge ${keySaved ? 'sc-badge--accent' : ''}`}>
                        {keySaved ? t('stt.badge.keySaved') : t('stt.badge.keyNeeded')}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-ink-muted">{t(e.taglineKey)}</p>
                  <p className="mt-0.5 text-xs text-ink-faint">{t(e.privacyKey)}</p>
                </div>
                <Radio selected={selected} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Cloud engine API key */}
      {activeEngine.keyField && (
        <div className="sc-card p-5">
          <p className="text-sm font-medium text-ink">
            {t('stt.apiKey')} · {engineLabel(activeEngine)}
            {engineKeySaved && <span className="ml-2 text-xs text-emerald-400">{t('stt.saved')}</span>}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2" onClick={(ev) => ev.stopPropagation()}>
            <input
              type="password"
              className="input-compact min-w-[260px] flex-1"
              placeholder={activeEngine.keyPlaceholderKey ? t(activeEngine.keyPlaceholderKey) : ''}
              value={keyDraft}
              onChange={(ev) => setKeyDraft(ev.target.value)}
            />
            <button
              type="button"
              className="btn-primary btn-sm"
              disabled={savingKey || !keyDraft.trim()}
              onClick={() => void saveCloudKey()}
            >
              {savingKey ? t('common.saving') : engineKeySaved ? t('stt.replaceKey') : t('stt.saveKey')}
            </button>
          </div>
          {!engineKeySaved && <p className="mt-2 text-xs text-amber-300">{t('stt.noKeyWarn')}</p>}
        </div>
      )}

      {/* SpeechKit: стабильная модель или кандидат со свежими улучшениями */}
      {engine === 'speechkit' && (
        <div className="sc-card flex flex-wrap items-center justify-between gap-3 p-5">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{t('stt.skModel.title')}</p>
            <p className="text-xs text-ink-faint">{t('stt.skModel.desc')}</p>
          </div>
          <div className="sc-segmented" role="group" aria-label={t('stt.skModel.aria')}>
            {SPEECHKIT_MODELS.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => void patchSettings({ speechkit_model: m.id })}
                className={`sc-segmented__item ${(settings.speechkit_model ?? 'general') === m.id ? 'sc-segmented__item--active' : ''}`}
              >
                {t(m.labelKey)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="cockpit-alert cockpit-alert-info">
        <span>
          {engine === 'whisper'
            ? t('stt.alert.local')
            : `${t('stt.alert.cloudPre')} ${engineLabel(activeEngine)}. ${t(activeEngine.privacyKey)}`}
        </span>
      </div>

      {/* Whisper-специфичные секции не нужны, когда выбран облачный движок. */}
      {engine === 'whisper' && (
      <>
      {/* Live streaming models */}
      <div className="sc-card p-5">
        <p className="mb-3 text-sm font-semibold text-ink">{t('stt.streaming.title')}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <span className="label">{t('stt.partial.label')}</span>
            <select
              value={settings.partial_model ?? 'fast'}
              onChange={(e) => void patchSettings({ partial_model: e.target.value as WhisperQualityId })}
              className="select-compact mt-1 w-full"
            >
              {QUALITIES.map((q) => (
                <option key={q} value={q}>
                  {t(`whisper.${q}.label`)}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-faint">{t('stt.partial.hint')}</p>
          </div>
          <div>
            <span className="label">{t('stt.final.label')}</span>
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
                  {t(`whisper.${q}.label`)}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-faint">{t('stt.final.hint')}</p>
          </div>
        </div>
      </div>

      {/* Local model cards */}
      <div className="space-y-2.5">
        <p className="px-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{t('stt.localModel')}</p>
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
                    <p className="font-medium text-ink">{t(`whisper.${card.quality}.label`)}</p>
                    {card.recommended && (
                      <span className="sc-badge sc-badge--accent">{t('onboarding.stt.recommended')}</span>
                    )}
                  </div>
                  <p className="sc-model-card__specs">
                    ~{card.approxDownloadMb} MB · RAM ≥ {card.recommendedRamGb} GB ·{' '}
                    {card.recommendedDevice.toUpperCase()} · {card.expectedSpeed}
                  </p>
                  <p className="mt-1.5 text-sm text-ink-muted">{t(`whisper.${card.quality}.desc`)}</p>
                  <div className="mt-3 space-y-1.5">
                    <Meter label={t('stt.meter.speed')} level={m.speed} kind="speed" />
                    <Meter label={t('stt.meter.acc')} level={m.acc} kind="acc" />
                    <Meter label={t('stt.meter.res')} level={m.res} kind="res" />
                  </div>
                </div>
                <Radio selected={selected} />
              </div>

              <div className="mt-3 flex items-center justify-between gap-3 border-t border-surface-border/60 pt-3">
                {downloaded ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
                    <span className="sc-dot sc-dot--success" /> {t('stt.model.ready')}
                  </span>
                ) : downloading ? (
                  <span className="sc-progress mr-3 flex-1">
                    <span className="sc-progress__fill" style={{ width: `${Math.max(4, pct)}%` }} />
                  </span>
                ) : (
                  <span className="text-xs text-ink-faint">{t('stt.model.notDownloaded')}</span>
                )}

                <div className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  {downloaded ? (
                    <button
                      type="button"
                      disabled={busy === card.quality}
                      onClick={() => void removeModel(card.quality)}
                      className="btn-danger btn-sm"
                    >
                      {t('common.delete')}
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
                      {failed ? t('stt.retry') : `${t('stt.download')} ~${card.approxDownloadMb} ${t('unit.mb')}`}
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
          <p className="text-sm font-medium text-ink">{t('stt.device.title')}</p>
          <p className="text-xs text-ink-faint">
            {t('stt.device.desc')}
            {device
              ? ` ${device.totalRamGb ? `${device.totalRamGb} ${t('unit.gbRam')}` : t('onboarding.sttStep.ramUnknown')} · ${device.hasGpu ? t('onboarding.sttStep.gpuFound') : t('onboarding.sttStep.cpuOnly')}.`
              : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="sc-segmented" role="group" aria-label={t('stt.device.title')}>
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
            {t('onboarding.sttStep.autoChoose')}
          </button>
        </div>
      </div>
      </>
      )}

      {/* Validation */}
      <div className="sc-card flex flex-wrap items-center gap-2 p-5">
        <span className="flex-1 text-sm text-ink-muted">{t('stt.validation')}</span>
        <button type="button" onClick={() => navigate('/benchmark')} className="btn-secondary btn-sm">
          {t('stt.runBenchmark')}
        </button>
        <button type="button" onClick={() => navigate('/diagnostics')} className="btn-secondary btn-sm">
          {t('stt.openDiagnostics')}
        </button>
      </div>

      {/* Privacy note */}
      {engine === 'whisper' && (
        <div className="cockpit-alert cockpit-alert-warn">
          <span>
            {t('onboarding.sttStep.privacyLocal')} {t('onboarding.sttStep.resourceLocal')}
          </span>
        </div>
      )}

      {note && <p className="text-xs text-emerald-400">{note}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
