import VoiceTestLab from '../components/test-lab/VoiceTestLab';
import ScreenHeader from '../components/ScreenHeader';

export default function TestLabPage() {
  return (
    <div>
      <ScreenHeader
        title="Тестовая лаборатория"
        subtitle="Полный конвейер — audio → STT → коррекция → LLM → ответ → оценка."
      />
      <VoiceTestLab />
    </div>
  );
}
