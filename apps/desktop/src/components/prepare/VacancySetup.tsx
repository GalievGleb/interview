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
      /* backend unavailable — paste manually */
    }
  };

  const canAnalyze = vacancyText.trim().length > 20 && !analyzing;

  return (
    <div className="prep-rise space-y-5">
      <div>
        <p className="prep-eyebrow">Vacancy Smoke Review</p>
        <h1 className="prep-h1 mt-1">Prepare by vacancy</h1>
        <p className="prep-sub mt-1.5 max-w-2xl">
          Paste a real job vacancy → get the topics this interview will likely cover → run a quick
          30-min mock → see where you’re not ready yet. Topics come straight from the vacancy, not a
          generic skills list.
        </p>
      </div>

      <div className="prep-card prep-card-pad">
        <label className="prep-h2">Vacancy text</label>
        <textarea
          className="prep-textarea mt-2"
          placeholder="Вставьте полный текст вакансии: обязанности, требования, стек…"
          value={vacancyText}
          onChange={(e) => setVacancyText(e.target.value)}
        />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="prep-faint">Target role (optional)</label>
            <input
              className="prep-input mt-1 w-full"
              placeholder="e.g. QA Automation Engineer"
              value={targetRole}
              onChange={(e) => setTargetRole(e.target.value)}
            />
          </div>
          <div>
            <label className="prep-faint">Language of answers</label>
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
          className="mt-3 text-[12.5px] font-medium"
          style={{ color: 'var(--prep-green)' }}
          onClick={() => setShowContext((v) => !v)}
        >
          {showContext ? '− Hide resume / legend' : '+ Add resume / legend (optional, improves grounding)'}
        </button>

        {showContext && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="prep-faint">Resume</label>
              <SavedDocs docs={docs} onPick={(id) => loadDoc(id, 'resume')} />
              <textarea
                className="prep-textarea mt-1"
                style={{ minHeight: 120 }}
                placeholder="Вставьте резюме или выберите сохранённый документ…"
                value={resumeText}
                onChange={(e) => setResumeText(e.target.value)}
              />
            </div>
            <div>
              <label className="prep-faint">Interview legend</label>
              <SavedDocs docs={docs} onPick={(id) => loadDoc(id, 'legend')} />
              <textarea
                className="prep-textarea mt-1"
                style={{ minHeight: 120 }}
                placeholder="Легенда: проекты, роли, формулировки для bridging-ответов…"
                value={legendText}
                onChange={(e) => setLegendText(e.target.value)}
              />
            </div>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className={`prep-chip ${resumeText.trim() ? 'prep-tone-green' : ''}`}>
            {resumeText.trim() ? 'Resume connected' : 'Resume context missing'}
          </span>
          <span className={`prep-chip ${legendText.trim() ? 'prep-tone-green' : ''}`}>
            {legendText.trim() ? 'Legend connected' : 'Legend not connected'}
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
            {analyzing ? 'Analyzing…' : 'Analyze vacancy'}
          </button>
          <span className="prep-faint">~8–15 questions · 20–30 min mock</span>
        </div>
      </div>
    </div>
  );
}

function SavedDocs({ docs, onPick }: { docs: DocumentItem[]; onPick: (id: string) => void }) {
  if (!docs.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      <span className="prep-faint self-center">Use saved:</span>
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
