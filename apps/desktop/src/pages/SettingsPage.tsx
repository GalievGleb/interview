import { useState } from 'react';

import { useNavigate } from 'react-router-dom';

import { api } from '../lib/api';

import { useApp } from '../context/AppContext';

import Modal from '../components/Modal';

import MicrophoneSettings from '../components/MicrophoneSettings';

import AiModelsSettings from '../components/AiModelsSettings';

import SpeechRecognitionSettings from '../components/SpeechRecognitionSettings';

import DiagnosticsPanel from '../components/DiagnosticsPanel';



export default function SettingsPage() {

  const { keys, refreshKeys } = useApp();

  const navigate = useNavigate();

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

      const what = changed.join(', ');

      setMessage(

        changed.length === 1

          ? `Ключ ${what} обновлён — прежнее значение заменено`

          : `Ключи обновлены (${what}) — прежние значения заменены`,

      );

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



  return (

    <div className="max-w-3xl">

      <div className="mb-6">

        <h2 className="page-title">Настройки</h2>

        <p className="page-subtitle">API-ключи хранятся локально (OS secure storage)</p>

      </div>



      <AiModelsSettings />



      <SpeechRecognitionSettings />



      <div className="card mb-5 space-y-4 p-5">

        <h3 className="text-sm font-semibold text-ink">Дополнительные ключи</h3>

        <KeyField

          label="OpenAI API Key"

          placeholder={keys?.openai ? '•••••••• (задан)' : 'sk-...'}

          value={openai}

          onChange={setOpenai}

        />

        <div className="flex items-center gap-3 pt-1">

          <button onClick={save} disabled={saving} className="btn-primary">

            {saving ? 'Сохранение...' : 'Сохранить ключи'}

          </button>

          {message && <p className="text-sm text-emerald-400">{message}</p>}

        </div>

      </div>



      <MicrophoneSettings />



      <DiagnosticsPanel />



      <div className="card mb-5 flex items-center justify-between p-5">

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

        <h3 className="mb-1 text-sm font-semibold text-red-300">Приватность</h3>

        <p className="mb-4 text-sm text-ink-muted">

          Все данные хранятся локально. Можно удалить всё одной кнопкой.

        </p>

        <button onClick={() => setConfirmDelete(true)} className="btn-danger">

          Удалить все данные

        </button>

      </div>



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

        placeholder={placeholder}

        value={value}

        onChange={(e) => onChange(e.target.value)}

        className="field"

      />

    </div>

  );

}


