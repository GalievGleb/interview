import { useEffect, useState } from 'react';
import { WHISPER_MODEL_CARDS } from '@interview/shared';
import { api, type SttDeviceInfo, type WhisperQualityId } from '../lib/api';
import { useI18n } from '../lib/i18n';

interface OnboardingSttStepProps {
  onBack: () => void;
  onContinue: () => void;
}

/**
 * First-run speech-recognition setup. Discloses local resource usage and
 * privacy BEFORE any model download, lets the user pick a model (or auto-pick
 * for their device), and persists the choice. The actual download can happen
 * here or later in Settings — we never start it silently.
 */
export default function OnboardingSttStep({ onBack, onContinue }: OnboardingSttStepProps) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<WhisperQualityId>('balanced');
  const [device, setDevice] = useState<SttDeviceInfo | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [downloaded, setDownloaded] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api.getSttSettings().then((s) => alive && setSelected(s.local_model)).catch(() => undefined);
    api.sttDevice().then((d) => alive && setDevice(d)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Poll the selected model's download progress while it's running.
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(async () => {
      try {
        const st = await api.sttModelStatus(selected);
        setProgress(Math.round(st.progress * 100));
        if (st.downloaded) {
          setDownloaded(true);
          setDownloading(false);
        } else if (st.status === 'error') {
          setError(st.error ?? t('onboarding.sttStep.modelError'));
          setDownloading(false);
        }
      } catch {
        // keep polling
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [downloading, selected, t]);

  const startDownload = async () => {
    setError('');
    setDownloaded(false);
    setProgress(0);
    try {
      const st = await api.sttModelDownload(selected);
      if (st.downloaded) setDownloaded(true);
      else setDownloading(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('onboarding.sttStep.downloadError'));
    }
  };

  const autoChoose = () => {
    if (device) setSelected(device.recommendedQuality);
  };

  const persistAndContinue = async () => {
    setSaving(true);
    try {
      await api.saveSttSettings({ local_model: selected });
    } catch {
      // non-blocking — user can adjust in Settings
    } finally {
      setSaving(false);
      onContinue();
    }
  };

  return (
    <div className="card p-6">
      <h2 className="text-xl font-semibold tracking-tight text-ink">
        {t('onboarding.sttStep.title')}
      </h2>
      <div className="mt-3 rounded-2xl border border-accent/40 bg-accent-soft p-4">
        <p className="font-medium text-ink">{t('onboarding.sttStep.localTitle')}</p>
        <ul className="mt-2 space-y-1 text-sm text-ink-muted">
          <li>• {t('onboarding.sttStep.b1')}</li>
          <li>• {t('onboarding.sttStep.b2')}</li>
          <li>• {t('onboarding.sttStep.b3')}</li>
          <li>• {t('onboarding.sttStep.b4')}</li>
          <li>• {t('onboarding.sttStep.b5')}</li>
        </ul>
      </div>

      <div className="mt-4 space-y-2">
        {WHISPER_MODEL_CARDS.map((card) => (
          <button
            key={card.quality}
            type="button"
            onClick={() => setSelected(card.quality)}
            className={`w-full rounded-xl border p-4 text-left transition-colors ${
              selected === card.quality
                ? 'border-accent bg-accent-soft'
                : 'border-surface-border bg-surface hover:border-surface-border-strong'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="font-medium text-ink">{t(`whisper.${card.quality}.label`)}</span>
              {card.recommended && (
                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent">
                  {t('onboarding.stt.recommended')}
                </span>
              )}
              <span className="ml-auto text-xs text-ink-faint">
                ~{card.approxDownloadMb} {t('unit.mb')}
              </span>
            </div>
            <p className="mt-0.5 text-sm text-ink-muted">{t(`whisper.${card.quality}.desc`)}</p>
          </button>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" onClick={autoChoose} disabled={!device} className="btn-secondary btn-sm">
          {t('onboarding.sttStep.autoChoose')}
        </button>
        {device && (
          <span className="text-xs text-ink-faint">
            {device.totalRamGb
              ? `${device.totalRamGb} ${t('unit.gbRam')}`
              : t('onboarding.sttStep.ramUnknown')}{' '}
            · {device.hasGpu ? t('onboarding.sttStep.gpuFound') : t('onboarding.sttStep.cpuOnly')}
          </span>
        )}
      </div>

      {/* Required disclosures */}
      <div className="mt-4 rounded-xl border border-surface-border bg-surface p-4 text-xs text-ink-muted">
        <p>{t('onboarding.sttStep.privacyLocal')}</p>
        <p className="mt-1">{t('onboarding.sttStep.resourceLocal')}</p>
      </div>

      {/* Optional download now */}
      <div className="mt-4">
        {downloaded ? (
          <p className="text-sm text-emerald-400">{t('onboarding.sttStep.modelReady')}</p>
        ) : downloading ? (
          <div>
            <p className="text-sm text-ink-muted">
              {t('onboarding.sttStep.downloading')} {progress}%
            </p>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-border">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{ width: `${Math.max(4, progress)}%` }}
              />
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => void startDownload()} className="btn-secondary btn-sm">
            {t('onboarding.sttStep.downloadNow')}
          </button>
        )}
        <p className="mt-2 text-xs text-ink-faint">{t('onboarding.sttStep.changeLater')}</p>
      </div>

      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}

      <div className="mt-6 flex items-center justify-between">
        <button type="button" onClick={onBack} className="btn-secondary">
          {t('onboarding.back')}
        </button>
        <button
          type="button"
          onClick={() => void persistAndContinue()}
          disabled={saving}
          className="btn-primary"
        >
          {saving ? t('onboarding.key.saving') : t('onboarding.continue')}
        </button>
      </div>
    </div>
  );
}
