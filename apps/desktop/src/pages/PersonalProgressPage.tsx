import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BrainCircuit,
  MessageCircleMore,
  RefreshCw,
  Sparkles,
  Target,
} from 'lucide-react';
import {
  api,
  type DevelopmentProfile,
  type DevelopmentProfileTrack,
} from '../lib/api';
import { useI18n } from '../lib/i18n';

function scoreLabel(score: number | null): string {
  return score == null ? '—' : `${score}/100`;
}

function TrackCard({
  title,
  description,
  track,
  kind,
}: {
  title: string;
  description: string;
  track: DevelopmentProfileTrack;
  kind: 'technical' | 'hr';
}) {
  const { t } = useI18n();
  const Icon = kind === 'technical' ? BrainCircuit : MessageCircleMore;
  return (
    <article className={`growth-track growth-track--${kind}`}>
      <header className="growth-track__head">
        <span className="growth-track__icon" aria-hidden="true">
          <Icon size={19} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="growth-track__title">{title}</p>
          <p className="growth-track__description">{description}</p>
        </div>
        <div className="growth-track__score">
          <strong>{scoreLabel(track.score)}</strong>
          <span>{track.level ?? t('progress.notEnough')}</span>
        </div>
      </header>

      <div className="growth-track__meter" aria-hidden="true">
        <span style={{ width: `${track.score ?? 0}%` }} />
      </div>

      <div className="growth-track__meta">
        <span>{t('progress.sessionsEvidence')}: {track.evidenceCount}</span>
        <span>{t('progress.confidence')}: {Math.round(track.confidence * 100)}%</span>
      </div>

      {track.evidenceCount === 0 ? (
        <div className="growth-track__empty">{t('progress.trackEmpty')}</div>
      ) : (
        <div className="growth-evidence-grid">
          <section>
            <h3>{t('progress.strengths')}</h3>
            {track.strengths.length ? (
              <div className="growth-topic-list">
                {track.strengths.map((item) => (
                  <div key={item.topic} className="growth-topic growth-topic--strong">
                    <span>{item.topic}</span>
                    <strong>{item.score}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <p className="growth-muted">{t('progress.noStrengths')}</p>
            )}
          </section>

          <section>
            <h3>{t('progress.focus')}</h3>
            {track.focusAreas.length ? (
              <div className="growth-topic-list">
                {track.focusAreas.map((item) => (
                  <div key={item.topic} className="growth-topic growth-topic--focus">
                    <div>
                      <span>{item.topic}</span>
                      {item.learningAction && <small>{item.learningAction}</small>}
                    </div>
                    <strong>{item.score}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <p className="growth-muted">{t('progress.noFocus')}</p>
            )}
          </section>
        </div>
      )}
    </article>
  );
}

export default function PersonalProgressPage() {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<DevelopmentProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setProfile(await api.getDevelopmentProfile());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('progress.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="prep h-full overflow-y-auto">
      <div className="prep-wrap prep-rise growth-page">
        <header className="growth-hero">
          <div>
            <p className="prep-eyebrow">{t('progress.eyebrow')}</p>
            <h1 className="prep-h1 mt-1">{t('progress.title')}</h1>
            <p className="prep-sub mt-2 max-w-3xl">{t('progress.subtitle')}</p>
          </div>
          <button
            type="button"
            className="prep-btn prep-btn-secondary prep-btn-sm"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {t('progress.refresh')}
          </button>
        </header>

        {loading && !profile && (
          <div className="growth-loading" role="status">
            <span className="growth-spinner" aria-hidden="true" />
            <div>
              <strong>{t('progress.loading')}</strong>
              <p>{t('progress.loadingHint')}</p>
            </div>
          </div>
        )}

        {error && (
          <div className="growth-error" role="alert">
            <strong>{t('progress.loadFailed')}</strong>
            <p>{error}</p>
            <button type="button" className="prep-btn prep-btn-sm" onClick={() => void load()}>
              {t('progress.retry')}
            </button>
          </div>
        )}

        {profile && profile.analyzedSessions === 0 && (
          <section className="growth-empty">
            <span className="growth-empty__icon" aria-hidden="true"><Sparkles size={24} /></span>
            <div>
              <h2>{t('progress.emptyTitle')}</h2>
              <p>{t('progress.emptyBody')}</p>
            </div>
            <button type="button" className="prep-btn" onClick={() => navigate('/history')}>
              {t('progress.openSessions')}
            </button>
          </section>
        )}

        {profile && profile.analyzedSessions > 0 && (
          <>
            <section className="growth-summary" aria-label={t('progress.summaryAria')}>
              <div className="growth-summary__lead">
                <span><Target size={18} /></span>
                <div>
                  <small>{t('progress.analyzed')}</small>
                  <strong>{profile.analyzedSessions}</strong>
                </div>
              </div>
              <div>
                <small>{t('progress.technical')}</small>
                <strong>{scoreLabel(profile.technical.score)}</strong>
              </div>
              <div>
                <small>{t('progress.hr')}</small>
                <strong>{scoreLabel(profile.hr.score)}</strong>
              </div>
              <p>{t('progress.separateNote')}</p>
            </section>

            <section className="growth-tracks">
              <TrackCard
                title={t('progress.technical')}
                description={t('progress.technicalDesc')}
                track={profile.technical}
                kind="technical"
              />
              <TrackCard
                title={t('progress.hr')}
                description={t('progress.hrDesc')}
                track={profile.hr}
                kind="hr"
              />
            </section>

            <section className="growth-recent">
              <div className="growth-section-head">
                <div>
                  <p className="prep-eyebrow">{t('progress.historyEyebrow')}</p>
                  <h2 className="prep-h2 mt-1">{t('progress.recent')}</h2>
                </div>
                <button
                  type="button"
                  className="prep-btn prep-btn-ghost prep-btn-sm"
                  onClick={() => navigate('/history')}
                >
                  {t('progress.openSessions')}
                </button>
              </div>
              <div className="growth-recent-list">
                {profile.recentSessions.map((session) => (
                  <button
                    key={session.sessionId}
                    type="button"
                    className="growth-recent-row"
                    onClick={() => navigate('/history')}
                  >
                    <span className={`growth-kind growth-kind--${session.interviewType}`}>
                      {session.interviewType === 'hr'
                        ? t('progress.hrShort')
                        : session.interviewType === 'technical'
                          ? t('progress.techShort')
                          : t('progress.mixedShort')}
                    </span>
                    <div className="min-w-0 flex-1">
                      <strong>{session.title || t('progress.sessionFallback')}</strong>
                      <small>
                        {new Date(session.startedAt).toLocaleDateString(
                          lang === 'en' ? 'en-US' : 'ru-RU',
                        )} · {session.overallLevel || t('progress.notEnough')}
                      </small>
                    </div>
                    <b>{session.score}</b>
                  </button>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
