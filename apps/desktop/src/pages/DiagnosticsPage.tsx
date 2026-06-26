import ScreenHeader from '../components/ScreenHeader';
import DiagnosticsPanel from '../components/DiagnosticsPanel';

export default function DiagnosticsPage() {
  return (
    <div>
      <ScreenHeader
        title="Diagnostics"
        subtitle="Live pipeline health and latency telemetry."
        badge={
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-400">
            <span className="sc-dot sc-dot--live" />
            Operational
          </span>
        }
      />
      <DiagnosticsPanel />
    </div>
  );
}
