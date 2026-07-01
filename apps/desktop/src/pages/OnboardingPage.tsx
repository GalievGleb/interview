import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import OnboardingSttStep from '../components/OnboardingSttStep';

function Stroke({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      {d.split('|').map((path, i) => (
        <path key={i} d={path} />
      ))}
    </svg>
  );
}

export default function OnboardingPage() {
  const { completeOnboarding } = useApp();
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2>(1);

  const finish = () => {
    completeOnboarding();
    navigate('/settings');
  };

  return (
    <div className="relative flex min-h-screen flex-col overflow-y-auto bg-surface text-ink">
      <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-32 left-1/2 h-[480px] w-[480px] -translate-x-1/2 rounded-full bg-accent/20 blur-[120px]" />
        <div className="absolute -bottom-40 -right-20 h-[360px] w-[360px] rounded-full bg-emerald-500/10 blur-[120px]" />
      </div>

      {/* top bar */}
      <header className="relative z-[1] flex items-center justify-between px-8 py-6">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-sm font-bold text-white shadow-glow">
            SC
          </div>
          <span className="text-base font-semibold tracking-tight">Skillcue</span>
          <span className="ml-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            Первый запуск
          </span>
        </div>
        <button type="button" onClick={finish} className="btn-ghost btn-sm">
          Пропустить
        </button>
      </header>

      <div className="relative z-[1] mx-auto w-full max-w-[1040px] flex-1 px-8 pb-12">
        {step === 1 ? (
          <>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-accent">
              Распознавание речи
            </p>
            <h1 className="text-[32px] font-semibold leading-tight tracking-tight">
              Настройте локальное распознавание речи
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-muted">
              SkillCue слушает вопросы интервью и распознаёт их в реальном времени. Выберите, как
              это работает — по умолчанию всё остаётся на вашем устройстве.
            </p>

            <div className="mt-7 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="sc-card p-5">
                <div className="mb-2.5 flex items-center gap-2.5">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-accent">
                    <Stroke d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" size={18} />
                  </span>
                  <div>
                    <p className="text-[15px] font-semibold text-ink">Локальный Whisper</p>
                    <p className="text-xs font-medium text-accent">Рекомендуется</p>
                  </div>
                </div>
                <p className="text-sm leading-relaxed text-ink-muted">
                  Аудио распознаётся локально на вашем устройстве и{' '}
                  <strong className="font-semibold text-ink">не отправляется в облако</strong> в
                  локальном режиме. Распознавание выполняется на вашем CPU/GPU.
                </p>
              </div>

              <div className="sc-card p-5">
                <p className="mb-3 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                  Чего ожидать
                </p>
                <ul className="space-y-2.5 text-sm text-ink-muted">
                  <li className="flex items-start gap-2.5">
                    <span className="mt-0.5 text-emerald-400">
                      <Stroke d="M20 6 9 17l-5-5" />
                    </span>
                    Работает офлайн после загрузки модели
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="mt-0.5 text-amber-400">
                      <Stroke d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z|M12 9v4|M12 17h.01" />
                    </span>
                    Использует CPU/GPU — может влиять на батарею, шум вентилятора и производительность
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="mt-0.5 text-accent">
                      <Stroke d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4|M7 10l5 5 5-5|M12 15V3" />
                    </span>
                    Сначала нужно загрузить локальную речевую модель
                  </li>
                </ul>
              </div>
            </div>

            <div className="mt-5 rounded-2xl border border-amber-700/30 bg-amber-950/20 p-4 text-sm text-amber-200">
              <strong className="font-semibold">Этичное использование.</strong> Приложение помогает
              готовиться и работать на разрешённых созвонах. Не используйте его для обмана
              интервьюеров и предупреждайте участников о записи, если этого требуют правила.
            </div>

            <button onClick={() => setStep(2)} className="btn-primary mt-6 w-full py-3 sm:w-auto sm:px-8">
              Выбрать речевую модель
            </button>
          </>
        ) : (
          <div className="max-w-xl">
            <OnboardingSttStep onBack={() => setStep(1)} onContinue={finish} />
          </div>
        )}
      </div>
    </div>
  );
}
