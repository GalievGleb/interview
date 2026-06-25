import { useEffect, useState } from 'react';
import { api, type SttDiagnostics } from '../lib/api';
import { useApp } from '../context/AppContext';

interface MicStatus {
  count: number;
  permission: string;
}

/** Diagnostics: STT provider/model/device/latency/last error + mic + backend. */
export default function DiagnosticsPanel() {
  const { backendOnline } = useApp();
  const [diag, setDiag] = useState<SttDiagnostics | null>(null);
  const [mic, setMic] = useState<MicStatus | null>(null);
  const [error, setError] = useState('');

  const refresh = () => {
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
          // 'microphone' isn't in every lib.dom PermissionName union — query loosely.
          const perms = navigator.permissions as
            | { query?: (d: { name: string }) => Promise<{ state: string }> }
            | undefined;
          const p = await perms?.query?.({ name: 'microphone' });
          if (p) permission = p.state;
        } catch {
          // Permissions API not available — leave as unknown.
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

  return (
    <div className="card mb-5 space-y-4 p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">Диагностика</h3>
        <button type="button" onClick={refresh} className="btn-secondary btn-sm">
          Обновить
        </button>
      </div>

      <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        <Row label="Backend" value={backendOnline ? 'онлайн' : 'оффлайн'} ok={backendOnline} />
        <Row label="STT-движок" value={diag?.provider ?? '—'} />
        <Row label="Модель" value={diag?.model ?? diag?.localModel ?? '—'} />
        <Row label="Устройство" value={(diag?.device ?? '—').toUpperCase()} />
        <Row
          label="Статус модели"
          value={diag ? (ready ? 'готова' : diag.reason) : '—'}
          ok={ready}
        />
        <Row
          label="Микрофон"
          value={mic ? `${mic.count} устр. · доступ: ${mic.permission}` : '—'}
          ok={mic ? mic.count > 0 && mic.permission !== 'denied' : undefined}
        />
        <Row
          label="Средняя латентность STT"
          value={diag?.avgBenchmarkLatencyMs != null ? `${diag.avgBenchmarkLatencyMs} ms` : '— (запустите бенчмарк)'}
        />
        <Row
          label="Последняя ошибка STT"
          value={diag?.lastError ?? 'нет'}
          ok={!diag?.lastError}
        />
      </div>

      {diag?.privacyDescription && (
        <p className="rounded-xl border border-surface-border bg-surface p-3 text-xs text-ink-muted">
          {diag.privacyDescription}
          {diag.resourceUsage ? ` ${diag.resourceUsage}` : ''}
        </p>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}

function Row({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  const tone = ok === undefined ? 'text-ink' : ok ? 'text-emerald-400' : 'text-amber-300';
  return (
    <div className="flex items-center justify-between gap-3 border-b border-surface-border/50 py-1.5">
      <span className="text-xs text-ink-faint">{label}</span>
      <span className={`text-sm font-medium ${tone}`}>{value}</span>
    </div>
  );
}
