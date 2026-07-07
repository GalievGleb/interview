import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import ModelSelect from './ModelSelect';
import { AiSettings, AUTO_VALUE, NormalizedModel, isModelMissing } from '../lib/aiModels';

/**
 * Выбор моделей. Ключ провайдера живёт на сервере (лицензионный гейтвей), поэтому
 * пользователь НЕ вводит ключ и не синхронизирует каталог вручную — модели
 * подтягиваются автоматически. Доступен только выбор модели под задачу.
 */
export default function AiModelsSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  const [initial, setInitial] = useState<AiSettings | null>(null);
  const [defaultModel, setDefaultModel] = useState(AUTO_VALUE);
  const [codingModel, setCodingModel] = useState(AUTO_VALUE);
  const [fastModel, setFastModel] = useState(AUTO_VALUE);
  const [deepModel, setDeepModel] = useState(AUTO_VALUE);
  const [vacancyModel, setVacancyModel] = useState(AUTO_VALUE);
  const [models, setModels] = useState<NormalizedModel[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const ai = await api.getAiSettings();
      setInitial(ai);
      setDefaultModel(ai.default_copilot_model);
      setCodingModel(ai.coding_assistant_model);
      setFastModel(ai.fast_live_model);
      setDeepModel(ai.deep_reasoning_model);
      setVacancyModel(ai.vacancy_review_model ?? AUTO_VALUE);

      // Каталог грузим всегда: из кэша, если он есть, иначе тянем сами через
      // лицензионный гейтвей — без ручной кнопки и без ввода ключа.
      try {
        const res = await api.listOpenRouterModels(ai.models_cache_count > 0);
        setModels(res.models);
      } catch {
        /* каталог недоступен (нет сети/лицензии) — останется «Автовыбор» */
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить настройки моделей');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => {
    if (!initial) return false;
    return (
      defaultModel !== initial.default_copilot_model ||
      codingModel !== initial.coding_assistant_model ||
      fastModel !== initial.fast_live_model ||
      deepModel !== initial.deep_reasoning_model ||
      vacancyModel !== (initial.vacancy_review_model ?? AUTO_VALUE)
    );
  }, [initial, defaultModel, codingModel, fastModel, deepModel, vacancyModel]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await api.saveAiSettings({
        provider: initial?.provider ?? 'openrouter',
        base_url: initial?.base_url ?? '',
        default_copilot_model: defaultModel,
        coding_assistant_model: codingModel,
        fast_live_model: fastModel,
        deep_reasoning_model: deepModel,
        vacancy_review_model: vacancyModel,
      });
      await load();
      setToast('Настройки сохранены');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="card mb-5 p-5 text-sm text-ink-muted">Загрузка моделей…</div>;
  }

  return (
    <div className="card mb-5 space-y-6 p-5">
      <div>
        <h3 className="text-sm font-semibold text-ink">Выбор моделей</h3>
        <p className="mt-0.5 text-sm text-ink-muted">
          «Автовыбор» — SkillCue сам подбирает модель под задачу. При желании поставьте конкретную.
        </p>
      </div>

      <div className="space-y-5">
        <ModelSelect
          label="Основная модель Copilot"
          description="Для обычных ответов и общих действий SkillCue."
          value={defaultModel}
          models={models}
          missing={isModelMissing(defaultModel, models)}
          onChange={setDefaultModel}
        />
        <ModelSelect
          label="Модель для кода"
          description="Для задач, где важны код, архитектура, технические объяснения и исправления."
          value={codingModel}
          models={models}
          missing={isModelMissing(codingModel, models)}
          onChange={setCodingModel}
        />
        <ModelSelect
          label="Быстрая live-модель"
          description="Для коротких ответов в реальном интервью. Здесь важнее скорость, чем глубокий анализ."
          value={fastModel}
          models={models}
          missing={isModelMissing(fastModel, models)}
          onChange={setFastModel}
          autoSubtitle="SkillCue выберет быструю модель для live-ответов"
        />
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
          <ModelSelect
            label="Модель разбора вакансии"
            description="Для вкладки «Разбор вакансии», Smoke Review и оценки ответов. Ставьте тяжёлую модель: GPT-5.5, GPT-5.4 или Sonnet 4."
            value={vacancyModel}
            models={models}
            missing={isModelMissing(vacancyModel, models)}
            onChange={setVacancyModel}
            autoSubtitle="Авто выберет сильную модель для медленного, качественного разбора вакансии"
          />
        </div>
        <ModelSelect
          label="Модель глубокого анализа"
          description="Для детального анализа, mock feedback, резюме и истории опыта. Не влияет на live-скорость."
          value={deepModel}
          models={models}
          missing={isModelMissing(deepModel, models)}
          onChange={setDeepModel}
          autoSubtitle="SkillCue выберет reasoning-модель для подробного анализа"
        />
      </div>

      <div className="flex items-center gap-3 border-t border-surface-border pt-4">
        <button onClick={save} disabled={!dirty || saving} className="btn-primary">
          {saving ? 'Сохраняю…' : 'Сохранить'}
        </button>
        {toast && <p className="text-sm text-emerald-400">{toast}</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}
        {!dirty && !toast && <p className="text-xs text-ink-faint">Нет изменений</p>}
      </div>
    </div>
  );
}
