import { useState } from 'react';
import VoiceTestLab from '../components/test-lab/VoiceTestLab';
import SttBenchmarkPanel from '../components/test-lab/SttBenchmarkPanel';

type Tab = 'regression' | 'benchmark';

export default function TestLabPage() {
  const [tab, setTab] = useState<Tab>('regression');

  return (
    <div>
      <div className="segmented mb-4" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'regression'}
          onClick={() => setTab('regression')}
          className={`segmented-item ${tab === 'regression' ? 'segmented-item-active' : ''}`}
        >
          Voice Regression
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'benchmark'}
          onClick={() => setTab('benchmark')}
          className={`segmented-item ${tab === 'benchmark' ? 'segmented-item-active' : ''}`}
        >
          STT Benchmark
        </button>
      </div>

      {tab === 'regression' ? <VoiceTestLab /> : <SttBenchmarkPanel />}
    </div>
  );
}
