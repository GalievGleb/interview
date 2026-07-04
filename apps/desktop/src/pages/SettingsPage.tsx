import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useApp } from '../context/AppContext';
import Modal from '../components/Modal';
import MicrophoneSettings from '../components/MicrophoneSettings';
import AiModelsSettings from '../components/AiModelsSettings';
import SpeechRecognitionSettings from '../components/SpeechRecognitionSettings';
import DiagnosticsPanel from '../components/DiagnosticsPanel';
import ScreenHeader from '../components/ScreenHeader';
import UsageCard from '../components/UsageCard';

type SettingsTab = 'ai' | 'speech' | 'privacy' | 'developer';

const TABS: Array<{ id: SettingsTab; label: string; hint: string }> = [
  { id: 'ai', label: 'AI-модели', hint: 'ключи, OpenRouter, модели для live и вакансий' },
  { id: 'speech', label: 'Речь и микрофон', hint: 'Whisper, качество записи, устройство' },
  { id: 'privacy', label: 'Приватность', hint: 'данные, лицензии, удаление' },
  { id: 'developer', label: 'Для разработчика', hint: 'тесты, диагностика, benchmark' },
];

export default function SettingsPage() {
  const { keys, refreshKeys } = useApp();
  const navigate = useNavigate();
  const [tab, setTab] = useState<SettingsTab>('ai');
  const [openai, setOpenai] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async () => {
    const changed: string[] = [];
    if (openai) changed.push('OpenAI');

    if (changed.length === 0) {
      setMessage('Нечего сохранять — введите ключ');
      return;
    }

    setSaving(true);
    setMessage('');
    try {
      await api.saveKeys({
        openai_api_key: openai || undefined,
      });
      setOpenai('');
      await refreshKeys();
      setMessage(`Ключ ${changed.join(', ')} обновлён`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setSaving(false);
    }
  };

  const deleteData = async () => {
    try {
      await api.deleteAllData();
      setMessage('Все данные удалены');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setConfirmDelete(false);
    }
  };

  const active = TABS.find((item) => item.id === tab)!;

  return (
    <div className="max-w-5xl">
      <ScreenHeader
        title="Настройки"
        subtitle={`${active.label}: ${active.hint}.`}
      />

      <div className="mb-5 flex flex-wrap items-center gap-2 rounded-2xl border border-surface-border bg-surface-light/70 p-2">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`rounded-xl px-3.5 py-2 text-left text-sm font-semibold transition-colors ${
              tab === item.id
                ? 'bg-surface-elevated text-ink shadow-soft'
                : 'text-ink-muted hover:bg-surface-hover hover:text-ink'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'ai' && (
        <>
          <AiModelsSettings />

          <div className="card mb-5 space-y-4 p-5">
            <div>
              <h3 className="text-sm font-semibold text-ink">Дополнительный OpenAI-ключ</h3>
              <p className="mt-0.5 text-sm text-ink-muted">
                Основной поток работает через OpenRouter. Этот ключ нужен только для отдельных
                fallback-сценариев.
              </p>
            </div>
            <KeyField
              label="OpenAI API Key"
              placeholder={keys?.openai ? '•••••••• (задан)' : 'sk-…'}
              value={openai}
              onChange={setOpenai}
            />
            <div className="flex items-center gap-3 pt-1">
              <button onClick={save} disabled={saving} className="btn-primary">
                {saving ? 'Сохраняю…' : 'Сохранить ключ'}
              </button>
              {message && <p className="text-sm text-emerald-400">{message}</p>}
            </div>
          </div>
        </>
      )}

      {tab === 'speech' && (
        <>
          <SpeechRecognitionSettings />
          <MicrophoneSettings />
        </>
      )}

      {tab === 'privacy' && (
        <>
          <div className="card mb-5 flex items-center justify-between gap-4 p-5">
            <div>
              <h3 className="text-sm font-semibold text-ink">Открытое ПО и лицензии</h3>
              <p className="mt-0.5 text-sm text-ink-muted">
                Уведомления о лицензиях встроенных open-source компонентов.
              </p>
            </div>
            <button type="button" onClick={() => navigate('/licenses')} className="btn-secondary btn-sm">
              Открыть
            </button>
          </div>

          <div className="rounded-2xl border border-red-900/40 bg-red-950/10 p-5">
            <h3 className="mb-1 text-sm font-semibold text-red-300">Удаление данных</h3>
            <p className="mb-4 text-sm text-ink-muted">
              Документы, сессии и история хранятся локально. Можно удалить их одной кнопкой.
              API-ключи останутся в secure storage.
            </p>
            <button onClick={() => setConfirmDelete(true)} className="btn-danger">
              Удалить все данные
            </button>
            {message && <p className="mt-3 text-sm text-emerald-400">{message}</p>}
          </div>
        </>
      )}

      {tab === 'developer' && (
        <>
          <div className="card mb-5 p-5">
            <h3 className="text-sm font-semibold text-ink">Инструменты разработчика</h3>
            <p className="mt-0.5 mb-3 text-sm text-ink-muted">
              Эти экраны нужны для отладки STT, latency и voice regression. В обычной подготовке
              они не участвуют.
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => navigate('/test-lab')} className="btn-secondary btn-sm">
                Тестовая лаборатория
              </button>
              <button type="button" onClick={() => navigate('/benchmark')} className="btn-secondary btn-sm">
                STT-бенчмарк
              </button>
              <button type="button" onClick={() => navigate('/diagnostics')} className="btn-secondary btn-sm">
                Диагностика задержек
              </button>
              <button type="button" onClick={() => navigate('/meeting')} className="btn-secondary btn-sm">
                Разбор разговора
              </button>
            </div>
          </div>

          <DiagnosticsPanel />
          <UsageCard />
        </>
      )}

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Удалить все данные?"
        subtitle="Документы, сессии и история будут удалены безвозвратно."
        footer={
          <>
            <button onClick={() => setConfirmDelete(false)} className="btn-secondary btn-sm">
              Отмена
            </button>
            <button onClick={deleteData} className="btn-danger btn-sm">
              Удалить
            </button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">
          Это действие нельзя отменить. API-ключи останутся в secure storage.
        </p>
      </Modal>
    </div>
  );
}

function KeyField({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <input
        type="password"
        name="openai_api_key"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="field"
      />
    </div>
  );
}
