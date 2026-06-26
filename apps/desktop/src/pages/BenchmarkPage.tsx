import ScreenHeader from '../components/ScreenHeader';
import SttBenchmarkPanel from '../components/test-lab/SttBenchmarkPanel';

export default function BenchmarkPage() {
  return (
    <div>
      <ScreenHeader
        title="STT Benchmark"
        subtitle="Transcription accuracy — audio → STT → transcript. No LLM, no answers."
        badge={
          <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-xs font-medium text-sky-400">
            <span className="sc-dot" style={{ backgroundColor: '#38bdf8' }} />
            Speech-to-text only
          </span>
        }
      />
      <SttBenchmarkPanel />
    </div>
  );
}
