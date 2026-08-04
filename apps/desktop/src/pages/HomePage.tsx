import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  BriefcaseBusiness,
  CircleAlert,
  FileUser,
  type LucideIcon,
} from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../context/AppContext';
import { useI18n } from '../lib/i18n';
import {
  latestCompleted,
  latestInProgress,
} from '../lib/vacancyReview/vacancyReviewStore';

function readPreparationStore() {
  return {
    inProgress: latestInProgress(),
    completed: latestCompleted(),
  };
}

export default function HomePage() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { backendOnline, hasAnyKey, hasStt } = useApp();
  const [store, setStore] = useState(readPreparationStore);
  const [documents, setDocuments] = useState({ resume: 0, legend: 0 });
  const [profileReady, setProfileReady] = useState(false);
  const { inProgress, completed } = store;
  const report = inProgress ? undefined : completed?.report;

  useEffect(() => {
    const refresh = () => setStore(readPreparationStore());
    window.addEventListener('skillcue:mock-sessions-synced', refresh);
    return () => window.removeEventListener('skillcue:mock-sessions-synced', refresh);
  }, []);

  const refreshContext = useCallback(() => {
    void api
      .listDocuments()
      .then((result) => {
        setDocuments({
          resume: result.documents.filter((document) => document.kind === 'resume').length,
          legend: result.documents.filter((document) => document.kind === 'legend').length,
        });
      })
      .catch(() => {});
    void api
      .profilePackStatus()
      .then((status) => setProfileReady(status.exists))
      .catch(() => {});
  }, []);

  useEffect(() => refreshContext(), [refreshContext]);

  const weakest = useMemo(
    () => (report ? [...report.topicScores].sort((a, b) => a.score - b.score)[0] : undefined),
    [report],
  );
  const hasContext = documents.resume > 0 || documents.legend > 0;
  const serviceReady = backendOnline && hasAnyKey && hasStt;

  const primaryAction = inProgress
    ? {
        label: t('home.action.continueMock'),
        onClick: () => navigate(`/prepare?session=${inProgress.id}`),
      }
    : report && weakest
      ? {
          label: t('home.action.repeatWeak'),
          onClick: () =>
            navigate(`/prepare?session=${completed!.id}&focusTopic=${weakest.topicId}`),
        }
      : report
        ? {
            label: t('home.action.openReadiness'),
            onClick: () => navigate(`/prepare?session=${completed!.id}`),
          }
        : {
            label: t('home.action.reviewVacancy'),
            onClick: () => navigate('/prepare'),
          };

  const heroTitle = inProgress
    ? t('home.focused.continueTitle')
    : report
      ? t('home.focused.reportTitle')
      : t('home.focused.emptyTitle');
  const heroBody = inProgress
    ? `${inProgress.answers.length} ${t('home.report.of')} ${inProgress.questions.length} ${t('home.next.questionsDone')}`
    : report && weakest
      ? `${report.overallScore}% · ${t('home.focused.weakest')} ${weakest.title} · ${weakest.score}%`
      : t('home.focused.emptyBody');

  return (
    <div className="prep h-full overflow-y-auto">
      <div className="prep-wrap prep-home-v2 prep-rise">
        <section className="prep-focus-panel">
          <div className="prep-focus-panel__main">
            <p className="prep-eyebrow">{t('home.focused.eyebrow')}</p>
            <h1 className="prep-focus-title">{heroTitle}</h1>
            <p className="prep-sub prep-focus-copy">{heroBody}</p>

            <div className="prep-focus-actions">
              <button type="button" className="prep-btn" onClick={primaryAction.onClick}>
                {primaryAction.label}
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            </div>
          </div>

          <aside className="prep-context-rail" aria-label={t('home.readiness.aria')}>
            <div>
              <p className="prep-eyebrow">{t('home.context.eyebrow')}</p>
              <h2 className="prep-h2 mt-1">{t('home.context.title')}</h2>
            </div>
            <ContextRow
              icon={BriefcaseBusiness}
              title={t('home.check.vacancy')}
              detail={
                report
                  ? completed!.vacancyAnalysis.targetRole
                  : inProgress
                    ? inProgress.vacancyAnalysis.targetRole
                    : t('home.check.vacancy.empty')
              }
              ready={Boolean(report || inProgress)}
              onClick={() => navigate('/prepare')}
            />
            <ContextRow
              icon={FileUser}
              title={t('home.check.resume')}
              detail={
                hasContext
                  ? profileReady
                    ? t('home.check.resume.packReady')
                    : t('home.check.resume.docs')
                  : t('home.check.resume.empty')
              }
              ready={hasContext}
              onClick={() => navigate('/documents')}
            />
            {!serviceReady && (
              <ContextRow
                icon={CircleAlert}
                title={t('home.check.ai')}
                detail={t('home.check.ai.empty')}
                ready={false}
                onClick={() => navigate('/settings')}
              />
            )}
          </aside>
        </section>
      </div>
    </div>
  );
}

function ContextRow({
  icon: Icon,
  title,
  detail,
  ready,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  ready: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="prep-context-row" onClick={onClick}>
      <span className={`prep-context-row__icon ${ready ? 'is-ready' : ''}`}>
        <Icon size={15} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1 text-left">
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <ArrowRight size={14} aria-hidden="true" />
    </button>
  );
}
