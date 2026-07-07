import type { SttDebugInfo } from '../SttDebugPanel';
import { useI18n } from '../../lib/i18n';

function secs(ms?: number): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  return `${(ms / 1000).toFixed(ms < 1000 ? 2 : 1)}s`;
}

/** Compact, always-visible latency readout — reinforces how fast the answer was. */
export default function LatencyHud({ debug }: { debug: SttDebugInfo | null }) {
  const { t } = useI18n();
  if (!debug) return null;
  const stt = secs(debug.timeToFinalMs); // server speech-end → final transcript
  const firstToken = secs(debug.timeToAnswerMs); // answer start → first token
  const items: { label: string; value: string; warn?: boolean }[] = [];
  if (stt) items.push({ label: t('latency.transcript'), value: stt, warn: (debug.timeToFinalMs ?? 0) > 2000 });
  if (firstToken)
    items.push({
      label: t('latency.firstToken'),
      value: firstToken,
      warn: (debug.timeToAnswerMs ?? 0) > 3000,
    });
  if (items.length === 0) return null;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] font-medium text-ink-faint">{t('latency.speed')}</span>
      {items.map((it) => (
        <span
          key={it.label}
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${
            it.warn
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
              : 'border-surface-border bg-surface-elevated/70 text-ink-muted'
          }`}
        >
          <span className="text-ink-faint">{it.label}</span>
          <span className="font-medium tabular-nums text-ink">{it.value}</span>
        </span>
      ))}
    </div>
  );
}
