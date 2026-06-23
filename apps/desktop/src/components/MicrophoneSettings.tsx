import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listMicrophones,
  getSelectedMicId,
  setSelectedMicId,
  ensureMicPermission,
} from '../lib/audioDevices';

export default function MicrophoneSettings() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selected, setSelected] = useState(getSelectedMicId());
  const [needsPermission, setNeedsPermission] = useState(false);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState('');
  const cleanupRef = useRef<(() => void) | null>(null);

  const refresh = useCallback(async () => {
    setError('');
    try {
      const mics = await listMicrophones();
      setDevices(mics);
      setNeedsPermission(mics.length > 0 && !mics[0].label);
      setSelected((cur) => cur || mics[0]?.deviceId || '');
    } catch {
      setError('Не удалось получить список устройств');
    }
  }, []);

  useEffect(() => {
    void refresh();
    navigator.mediaDevices.addEventListener?.('devicechange', refresh);
    return () => {
      navigator.mediaDevices.removeEventListener?.('devicechange', refresh);
      cleanupRef.current?.();
    };
  }, [refresh]);

  const grant = async () => {
    try {
      await ensureMicPermission();
      await refresh();
    } catch {
      setError('Доступ к микрофону отклонён');
    }
  };

  const onChange = (id: string) => {
    setSelected(id);
    setSelectedMicId(id);
  };

  const startTest = async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: selected ? { deviceId: selected } : true,
      });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let raf = 0;
      const loop = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        setLevel(Math.min(100, Math.round(rms * 180)));
        raf = requestAnimationFrame(loop);
      };
      loop();
      setTesting(true);
      cleanupRef.current = () => {
        cancelAnimationFrame(raf);
        src.disconnect();
        void ctx.close();
        stream.getTracks().forEach((t) => t.stop());
        setTesting(false);
        setLevel(0);
        cleanupRef.current = null;
      };
    } catch {
      setError('Не удалось открыть микрофон');
    }
  };

  const stopTest = () => cleanupRef.current?.();

  return (
    <div className="card mb-5 space-y-4 p-5">
      <div>
        <h3 className="text-sm font-semibold text-ink">Микрофон</h3>
        <p className="mt-0.5 text-sm text-ink-muted">
          Устройство для захвата вашего голоса в live-режиме
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={selected}
          onChange={(e) => onChange(e.target.value)}
          className="field flex-1"
        >
          {devices.length === 0 && <option value="">Устройства не найдены</option>}
          {devices.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Микрофон ${i + 1}`}
            </option>
          ))}
        </select>
        {testing ? (
          <button onClick={stopTest} className="btn-danger btn-sm">
            Стоп
          </button>
        ) : (
          <button onClick={startTest} className="btn-secondary btn-sm">
            Проверить
          </button>
        )}
      </div>

      {needsPermission && (
        <div className="flex items-center gap-3 text-sm text-ink-muted">
          <span>Названия устройств скрыты — нужен доступ к микрофону.</span>
          <button onClick={grant} className="btn-secondary btn-sm">
            Разрешить доступ
          </button>
        </div>
      )}

      {testing && (
        <div>
          <p className="mb-1 text-xs text-ink-faint">Уровень сигнала — говорите в микрофон</p>
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface">
            <div
              className="h-full rounded-full bg-emerald-400 transition-[width] duration-75"
              style={{ width: `${level}%` }}
            />
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
