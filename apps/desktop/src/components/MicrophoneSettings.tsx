import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  listMicrophones,
  getSelectedMicId,
  setSelectedMicId,
  ensureMicPermission,
} from '../lib/audioDevices';
import { useI18n } from '../lib/i18n';
import {
  INITIAL_MICROPHONE_SAMPLE_STATE,
  microphoneSampleReducer,
  startMicrophoneSampleCapture,
  type MicrophoneSampleCapture,
} from '../lib/microphoneSample';
import MicrophoneSamplePanel from './MicrophoneSamplePanel';

const MICROPHONE_SAMPLE_LIMIT_MS = 10_000;

export default function MicrophoneSettings() {
  const { t } = useI18n();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selected, setSelected] = useState(getSelectedMicId());
  const [needsPermission, setNeedsPermission] = useState(false);
  const [sample, dispatchSample] = useReducer(
    microphoneSampleReducer,
    INITIAL_MICROPHONE_SAMPLE_STATE,
  );
  const captureRef = useRef<MicrophoneSampleCapture | null>(null);
  const meterCleanupRef = useRef<(() => void) | null>(null);
  const stopTimerRef = useRef<number | null>(null);
  const sampleUrlRef = useRef('');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recordingStartedAtRef = useRef(0);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const mics = await listMicrophones();
      setDevices(mics);
      setNeedsPermission(mics.length > 0 && !mics[0].label);
      setSelected((current) => current || mics[0]?.deviceId || '');
    } catch {
      dispatchSample({ type: 'failed', message: t('mic.devicesError') });
    }
  }, [t]);

  const releaseSampleMedia = useCallback(() => {
    if (stopTimerRef.current !== null) {
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    meterCleanupRef.current?.();
    meterCleanupRef.current = null;
    captureRef.current?.cancel();
    captureRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.src = '';
      audioRef.current = null;
    }
    if (sampleUrlRef.current) {
      URL.revokeObjectURL(sampleUrlRef.current);
      sampleUrlRef.current = '';
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    navigator.mediaDevices.addEventListener?.('devicechange', refresh);
    return () => {
      mountedRef.current = false;
      navigator.mediaDevices.removeEventListener?.('devicechange', refresh);
      releaseSampleMedia();
    };
  }, [refresh, releaseSampleMedia]);

  const grant = async () => {
    try {
      await ensureMicPermission();
      await refresh();
    } catch {
      dispatchSample({ type: 'failed', message: t('mic.permissionDenied') });
    }
  };

  const resetSample = useCallback(() => {
    releaseSampleMedia();
    dispatchSample({ type: 'reset' });
  }, [releaseSampleMedia]);

  const onChange = (id: string) => {
    resetSample();
    setSelected(id);
    setSelectedMicId(id);
  };

  const stopRecording = useCallback(async () => {
    const capture = captureRef.current;
    if (!capture) return;
    captureRef.current = null;
    if (stopTimerRef.current !== null) {
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    meterCleanupRef.current?.();
    meterCleanupRef.current = null;
    const durationMs = Math.min(
      MICROPHONE_SAMPLE_LIMIT_MS,
      Math.max(0, Date.now() - recordingStartedAtRef.current),
    );

    try {
      const blob = await capture.stop();
      if (!mountedRef.current) return;
      if (sampleUrlRef.current) URL.revokeObjectURL(sampleUrlRef.current);
      const url = URL.createObjectURL(blob);
      sampleUrlRef.current = url;
      const audio = new Audio(url);
      audio.preload = 'auto';
      audio.onended = () => {
        if (mountedRef.current) dispatchSample({ type: 'playback-stopped' });
      };
      audio.onerror = () => {
        if (!mountedRef.current) return;
        releaseSampleMedia();
        dispatchSample({ type: 'failed', message: t('mic.sample.playError') });
      };
      audioRef.current = audio;
      dispatchSample({ type: 'recording-ready', durationMs });
    } catch {
      if (mountedRef.current) dispatchSample({ type: 'failed', message: t('mic.openError') });
    }
  }, [releaseSampleMedia, t]);

  const startRecording = useCallback(async () => {
    releaseSampleMedia();
    dispatchSample({ type: 'reset' });
    try {
      const capture = await startMicrophoneSampleCapture(selected);
      if (!mountedRef.current) {
        capture.cancel();
        return;
      }
      captureRef.current = capture;

      const context = new AudioContext();
      if (context.state === 'suspended') await context.resume();
      const source = context.createMediaStreamSource(capture.stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let animationFrame = 0;
      let stopped = false;
      recordingStartedAtRef.current = Date.now();
      dispatchSample({ type: 'recording-started' });

      const updateMeter = () => {
        if (stopped) return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let index = 0; index < data.length; index += 1) {
          const sampleValue = (data[index] - 128) / 128;
          sum += sampleValue * sampleValue;
        }
        const rms = Math.sqrt(sum / Math.max(1, data.length));
        dispatchSample({
          type: 'recording-progress',
          elapsedMs: Math.min(
            MICROPHONE_SAMPLE_LIMIT_MS,
            Date.now() - recordingStartedAtRef.current,
          ),
          level: Math.min(100, Math.round(rms * 320)),
        });
        animationFrame = requestAnimationFrame(updateMeter);
      };
      updateMeter();
      meterCleanupRef.current = () => {
        if (stopped) return;
        stopped = true;
        cancelAnimationFrame(animationFrame);
        source.disconnect();
        void context.close();
      };
      stopTimerRef.current = window.setTimeout(() => {
        void stopRecording();
      }, MICROPHONE_SAMPLE_LIMIT_MS);
    } catch {
      releaseSampleMedia();
      if (mountedRef.current) dispatchSample({ type: 'failed', message: t('mic.openError') });
    }
  }, [releaseSampleMedia, selected, stopRecording, t]);

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (sample.status === 'playing') {
      audio.pause();
      dispatchSample({ type: 'playback-stopped' });
      return;
    }
    try {
      audio.currentTime = 0;
      await audio.play();
      dispatchSample({ type: 'playback-started' });
    } catch {
      releaseSampleMedia();
      dispatchSample({ type: 'failed', message: t('mic.sample.playError') });
    }
  };

  return (
    <div className="card mb-5 space-y-4 p-5">
      <div>
        <h3 className="text-sm font-semibold text-ink">{t('mic.title')}</h3>
        <p className="mt-0.5 text-sm text-ink-muted">{t('mic.desc')}</p>
      </div>

      <select
        value={selected}
        onChange={(event) => onChange(event.target.value)}
        className="field min-w-0"
        aria-label={t('mic.title')}
        disabled={sample.status === 'recording'}
      >
        {devices.length === 0 && <option value="">{t('mic.noDevices')}</option>}
        {devices.map((device, index) => (
          <option key={device.deviceId} value={device.deviceId} title={device.label}>
            {device.label || `${t('mic.fallback')} ${index + 1}`}
          </option>
        ))}
      </select>

      {needsPermission && (
        <div className="flex flex-wrap items-center gap-3 text-sm text-ink-muted">
          <span>{t('mic.permissionHint')}</span>
          <button type="button" onClick={() => void grant()} className="btn-secondary btn-sm">
            {t('mic.grant')}
          </button>
        </div>
      )}

      <MicrophoneSamplePanel
        state={sample}
        onStart={() => void startRecording()}
        onStop={() => void stopRecording()}
        onPlayPause={() => void togglePlayback()}
        onReset={() => void startRecording()}
      />
    </div>
  );
}
