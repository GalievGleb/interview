import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Compass } from 'lucide-react';
import {
  GROWTH_LEVELS,
  GROWTH_ROLES,
  growthRoleLabel,
  readGrowthProfile,
  saveGrowthProfile,
  type GrowthProfileSetup as GrowthProfileSetupValue,
  type GrowthRoleId,
} from '../../lib/growthProfile';

interface GrowthProfileSetupProps {
  initialOpen?: boolean;
  onSaved?: (profile: GrowthProfileSetupValue) => void;
}

function parseTopics(value: string): string[] {
  return [...new Set(value.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean))].slice(0, 12);
}

export default function GrowthProfileSetup({ initialOpen = false, onSaved }: GrowthProfileSetupProps) {
  const [profile, setProfile] = useState(readGrowthProfile);
  const [expanded, setExpanded] = useState(initialOpen);
  const [customTopicsText, setCustomTopicsText] = useState(() => profile.customTopics.join(', '));
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const roleRef = useRef<HTMLSelectElement>(null);
  const customRoleRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!initialOpen) return;
    setExpanded(true);
    window.requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
  }, [initialOpen]);

  const role = profile.role && profile.role !== 'custom' ? GROWTH_ROLES[profile.role] : null;
  const label = growthRoleLabel(profile);

  const selectRole = (value: string) => {
    const nextRole = value as GrowthRoleId;
    setProfile((current) => ({
      ...current,
      role: nextRole,
      optional: [],
      answers: {},
      completed: false,
    }));
    setError('');
    setSaved(false);
  };

  const save = () => {
    if (!profile.role) {
      setError('Выберите направление, чтобы SkillCue понимал, какие темы относятся к вашей цели.');
      roleRef.current?.focus();
      return;
    }
    if (profile.role === 'custom' && !profile.customRole.trim()) {
      setError('Укажите название роли или профессионального направления.');
      customRoleRef.current?.focus();
      return;
    }
    const next: GrowthProfileSetupValue = {
      ...profile,
      customRole: profile.customRole.trim(),
      customTopics: profile.role === 'custom' ? parseTopics(customTopicsText) : [],
      completed: true,
    };
    saveGrowthProfile(next);
    setProfile(next);
    setError('');
    setSaved(true);
    setExpanded(false);
    onSaved?.(next);
  };

  return (
    <section className="growth-goal-card" aria-labelledby="growth-goal-title">
      <div className="growth-goal-card__header">
        <span className="growth-goal-card__icon" aria-hidden="true"><Compass size={21} /></span>
        <div className="min-w-0 flex-1">
          <p className="prep-eyebrow">ПРОФЕССИОНАЛЬНАЯ ЦЕЛЬ</p>
          <h2 id="growth-goal-title" ref={headingRef} tabIndex={-1} className="prep-h2 prep-card-title">
            {label || 'К какой роли готовитесь?'}
          </h2>
        </div>
        <button
          type="button"
          className="prep-btn prep-btn-ghost prep-btn-sm"
          aria-expanded={expanded}
          aria-controls="growth-goal-editor"
          onClick={() => { setExpanded((value) => !value); setSaved(false); }}
        >
          {expanded ? 'Свернуть' : label ? 'Изменить цель' : 'Выбрать цель'}
          <ChevronDown size={15} aria-hidden="true" className={expanded ? 'rotate-180' : ''} />
        </button>
      </div>

      {saved && !expanded && (
        <p className="growth-goal-card__saved" role="status">
          <Check size={15} aria-hidden="true" /> Цель сохранена.
        </p>
      )}

      {expanded && (
        <div id="growth-goal-editor" className="growth-goal-editor">
          <label className="prep-field-label" htmlFor="growth-role">
            <span>Направление</span>
            <select
              ref={roleRef}
              id="growth-role"
              className="prep-input"
              value={profile.role ?? ''}
              aria-invalid={Boolean(error && !profile.role)}
              aria-describedby={error ? 'growth-goal-error' : 'growth-goal-help'}
              onChange={(event) => selectRole(event.target.value)}
            >
              <option value="">Выберите направление</option>
              {Object.entries(GROWTH_ROLES).map(([id, item]) => (
                <option key={id} value={id}>{item.label}</option>
              ))}
              <option value="custom">Другая специализация</option>
            </select>
          </label>
          <p id="growth-goal-help" className="prep-faint">Можно изменить позже — предыдущие результаты останутся в истории.</p>

          {profile.role === 'custom' && (
            <div className="growth-custom-fields">
              <label className="prep-field-label" htmlFor="growth-custom-role">
                <span>Название роли</span>
                <input
                  ref={customRoleRef}
                  id="growth-custom-role"
                  className="prep-input"
                  value={profile.customRole}
                  placeholder="Например: DevOps-инженер"
                  aria-invalid={Boolean(error && !profile.customRole.trim())}
                  aria-describedby={error ? 'growth-goal-error' : undefined}
                  onChange={(event) => { setProfile({ ...profile, customRole: event.target.value, completed: false }); setError(''); }}
                />
              </label>
              <label className="prep-field-label" htmlFor="growth-custom-topics">
                <span>Темы для отслеживания — необязательно</span>
                <textarea
                  id="growth-custom-topics"
                  className="prep-textarea"
                  rows={3}
                  value={customTopicsText}
                  placeholder="Docker, Kubernetes, CI/CD"
                  onChange={(event) => setCustomTopicsText(event.target.value)}
                />
              </label>
            </div>
          )}

          {role && (
            <>
              <div className="growth-baseline-heading">
                <div>
                  <h3>Стартовая самооценка</h3>
                  <p>Можно пропустить темы, в которых пока нет данных.</p>
                </div>
              </div>
              <div className="growth-baseline-list">
                {role.core.map((topic) => (
                  <fieldset className="growth-baseline-row" key={topic}>
                    <legend className="sr-only">{topic}</legend>
                    <div className="growth-baseline-row__content">
                      <strong aria-hidden="true">{topic}</strong>
                      <div className="growth-baseline-row__options">
                        {GROWTH_LEVELS.map((level) => (
                          <label key={level.value}>
                            <input
                              type="radio"
                              name={`growth-${topic}`}
                              value={level.value}
                              checked={profile.answers[topic] === level.value}
                              onChange={() => setProfile({
                                ...profile,
                                completed: false,
                                answers: { ...profile.answers, [topic]: level.value },
                              })}
                            />
                            <span>{level.label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </fieldset>
                ))}
              </div>
              <button
                type="button"
                className="growth-optional-toggle"
                aria-expanded={profile.optional.length > 0}
                onClick={() => setProfile({
                  ...profile,
                  optional: profile.optional.length > 0 ? [] : [...role.optional],
                  completed: false,
                })}
              >
                {profile.optional.length > 0 ? 'Убрать смежные направления' : 'Добавить смежные направления'}
              </button>
              {profile.optional.length > 0 && (
                <div className="growth-optional-list">
                  {role.optional.map((topic) => (
                    <label key={topic}>
                      <input
                        type="checkbox"
                        checked={profile.optional.includes(topic)}
                        onChange={() => setProfile({
                          ...profile,
                          completed: false,
                          optional: profile.optional.includes(topic)
                            ? profile.optional.filter((item) => item !== topic)
                            : [...profile.optional, topic],
                        })}
                      />
                      <span>{topic}</span>
                    </label>
                  ))}
                </div>
              )}
            </>
          )}

          {error && <p id="growth-goal-error" className="prep-inline-error" role="alert">{error}</p>}
          <div className="growth-goal-editor__footer">
            <button type="button" className="prep-btn" onClick={save}>
              <Check size={15} aria-hidden="true" /> Сохранить цель
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
