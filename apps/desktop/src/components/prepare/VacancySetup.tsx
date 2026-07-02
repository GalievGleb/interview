import { useEffect, useState } from 'react';
import { api, type DocumentItem } from '../../lib/api';
import type { AnswerLanguage, VacancyReviewInput } from '../../lib/vacancyReview/types';

interface Props {
  onAnalyze: (input: VacancyReviewInput) => void;
  analyzing: boolean;
  error?: string;
}

export default function VacancySetup({ onAnalyze, analyzing, error }: Props) {
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
      .then((r) => alive && setDocs(r.documents))
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
        <p className="prep-eyebrow">Разбор вакансии</p>
        <h1 className="prep-h1 mt-1">Поймите, что вас спросят до интервью.</h1>
        <p className="prep-sub mt-1.5 max-w-2xl">
          Вставьте реальную вакансию, и SkillCue выделит требования, вероятные вопросы,
          темы риска и план короткого mock-интервью. Это подготовка под конкретную роль,
          а не общий список навыков.
        </p>
      </div>

      {analyzing ? (
        <div className="prep-card prep-card-pad prep-rise">
          <h2 className="prep-h2">Разбираю вакансию…</h2>
          <p className="prep-sub mt-1.5">Обычно это занимает несколько секунд.</p>
          <div className="prep-analyzing-steps mt-4">
            <span className="prep-analyzing-step">Читаю требования и стек</span>
            <span className="prep-analyzing-step">Сверяю с резюме и выделяю темы риска</span>
            <span className="prep-analyzing-step">Собираю план mock-интервью</span>
          </div>
          <div className="prep-shimmer mt-5" aria-hidden="true" />
        </div>
      ) : (
      <div className="prep-card prep-card-pad">
        <label className="prep-h2">Текст вакансии</label>
        <textarea
          className="prep-textarea mt-2"
          placeholder="Вставьте описание роли: обязанности, требования, стек, формат интервью..."
          value={vacancyText}
          onChange={(e) => setVacancyText(e.target.value)}
        />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="prep-faint">Целевая роль, если нужно уточнить</label>
            <input
              className="prep-input mt-1 w-full"
              placeholder="Например: QA Automation Engineer"
              value={targetRole}
              onChange={(e) => setTargetRole(e.target.value)}
            />
          </div>
          <div>
            <label className="prep-faint">Язык ответов</label>
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
          {showContext ? '− Скрыть резюме / легенду' : '+ Добавить резюме / легенду'}
        </button>

        {showContext && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="prep-faint">Резюме</label>
              <SavedDocs docs={docs} onPick={(id) => loadDoc(id, 'resume')} />
              <textarea
                className="prep-textarea mt-1"
                style={{ minHeight: 120 }}
                placeholder="Вставьте резюме или выберите сохранённый документ..."
                value={resumeText}
                onChange={(e) => setResumeText(e.target.value)}
              />
            </div>
            <div>
              <label className="prep-faint">Легенда опыта</label>
              <SavedDocs docs={docs} onPick={(id) => loadDoc(id, 'legend')} />
              <textarea
                className="prep-textarea mt-1"
                style={{ minHeight: 120 }}
                placeholder="Проекты, зона ответственности, формулировки для спорных мест..."
                value={legendText}
                onChange={(e) => setLegendText(e.target.value)}
              />
            </div>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className={`prep-chip ${resumeText.trim() ? 'prep-tone-green' : ''}`}>
            {resumeText.trim() ? 'Резюме подключено' : 'Резюме не подключено'}
          </span>
          <span className={`prep-chip ${legendText.trim() ? 'prep-tone-green' : ''}`}>
            {legendText.trim() ? 'Легенда подключена' : 'Легенда не подключена'}
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
            {analyzing ? 'Разбираю...' : 'Разобрать вакансию'}
          </button>
          <span className="prep-faint">8-15 вопросов · 20-30 минут mock</span>
        </div>
      </div>
      )}
    </div>
  );
}

function SavedDocs({ docs, onPick }: { docs: DocumentItem[]; onPick: (id: string) => void }) {
  if (!docs.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      <span className="prep-faint self-center">Сохранённые:</span>
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
