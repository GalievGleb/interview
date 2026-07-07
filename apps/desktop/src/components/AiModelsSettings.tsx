import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import ModelSelect from './ModelSelect';
import { AiSettings, AUTO_VALUE, NormalizedModel, isModelMissing } from '../lib/aiModels';
import { useI18n } from '../lib/i18n';

/**
 * Выбор моделей. Ключ провайдера живёт на сервере (лицензионный гейтвей), поэтому
 * пользователь НЕ вводит ключ и не синхронизирует каталог вручную — модели
 * подтягиваются автоматически. Доступен только выбор модели под задачу.
 */
export default function AiModelsSettings() {
  const { t } = useI18n();
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
      setError(err instanceof Error ? err.message : t('aimodels.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

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
      setToast(t('aimodels.saved'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('aimodels.saveError'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="card mb-5 p-5 text-sm text-ink-muted">{t('aimodels.loading')}</div>;
  }

  return (
    <div className="card mb-5 space-y-6 p-5">
      <div>
        <h3 className="text-sm font-semibold text-ink">{t('aimodels.title')}</h3>
        <p className="mt-0.5 text-sm text-ink-muted">{t('aimodels.desc')}</p>
      </div>

      <div className="space-y-5">
        <ModelSelect
          label={t('aimodels.default.label')}
          description={t('aimodels.default.desc')}
          value={defaultModel}
          models={models}
          missing={isModelMissing(defaultModel, models)}
          onChange={setDefaultModel}
        />
        <ModelSelect
          label={t('aimodels.coding.label')}
          description={t('aimodels.coding.desc')}
          value={codingModel}
          models={models}
          missing={isModelMissing(codingModel, models)}
          onChange={setCodingModel}
        />
        <ModelSelect
          label={t('aimodels.fast.label')}
          description={t('aimodels.fast.desc')}
          value={fastModel}
          models={models}
          missing={isModelMissing(fastModel, models)}
          onChange={setFastModel}
          autoSubtitle={t('aimodels.fast.auto')}
        />
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
          <ModelSelect
            label={t('aimodels.vacancy.label')}
            description={t('aimodels.vacancy.desc')}
            value={vacancyModel}
            models={models}
            missing={isModelMissing(vacancyModel, models)}
            onChange={setVacancyModel}
            autoSubtitle={t('aimodels.vacancy.auto')}
          />
        </div>
        <ModelSelect
          label={t('aimodels.deep.label')}
          description={t('aimodels.deep.desc')}
          value={deepModel}
          models={models}
          missing={isModelMissing(deepModel, models)}
          onChange={setDeepModel}
          autoSubtitle={t('aimodels.deep.auto')}
        />
      </div>

      <div className="flex items-center gap-3 border-t border-surface-border pt-4">
        <button onClick={save} disabled={!dirty || saving} className="btn-primary">
          {saving ? t('common.saving') : t('common.save')}
        </button>
        {toast && <p className="text-sm text-emerald-400">{toast}</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}
        {!dirty && !toast && <p className="text-xs text-ink-faint">{t('aimodels.noChanges')}</p>}
      </div>
    </div>
  );
}
