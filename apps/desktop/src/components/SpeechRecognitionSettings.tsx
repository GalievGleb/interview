import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

type ProviderState = {
  available: boolean;
  reason: string;
};

export default function SpeechRecognitionSettings() {
  const navigate = useNavigate();
  const [provider, setProvider] = useState<ProviderState | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void api
      .sttProviders()
      .then((result) => {
        if (!active) return;
        const current = result.providers.find((item) => item.id === result.default);
        setProvider({
          available: Boolean(current?.available),
          reason: current?.reason ?? 'Провайдер недоступен',
        });
      })
      .catch((cause) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : 'Не удалось проверить распознавание речи');
        }
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section className="mb-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-ink">Распознавание речи</h3>
        <p className="mt-1 text-sm text-ink-muted">
          SkillCue использует один настроенный движок. Выбирать модель и скачивать локальные файлы
          больше не нужно.
        </p>
      </div>

      <div className="sc-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <p className="font-semibold text-ink">OpenAI Mini Transcribe</p>
              <span className="sc-badge sc-badge--accent">Основной</span>
            </div>
            <p className="mt-1 text-sm text-ink-muted">Модель: gpt-4o-mini-transcribe</p>
            <p className="mt-2 max-w-2xl text-xs leading-relaxed text-ink-faint">
              После окончания реплики аудио отправляется в облачный сервис OpenAI. SkillCue
              передает результат без словарных замен и исправления технических терминов.
            </p>
          </div>
          <span
            className={`sc-badge ${provider?.available ? 'sc-badge--accent' : ''}`}
            aria-live="polite"
          >
            {provider == null
              ? 'Проверяем'
              : provider.available
                ? 'Готово'
                : 'Недоступно'}
          </span>
        </div>
        {provider && !provider.available && (
          <p className="mt-3 text-sm text-amber-300">{provider.reason}</p>
        )}
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      </div>

      <div className="sc-card flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <p className="text-sm font-medium text-ink">Проверка качества</p>
          <p className="mt-1 text-xs text-ink-faint">
            Запустите запись на своих интервью-вопросах и сравните результат с эталоном.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => navigate('/benchmark')} className="btn-secondary btn-sm">
            Открыть STT Benchmark
          </button>
          <button type="button" onClick={() => navigate('/diagnostics')} className="btn-secondary btn-sm">
            Диагностика
          </button>
        </div>
      </div>
    </section>
  );
}
