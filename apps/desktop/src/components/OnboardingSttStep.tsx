import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface OnboardingSttStepProps {
  onBack: () => void;
  onContinue: () => void;
}

export default function OnboardingSttStep({ onBack, onContinue }: OnboardingSttStepProps) {
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .sttProviders()
      .then((result) => {
        if (!active) return;
        const current = result.providers.find((item) => item.id === result.default);
        setAvailable(Boolean(current?.available));
      })
      .catch(() => active && setAvailable(false));
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="card p-6">
      <p className="text-xs font-semibold uppercase tracking-wide text-accent">Голосовой ввод</p>
      <h2 className="mt-2 text-xl font-semibold tracking-tight text-ink">
        Распознавание уже настроено
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">
        SkillCue использует OpenAI <strong className="text-ink">gpt-4o-mini-transcribe</strong>.
        Модель выбирается автоматически, локальная загрузка не требуется.
      </p>

      <div className="sc-card mt-5 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-ink">OpenAI Mini Transcribe</p>
            <p className="mt-1 text-xs text-ink-faint">
              Русская речь и технические термины, результат без словарных подмен.
            </p>
          </div>
          <span className={`sc-badge ${available ? 'sc-badge--accent' : ''}`}>
            {available == null ? 'Проверяем' : available ? 'Готово' : 'Проверить подключение'}
          </span>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-surface-border bg-surface p-4 text-xs leading-relaxed text-ink-muted">
        Для распознавания фрагмент аудио отправляется в облачный сервис после окончания реплики.
        Исходный текст используется без дополнительных словарей и автоматической замены терминов.
      </div>

      <div className="mt-6 flex items-center justify-between">
        <button type="button" onClick={onBack} className="btn-secondary">
          Назад
        </button>
        <button type="button" onClick={onContinue} className="btn-primary">
          Продолжить
        </button>
      </div>
    </div>
  );
}
