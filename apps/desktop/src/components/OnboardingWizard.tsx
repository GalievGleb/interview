import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

const DISMISS_KEY = 'skillcue:onboarding-dismissed';

export function isOnboardingDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

interface Props {
  hasResume: boolean;
  hasVacancy: boolean;
  /** Дёргается после сохранения документа, чтобы главная обновила чеклист. */
  onDocsChanged: () => void;
  onDismiss: () => void;
}

/**
 * Мастер первого запуска: три шага до первой ценности (резюме → вакансия → мок).
 * Шаги выводятся из реальных данных, поэтому мастер продолжается с нужного места
 * даже после перезапуска приложения.
 */
export default function OnboardingWizard({ hasResume, hasVacancy, onDocsChanged, onDismiss }: Props) {
  const navigate = useNavigate();
  const [resumeText, setResumeText] = useState('');
  const [vacancyText, setVacancyText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const step = !hasResume ? 1 : !hasVacancy ? 2 : 3;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* приватный режим — просто скроем до перезапуска */
    }
    onDismiss();
  };

  const saveDoc = async (kind: 'resume' | 'vacancy', text: string) => {
    const trimmed = text.trim();
    if (trimmed.length < 30) {
      setError('Слишком коротко — вставьте полный текст, хотя бы пару абзацев.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const title =
        kind === 'resume' ? 'Резюме' : trimmed.split('\n')[0].slice(0, 60) || 'Вакансия';
      await api.uploadText(kind, title, trimmed);
      onDocsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить — проверьте, запущен ли backend.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="prep-card prep-card-pad prep-rise" aria-label="Первые шаги">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="prep-eyebrow">Первые шаги · {step} из 3</p>
          <h2 className="prep-h2 mt-1">
            {step === 1
              ? 'Шаг 1. Вставьте резюме — ответы будут вашими фактами'
              : step === 2
                ? 'Шаг 2. Вставьте вакансию, к которой готовитесь'
                : 'Шаг 3. Всё готово — прогоните первый мок'}
          </h2>
        </div>
        <button type="button" className="prep-link-btn shrink-0" onClick={dismiss}>
          Скрыть
        </button>
      </div>

      <div className="prep-flow-line mt-2" aria-hidden="true">
        <span style={hasResume ? { color: 'var(--prep-green)' } : undefined}>
          {hasResume ? '✓ ' : ''}Резюме
        </span>
        <span style={hasVacancy ? { color: 'var(--prep-green)' } : undefined}>
          {hasVacancy ? '✓ ' : ''}Вакансия
        </span>
        <span>Мок-интервью</span>
      </div>

      {step === 1 && (
        <>
          <p className="prep-sub mt-2">
            Без резюме подсказки будут общими. С резюме SkillCue отвечает вашим опытом и не
            выдумывает лишнего. Файлом (PDF/DOCX) можно загрузить на странице «Документы».
          </p>
          <textarea
            className="prep-textarea mt-3"
            style={{ minHeight: 140 }}
            placeholder="Вставьте текст резюме: опыт, проекты, стек…"
            value={resumeText}
            onChange={(e) => setResumeText(e.target.value)}
          />
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              className="prep-btn"
              disabled={saving}
              onClick={() => saveDoc('resume', resumeText)}
            >
              {saving ? 'Сохраняю…' : 'Сохранить резюме'}
            </button>
            <button type="button" className="prep-btn-ghost prep-btn-sm" onClick={() => navigate('/documents')}>
              Загрузить файлом
            </button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <p className="prep-sub mt-2">
            SkillCue разберёт её на требования и вероятные вопросы и соберёт план мок-интервью
            под эту конкретную роль.
          </p>
          <textarea
            className="prep-textarea mt-3"
            style={{ minHeight: 140 }}
            placeholder="Вставьте описание вакансии: обязанности, требования, стек…"
            value={vacancyText}
            onChange={(e) => setVacancyText(e.target.value)}
          />
          <div className="mt-3">
            <button
              type="button"
              className="prep-btn"
              disabled={saving}
              onClick={() => saveDoc('vacancy', vacancyText)}
            >
              {saving ? 'Сохраняю…' : 'Сохранить вакансию'}
            </button>
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <p className="prep-sub mt-2">
            Резюме и вакансия подключены. Первый мок займёт 20–30 минут: вопросы, честная
            оценка каждого ответа и карта готовности в конце.
          </p>
          <div className="mt-3">
            <button type="button" className="prep-btn" onClick={() => navigate('/prepare')}>
              Разобрать вакансию и начать мок
            </button>
          </div>
        </>
      )}

      {error && (
        <p className="mt-2 text-[13px]" style={{ color: 'var(--prep-red)' }}>
          {error}
        </p>
      )}
    </section>
  );
}
