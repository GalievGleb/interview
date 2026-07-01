import ScreenHeader from '../components/ScreenHeader';
import SttBenchmarkPanel from '../components/test-lab/SttBenchmarkPanel';

export default function BenchmarkPage() {
  return (
    <div>
      <ScreenHeader
        title="STT-бенчмарк"
        subtitle="Точность распознавания — audio → STT → транскрипт. Без LLM, без ответов."
        badge={
          <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-xs font-medium text-sky-400">
            <span className="sc-dot" style={{ backgroundColor: '#38bdf8' }} />
            Только распознавание речи
          </span>
        }
      />
      <SttBenchmarkPanel />
    </div>
  );
}
