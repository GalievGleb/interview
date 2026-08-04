import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Check, ChevronDown, Compass, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import { api, type DevelopmentProfile, type DevelopmentProfileTopic } from '../lib/api';

type RoleId = 'qa-python' | 'qa-java' | 'qa-manual' | 'backend' | 'frontend';
type SelfLevel = 0 | 1 | 2 | 3;
interface GrowthSetup { role: RoleId; optional: string[]; answers: Record<string, SelfLevel>; completed: boolean }

const STORAGE_KEY = 'skillcue.growth-profile.v1';
const ROLES: Record<RoleId, { label: string; core: string[]; optional: string[] }> = {
  'qa-python': { label: 'QA Automation · Python', core: ['Python', 'Pytest', 'API-тестирование', 'UI-автоматизация', 'CI/CD', 'Архитектура автотестов'], optional: ['Нагрузочное тестирование', 'Мобильное тестирование', 'Безопасность', 'Управление командой'] },
  'qa-java': { label: 'QA Automation · Java', core: ['Java', 'JUnit / TestNG', 'API-тестирование', 'UI-автоматизация', 'CI/CD', 'Архитектура автотестов'], optional: ['Нагрузочное тестирование', 'Мобильное тестирование', 'Безопасность', 'Управление командой'] },
  'qa-manual': { label: 'QA Engineer · Manual', core: ['Тест-дизайн', 'API', 'SQL', 'Web', 'Баг-репорты', 'Процессы тестирования'], optional: ['Мобильное тестирование', 'Нагрузочное тестирование', 'Безопасность', 'Автоматизация'] },
  backend: { label: 'Backend-разработчик', core: ['Язык и runtime', 'API', 'Базы данных', 'Архитектура', 'Тестирование', 'CI/CD'], optional: ['Высокие нагрузки', 'Безопасность', 'Cloud', 'Управление командой'] },
  frontend: { label: 'Frontend-разработчик', core: ['JavaScript / TypeScript', 'Фреймворк', 'Web API', 'Архитектура frontend', 'Тестирование', 'Производительность UI'], optional: ['Доступность', 'Mobile Web', 'Node.js', 'Управление командой'] },
};
const LEVELS: Array<{ value: SelfLevel; label: string }> = [
  { value: 0, label: 'Не работал' }, { value: 1, label: 'Знаком' },
  { value: 2, label: 'Использую' }, { value: 3, label: 'Уверенно' },
];

