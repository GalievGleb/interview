import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useApp } from '../context/AppContext';
import ModelSelect from './ModelSelect';
import {
  AiSettings,
  AUTO_VALUE,
  NormalizedModel,
  isModelMissing,
} from '../lib/aiModels';

const DEFAULT_BASE = 'https://openrouter.ai/api/v1';

export default function AiModelsSettings() {
  const { refreshKeys } = useApp();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  const [initial, setInitial] = useState<AiSettings | null>(null);
  const [provider, setProvider] = useState('openrouter');
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE);
  const [openrouterKey, setOpenrouterKey] = useState('');
  const [defaultModel, setDefaultModel] = useState(AUTO_VALUE);
  const [codingModel, setCodingModel] = useState(AUTO_VALUE);
  const [fastModel, setFastModel] = useState(AUTO_VALUE);
  const [deepModel, setDeepModel] = useState(AUTO_VALUE);
  const [vacancyModel, setVacancyModel] = useState(AUTO_VALUE);
  const [models, setModels] = useState<NormalizedModel[]>([]);
  const [hasKey, setHasKey] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const ai = await api.getAiSettings();
      setInitial(ai);
      setProvider(ai.provider);
      setBaseUrl(ai.base_url);
      setDefaultModel(ai.default_copilot_model);
      setCodingModel(ai.coding_assistant_model);
      setFastModel(ai.fast_live_model);
      setDeepModel(ai.deep_reasoning_model);
      setVacancyModel(ai.vacancy_review_model ?? AUTO_VALUE);
      setHasKey(ai.has_openrouter_key);

      if (ai.models_cache_count > 0) {
        const cached = await api.listOpenRouterModels(true);
        setModels(cached.models);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить AI-настройки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => {
    if (!initial) return false;
    const keyChanged = openrouterKey.length > 0;
    return (
      keyChanged ||
      provider !== initial.provider ||
      baseUrl !== initial.base_url ||
      defaultModel !== initial.default_copilot_model ||
      codingModel !== initial.coding_assistant_model ||
      fastModel !== initial.fast_live_model ||
      deepModel !== initial.deep_reasoning_model ||
      vacancyModel !== (initial.vacancy_review_model ?? AUTO_VALUE)
    );
  }, [
    initial,
    openrouterKey,
    provider,
    baseUrl,
    defaultModel,
    codingModel,
    fastModel,
    deepModel,
    vacancyModel,
  ]);

  const syncModels = async () => {
    setSyncing(true);
    setError('');
    try {
      if (openrouterKey) {
        await api.saveKeys({ openrouter_api_key: openrouterKey });
        setOpenrouterKey('');
        await refreshKeys();
        setHasKey(true);
      }
      const res = await api.listOpenRouterModels(false);
      setModels(res.models);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось синхронизировать модели');
    } finally {
      setSyncing(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setError('');
    try {
      if (openrouterKey) {
        await api.saveKeys({ openrouter_api_key: openrouterKey });
        setOpenrouterKey('');
        await refreshKeys();
        setHasKey(true);
      }
      const res = await api.testOpenRouter(defaultModel === AUTO_VALUE ? undefined : defaultModel);
      setToast(`Подключение работает: ${res.model}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка подключения');
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      if (openrouterKey) {
        await api.saveKeys({ openrouter_api_key: openrouterKey });
        setOpenrouterKey('');
        await refreshKeys();
        setHasKey(true);
      }
      await api.saveAiSettings({
        provider,
        base_url: baseUrl,
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
    return (
      <div className="card mb-5 p-5 text-sm text-ink-muted">Загрузка AI-моделей…</div>
    );
  }

  return (
    <div className="card mb-5 space-y-6 p-5">
      <div>
        <h3 className="text-sm font-semibold text-ink">AI-провайдер</h3>
        <p className="mt-0.5 text-sm text-ink-muted">
          OpenRouter — основной провайдер для SkillCue
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="label">Провайдер</label>
          <select value={provider} onChange={(e) => setProvider(e.target.value)} className="field">
            <option value="openrouter">OpenRouter</option>
            <option value="openai" disabled>
              OpenAI (позже)
            </option>
          </select>
        </div>
        <div>
          <label className="label">API-ключ OpenRouter</label>
          <div className="flex gap-2">
            <input
              type={showKey ? 'text' : 'password'}
              value={openrouterKey}
              onChange={(e) => setOpenrouterKey(e.target.value)}
              placeholder={hasKey ? '•••••••• (задан)' : 'sk-or-…'}
              className="field flex-1"
            />
            <button type="button" onClick={() => setShowKey((v) => !v)} className="btn-secondary btn-sm">
              {showKey ? 'Скрыть' : 'Показать'}
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={testConnection} disabled={testing || (!hasKey && !openrouterKey)} className="btn-secondary">
          {testing ? 'Проверяю…' : 'Проверить подключение'}
        </button>
        <button onClick={syncModels} disabled={syncing || (!hasKey && !openrouterKey)} className="btn-secondary">
          {syncing ? 'Синхронизация…' : 'Синхронизировать модели'}
        </button>
        <button type="button" onClick={() => setAdvanced((v) => !v)} className="btn-ghost btn-sm">
          {advanced ? 'Скрыть дополнительно' : 'Дополнительно'}
        </button>
        {initial?.last_models_sync_at && (
          <span className="text-xs text-ink-faint">
            Синхронизация: {new Date(initial.last_models_sync_at).toLocaleString()}
          </span>
        )}
      </div>

      {advanced && (
        <div>
          <label className="label">Базовый URL</label>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="field" />
        </div>
      )}

      <div className="border-t border-surface-border pt-5">
        <h3 className="mb-4 text-sm font-semibold text-ink">Выбор моделей</h3>
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
      </div>

      <div className="flex items-center gap-3 border-t border-surface-border pt-4">
        <button onClick={save} disabled={!dirty || saving} className="btn-primary">
          {saving ? 'Сохраняю…' : 'Сохранить'}
        </button>
        {toast && <p className="text-sm text-emerald-400">{toast}</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}
        {!dirty && !toast && <p className="text-xs text-ink-faint">Нет изменений</p>}
      </div>

      {models.length === 0 && (
        <p className="text-sm text-ink-muted">
          Список моделей пуст. Добавьте OpenRouter API key и нажмите «Синхронизировать модели».
        </p>
      )}
    </div>
  );
}
