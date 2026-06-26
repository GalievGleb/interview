import VoiceTestLab from '../components/test-lab/VoiceTestLab';
import ScreenHeader from '../components/ScreenHeader';

export default function TestLabPage() {
  return (
    <div>
      <ScreenHeader
        title="Test Lab"
        subtitle="Full pipeline — audio → STT → correction → LLM → answer → scoring."
      />
      <VoiceTestLab />
    </div>
  );
}
