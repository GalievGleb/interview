import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import OnboardingSttStep from '../components/OnboardingSttStep';

export default function OnboardingPage() {
  const { completeOnboarding } = useApp();
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2>(1);

  const finish = () => {
    completeOnboarding();
    navigate('/settings');
  };

  return (
    <div className="flex min-h-screen items-start justify-center overflow-y-auto bg-surface p-6 py-10 text-ink">
      <div className="w-full max-w-xl animate-scale-in">
        <div className="mb-7 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent text-base font-bold text-white shadow-glow">
            IC
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Interview & Meeting Copilot</h1>
            <p className="text-sm text-ink-muted">
              Локальный AI-помощник для собеседований и созвонов
            </p>
          </div>
        </div>

        <div className="mb-4 flex items-center gap-2 text-xs text-ink-faint">
          <span className={step === 1 ? 'text-accent' : ''}>1. Обзор</span>
          <span>→</span>
          <span className={step === 2 ? 'text-accent' : ''}>2. Распознавание речи</span>
        </div>

        {step === 1 ? (
          <div className="card p-6">
            <div className="mb-6 space-y-3">
              <Feature title="Ответы на основе ваших данных">
                Загрузите резюме и вакансию — ассистент строит ответы строго на вашем опыте и
                честно говорит, если данных не хватает.
              </Feature>
              <Feature title="Режимы Interview и Meeting">
                Короткие ответы, версия «сказать вслух», на английском, заметки и summary встреч.
              </Feature>
              <Feature title="Локальная транскрипция">
                Речь распознаётся локально через Whisper — аудио не уходит в облако. Свои ключи
                OpenAI / OpenRouter хранятся локально в secure storage.
              </Feature>
            </div>

            <div className="mb-6 rounded-2xl border border-amber-700/30 bg-amber-950/20 p-4 text-sm text-amber-200">
              <strong className="font-semibold">Этичное использование.</strong> Приложение помогает
              готовиться и работать на разрешённых созвонах. Не используйте его для обмана
              интервьюеров и предупреждайте участников о записи, если этого требуют правила.
            </div>

            <button onClick={() => setStep(2)} className="btn-primary w-full py-3">
              Далее — распознавание речи
            </button>
          </div>
        ) : (
          <OnboardingSttStep onBack={() => setStep(1)} onContinue={finish} />
        )}
      </div>
    </div>
  );
}

function Feature({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-surface-border bg-surface p-4">
      <p className="font-medium text-ink">{title}</p>
      <p className="mt-0.5 text-sm text-ink-muted">{children}</p>
    </div>
  );
}
