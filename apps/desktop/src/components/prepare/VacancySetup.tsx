import { useState } from 'react';
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

  const canAnalyze = vacancyText.trim().length > 20 && !analyzing;

  return (
    <div className="space-y-5">
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
              <textarea
                className="prep-textarea mt-1"
                style={{ minHeight: 120 }}
                placeholder="Вставьте резюме, чтобы ответы опирались на реальный опыт…"
                value={resumeText}
                onChange={(e) => setResumeText(e.target.value)}
              />
            </div>
            <div>
              <label className="prep-faint">Interview legend</label>
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

        <div className="mt-4 flex items-center gap-3">
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