function loadSetup(): GrowthSetup {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '') as GrowthSetup;
    if (value?.role && ROLES[value.role]) return value;
  } catch { /* first visit */ }
  return { role: 'qa-python', optional: [], answers: {}, completed: false };
}
function relatedEvidence(topic: string, items: DevelopmentProfileTopic[]): DevelopmentProfileTopic | undefined {
  const words = topic.toLocaleLowerCase('ru').split(/[^a-zа-яё0-9+#.]+/i).filter((word) => word.length > 2);
  return items.find((item) => words.some((word) => item.topic.toLocaleLowerCase('ru').includes(word)));
}

export default function PersonalProgressPage() {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<DevelopmentProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [setup, setSetup] = useState<GrowthSetup>(loadSetup);
  const [assessmentOpen, setAssessmentOpen] = useState(false);
  const [optionalOpen, setOptionalOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setProfile(await api.getDevelopmentProfile()); }
    catch (err) { setError(err instanceof Error ? err.message : 'Не удалось загрузить профиль'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const role = ROLES[setup.role];
  const topics = [...role.core, ...setup.optional];
  const evidence = useMemo(() => profile ? [...profile.technical.strengths, ...profile.technical.focusAreas] : [], [profile]);
  const reliableTechnicalScore = profile && profile.technical.evidenceCount >= 3 && profile.technical.confidence >= 0.55;
  const saveSetup = () => {
    const next = { ...setup, completed: true };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setSetup(next); setAssessmentOpen(false);
  };

  return (
    <div className="prep h-full overflow-y-auto">
      <main className="prep-wrap prep-rise competency-page">
        <header className="competency-hero">
          <div>
            <p className="prep-eyebrow">ЛИЧНОЕ РАЗВИТИЕ</p>
            <h1 className="prep-h1 mt-1">Профиль компетенций</h1>
            <p className="prep-sub mt-2 max-w-3xl">SkillCue учитывает только вашу специализацию и подтверждает картину реальными ответами с собеседований.</p>
          </div>
          <button type="button" className="prep-btn prep-btn-secondary prep-btn-sm" onClick={() => void load()} disabled={loading}><RefreshCw size={14} className={loading ? 'animate-spin' : ''} />Обновить</button>
        </header>

        {error && <div className="growth-error" role="alert"><div><strong>Не удалось загрузить профиль</strong><p>{error}</p></div></div>}

        <section className="competency-scope">
          <div className="competency-scope__icon"><Compass size={21} /></div>
          <div className="competency-scope__copy"><small>ВАША ТРАЕКТОРИЯ</small><strong>{role.label}</strong><p>Оцениваем {role.core.length} основных направлений. Смежные области не считаются пробелами.</p></div>
          <button type="button" className="prep-btn prep-btn-ghost prep-btn-sm" onClick={() => setAssessmentOpen(true)}>Уточнить профиль</button>
        </section>

        {!setup.completed && !assessmentOpen && <section className="competency-consent"><Sparkles size={22} /><div><strong>Помочь SkillCue быстрее понять ваш уровень?</strong><p>Короткая добровольная самооценка займёт около двух минут. Она не заменяет оценку по интервью.</p></div><button className="prep-btn" onClick={() => setAssessmentOpen(true)}>Начать</button></section>}

        {assessmentOpen && <section className="competency-setup">
          <div className="competency-section-head"><div><p className="prep-eyebrow">ДОБРОВОЛЬНАЯ НАСТРОЙКА</p><h2>Сначала зададим границы вашей профессии</h2><p>Ответы хранятся отдельно как самооценка. SkillCue не выдаёт их за подтверждённые знания.</p></div>{setup.completed && <button className="prep-btn prep-btn-ghost prep-btn-sm" onClick={() => setAssessmentOpen(false)}>Закрыть</button>}</div>
          <label className="competency-role-select"><span>Специализация</span><select value={setup.role} onChange={(event) => setSetup({ role: event.target.value as RoleId, optional: [], answers: {}, completed: false })}>{Object.entries(ROLES).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}</select></label>
          <div className="competency-questions">
            {role.core.map((topic) => <div className="competency-question" key={topic}><strong>{topic}</strong><div>{LEVELS.map((level) => <button type="button" key={level.value} className={setup.answers[topic] === level.value ? 'is-active' : ''} onClick={() => setSetup({ ...setup, answers: { ...setup.answers, [topic]: level.value } })}>{level.label}</button>)}</div></div>)}
          </div>
          <button type="button" className="competency-optional-toggle" onClick={() => setOptionalOpen(!optionalOpen)}><ChevronDown size={16} className={optionalOpen ? 'rotate-180' : ''} /><span><strong>Смежные направления</strong><small>Необязательно — учитываем только выбранные вами</small></span></button>
          {optionalOpen && <div className="competency-optionals">{role.optional.map((topic) => <label key={topic}><input type="checkbox" checked={setup.optional.includes(topic)} onChange={() => setSetup({ ...setup, optional: setup.optional.includes(topic) ? setup.optional.filter((item) => item !== topic) : [...setup.optional, topic] })} />{topic}</label>)}</div>}
          <div className="competency-setup__footer"><p><ShieldCheck size={15} />Неотмеченная или не заданная тема — это «нет данных», а не слабость.</p><button className="prep-btn" disabled={role.core.some((topic) => setup.answers[topic] == null)} onClick={saveSetup}><Check size={15} />Сохранить мой профиль</button></div>
        </section>}

        {setup.completed && <>
          <section className="competency-overview">
            <div><small>ДАННЫЕ ИНТЕРВЬЮ</small><strong>{profile?.analyzedSessions ?? 0}</strong><span>{profile?.analyzedSessions === 1 ? 'разобрана 1 сессия' : `разобрано сессий: ${profile?.analyzedSessions ?? 0}`}</span></div>
            <div><small>ТЕХНИЧЕСКАЯ КАРТИНА</small><strong>{reliableTechnicalScore ? `${profile?.technical.score}/100` : 'Предварительно'}</strong><span>{reliableTechnicalScore ? `уверенность ${Math.round((profile?.technical.confidence ?? 0) * 100)}%` : 'нужно ещё 2–3 технических интервью'}</span></div>
            <div><small>HR И САМОПРЕЗЕНТАЦИЯ</small><strong>{profile && profile.hr.evidenceCount >= 2 ? profile.hr.level || 'Есть данные' : 'Мало данных'}</strong><span>оценивается отдельно от технических знаний</span></div>
          </section>

          <section className="competency-map">
            <div className="competency-section-head"><div><p className="prep-eyebrow">КАРТА СПЕЦИАЛИЗАЦИИ</p><h2>{role.label}</h2><p>Самооценка задаёт отправную точку, интервью постепенно подтверждают или корректируют её.</p></div></div>
            <div className="competency-map__list">{topics.map((topic) => {
              const observed = relatedEvidence(topic, evidence);
              const self = setup.answers[topic];
              const isOptional = setup.optional.includes(topic);
              return <div className="competency-row" key={topic}><div className="competency-row__name"><strong>{topic}</strong>{isOptional && <small>добавлено вами</small>}</div><div className="competency-row__self"><small>Самооценка</small><span>{LEVELS.find((item) => item.value === self)?.label ?? 'Не указано'}</span></div><div className="competency-row__evidence"><small>По интервью</small>{observed ? <span className={observed.score >= 70 ? 'is-strong' : 'is-focus'}>{observed.score >= 70 ? 'Подтверждается' : 'Стоит укрепить'} · {observed.evidenceCount}</span> : <span className="is-unknown">Пока не проверялось</span>}</div></div>;
            })}</div>
          </section>

          <section className="competency-history">
            <div className="competency-section-head"><div><p className="prep-eyebrow">ОСНОВАНИЕ ПРОФИЛЯ</p><h2>Разобранные интервью</h2><p>Каждая новая сессия делает картину точнее, но не штрафует за темы, которых не спрашивали.</p></div><button className="prep-btn prep-btn-ghost prep-btn-sm" onClick={() => navigate('/history')}>Все сессии <ArrowRight size={14} /></button></div>
            {profile?.recentSessions.length ? <div className="competency-history__list">{profile.recentSessions.map((session) => <button key={session.sessionId} onClick={() => navigate('/history')}><span className={`growth-kind growth-kind--${session.interviewType}`}>{session.interviewType === 'hr' ? 'HR' : session.interviewType === 'technical' ? 'TECH' : 'MIX'}</span><div><strong>{session.title || 'Интервью'}</strong><small>{new Date(session.startedAt).toLocaleDateString('ru-RU')} · {session.confidence < 0.5 ? 'данные неоднозначны' : session.overallLevel || 'уровень уточняется'}</small></div><span>{session.confidence < 0.5 ? 'Низкая уверенность' : 'Учтено в профиле'}</span></button>)}</div> : <div className="competency-history__empty">Разберите первую сохранённую сессию — здесь появятся подтверждения из реальных ответов.</div>}
          </section>
        </>}
      </main>
    </div>
  );
}
