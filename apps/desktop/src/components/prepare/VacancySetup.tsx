import { useEffect, useState } from 'react';
import { api, type DocumentItem } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import type { AnswerLanguage, VacancyReviewInput } from '../../lib/vacancyReview/types';

interface Props {
  onAnalyze: (input: VacancyReviewInput) => void;
  analyzing: boolean;
  error?: string;
}

export default function VacancySetup({ onAnalyze, analyzing, error }: Props) {
  const { t } = useI18n();
  const [vacancyText, setVacancyText] = useState('');
  const [targetRole, setTargetRole] = useState('');
  const [language, setLanguage] = useState<AnswerLanguage>('ru');
  const [resumeText, setResumeText] = useState('');
  const [legendText, setLegendText] = useState('');
  const [showContext, setShowContext] = useState(false);
  const [docs, setDocs] = useState<DocumentItem[]>([]);

  useEffect(() => {
    let alive = true;
    api
      .listDocuments()
      .then(async (r) => {
        if (!alive) return;
        setDocs(r.documents);
        // Автоподстановка сохранённых документов: последняя вакансия, резюме и
        // легенда подтягиваются сами (документы отсортированы по свежести) —
        // пользователь после онбординга сразу жмёт «Разобрать», ничего не вставляя.
        const latest = (kind: string) => r.documents.find((d) => d.kind === kind);
        const fills: Array<
          [{ id: string } | undefined, React.Dispatch<React.SetStateAction<string>>]
        > = [
          [latest('vacancy'), setVacancyText],
          [latest('resume'), setResumeText],
          [latest('legend'), setLegendText],
        ];
        for (const [doc, set] of fills) {
          if (!doc) continue;
          try {
            const full = await api.getDocument(doc.id);
            // Не затираем текст, который пользователь уже начал вводить.
            if (alive && full.text.trim()) set((prev) => (prev.trim() ? prev : full.text));
          } catch {
            /* backend недоступен — пользователь вставит вручную */
          }
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const loadDoc = async (id: string, into: 'resume' | 'legend') => {
    try {
      const doc = await api.getDocument(id);
      (into === 'resume' ? setResumeText : setLegendText)(doc.text);
    } catch {
      /* backend unavailable - paste manually */
    }
  };

  const canAnalyze = vacancyText.trim().length > 20 && !analyzing;

  return (
    <div className="prep-rise space-y-5">
      <div>
        <p className="prep-eyebrow">{t('nav.prepare')}</p>
        <h1 className="prep-h1 mt-1">{t('prep.title')}</h1>
        <p className="prep-sub mt-1.5 max-w-2xl">{t('prep.sub')}</p>
      </div>

      {analyzing ? (
        <div className="prep-card prep-card-pad prep-rise">
          <h2 className="prep-h2">{t('prep.analyzing.title')}</h2>
          <p className="prep-sub mt-1.5">{t('prep.analyzing.sub')}</p>
          <div className="prep-analyzing-steps mt-4">
            <span className="prep-analyzing-step">{t('prep.analyzing.step1')}</span>
            <span className="prep-analyzing-step">{t('prep.analyzing.step2')}</span>
            <span className="prep-analyzing-step">{t('prep.analyzing.step3')}</span>
          </div>
          <div className="prep-shimmer mt-5" aria-hidden="true" />
        </div>
      ) : (
      <div className="prep-card prep-card-pad">
        <label className="prep-h2">{t('prep.vacancyLabel')}</label>
        <textarea
          className="prep-textarea mt-2"
          placeholder={t('prep.vacancyPlaceholder')}
          value={vacancyText}
          onChange={(e) => setVacancyText(e.target.value)}
        />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="prep-faint">{t('prep.roleLabel')}</label>
            <input
              className="prep-input mt-1 w-full"
              placeholder={t('prep.rolePlaceholder')}
              value={targetRole}
              onChange={(e) => setTargetRole(e.target.value)}
            />
          </div>
          <div>
            <label className="prep-faint">{t('prep.answerLangLabel')}</label>
            <div className="mt-1 flex gap-1.5">
              {(['ru', 'en'] as AnswerLanguage[]).map((lng) => (
                <button
                  key={lng}
                  type="button"
                  onClick={() => setLanguage(lng)}
                  className={`prep-btn-sm flex-1 ${
                    language === lng ? 'prep-btn' : 'prep-btn-ghost'
                  }`}
                >
                  {lng.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>

        <button
          type="button"
          className="mt-3 text-[12.5px] font-bold"
          style={{ color: 'var(--prep-green)' }}
          onClick={() => setShowContext((v) => !v)}
        >
          {showContext ? t('prep.hideContext') : t('prep.showContext')}
        </button>

        {showContext && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="prep-faint">{t('docs.kind.resume')}</label>
              <SavedDocs docs={docs} onPick={(id) => loadDoc(id, 'resume')} />
              <textarea
                className="prep-textarea mt-1"
                style={{ minHeight: 120 }}
                placeholder={t('prep.resumePlaceholder')}
                value={resumeText}
                onChange={(e) => setResumeText(e.target.value)}
              />
            </div>
            <div>
              <label className="prep-faint">{t('docs.kind.legend')}</label>
              <SavedDocs docs={docs} onPick={(id) => loadDoc(id, 'legend')} />
              <textarea
                className="prep-textarea mt-1"
                style={{ minHeight: 120 }}
                placeholder={t('prep.legendPlaceholder')}
                value={legendText}
                onChange={(e) => setLegendText(e.target.value)}
              />
            </div>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className={`prep-chip ${resumeText.trim() ? 'prep-tone-green' : ''}`}>
            {resumeText.trim() ? t('docs.pillar.resumeOn') : t('docs.pillar.resumeOff')}
          </span>
          <span className={`prep-chip ${legendText.trim() ? 'prep-tone-green' : ''}`}>
            {legendText.trim() ? t('docs.pillar.legendOn') : t('docs.pillar.legendOff')}
          </span>
        </div>

        {error && (
          <p className="mt-3 text-[13px]" style={{ color: 'var(--prep-red)' }}>
            {error}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="prep-btn"
            disabled={!canAnalyze}
            onClick={() =>
              onAnalyze({
                vacancyText,
                targetRole: targetRole || undefined,
                language,
                resumeText: resumeText.trim() || undefined,
                legendText: legendText.trim() || undefined,
              })
            }
          >
            {analyzing ? t('prep.analyzingBtn') : t('home.action.reviewVacancy')}
          </button>
          <span className="prep-faint">
            {canAnalyze || analyzing ? t('prep.estimate') : t('prep.needText')}
          </span>
        </div>
      </div>
      )}
    </div>
  );
}

function SavedDocs({ docs, onPick }: { docs: DocumentItem[]; onPick: (id: string) => void }) {
  const { t } = useI18n();
  if (!docs.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      <span className="prep-faint self-center">{t('prep.savedDocs')}</span>
      {docs.slice(0, 6).map((d) => (
        <button
          key={d.id}
          type="button"
          className="prep-chip prep-doc-chip"
          title={`${d.kind} · ${d.title}`}
          onClick={() => onPick(d.id)}
        >
          {d.title.slice(0, 22)}
        </button>
      ))}
    </div>
  );
}
