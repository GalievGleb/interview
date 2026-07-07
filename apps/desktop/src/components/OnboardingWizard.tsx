import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';

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
  const { t } = useI18n();
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
      setError(t('wizard.tooShort'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      const title =
        kind === 'resume' ? t('docs.kind.resume') : trimmed.split('\n')[0].slice(0, 60) || t('docs.kind.vacancy');
      await api.uploadText(kind, title, trimmed);
      onDocsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('wizard.saveError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="prep-card prep-card-pad prep-rise" aria-label={t('wizard.firstSteps')}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="prep-eyebrow">{t('wizard.firstSteps')} · {step} {t('home.report.of')} 3</p>
          <h2 className="prep-h2 mt-1">
            {step === 1 ? t('wizard.step1') : step === 2 ? t('wizard.step2') : t('wizard.step3')}
          </h2>
        </div>
        <button type="button" className="prep-link-btn shrink-0" onClick={dismiss}>
          {t('overlay.pill.hide')}
        </button>
      </div>

      <div className="prep-flow-line mt-2" aria-hidden="true">
        <span style={hasResume ? { color: 'var(--prep-green)' } : undefined}>
          {hasResume ? '✓ ' : ''}{t('docs.kind.resume')}
        </span>
        <span style={hasVacancy ? { color: 'var(--prep-green)' } : undefined}>
          {hasVacancy ? '✓ ' : ''}{t('docs.kind.vacancy')}
        </span>
        <span>{t('wizard.mock')}</span>
      </div>

      {step === 1 && (
        <>
          <p className="prep-sub mt-2">{t('wizard.step1Sub')}</p>
          <textarea
            className="prep-textarea mt-3"
            style={{ minHeight: 140 }}
            placeholder={t('wizard.resumePlaceholder')}
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
              {saving ? t('common.saving') : t('wizard.saveResume')}
            </button>
            <button type="button" className="prep-btn-ghost prep-btn-sm" onClick={() => navigate('/documents')}>
              {t('wizard.uploadFile')}
            </button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <p className="prep-sub mt-2">{t('wizard.step2Sub')}</p>
          <textarea
            className="prep-textarea mt-3"
            style={{ minHeight: 140 }}
            placeholder={t('wizard.vacancyPlaceholder')}
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
              {saving ? t('common.saving') : t('wizard.saveVacancy')}
            </button>
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <p className="prep-sub mt-2">{t('wizard.step3Sub')}</p>
          <div className="mt-3">
            <button type="button" className="prep-btn" onClick={() => navigate('/prepare')}>
              {t('wizard.startMock')}
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
