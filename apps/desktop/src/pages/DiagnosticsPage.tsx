import ScreenHeader from '../components/ScreenHeader';
import DiagnosticsPanel from '../components/DiagnosticsPanel';

export default function DiagnosticsPage() {
  return (
    <div>
      <ScreenHeader
        title="Диагностика"
        subtitle="Состояние live-конвейера и телеметрия задержек."
        badge={
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-400">
            <span className="sc-dot sc-dot--live" />
            Работает
          </span>
        }
      />
      <DiagnosticsPanel />
    </div>
  );
}
