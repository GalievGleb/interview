import { useMemo, useState } from 'react';
import {
  AUTO_VALUE,
  NormalizedModel,
  TAG_LABELS,
  filterModels,
  groupModelsForSelect,
} from '../lib/aiModels';

interface Props {
  label: string;
  description: string;
  value: string;
  models: NormalizedModel[];
  onChange: (value: string) => void;
  missing?: boolean;
  autoTitle?: string;
  autoSubtitle?: string;
}

export default function ModelSelect({
  label,
  description,
  value,
  models,
  onChange,
  missing = false,
  autoTitle = 'Автовыбор',
  autoSubtitle = 'SkillCue выберет модель по задаче',
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const sorted = useMemo(() => groupModelsForSelect(models), [models]);
  const filtered = useMemo(() => filterModels(sorted, query), [sorted, query]);

  const selectedLabel =
    value === AUTO_VALUE ? autoTitle : models.find((m) => m.id === value)?.name ?? value;

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery('');
  };

  return (
    <div className="space-y-1.5">
      <div>
        <p className="text-sm font-medium text-ink">{label}</p>
        <p className="text-xs text-ink-muted">{description}</p>
      </div>

      {missing && (
        <p className="text-xs text-amber-400">
          Выбранная модель недоступна в каталоге — выберите автовыбор или другую модель.
        </p>
      )}

      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="field flex w-full items-center justify-between text-left"
        >
          <span className="truncate">{selectedLabel}</span>
          <span className="ml-2 text-ink-faint">{open ? '▲' : '▼'}</span>
        </button>

        {open && (
          <div className="absolute z-20 mt-1 w-full rounded-xl border border-surface-border bg-surface-light shadow-card">
            <div className="border-b border-surface-border p-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Поиск по названию, id или провайдеру…"
                className="field text-sm"
                autoFocus
              />
            </div>
            <div className="max-h-56 overflow-y-auto p-1">
              <OptionRow
                title={autoTitle}
                subtitle={autoSubtitle}
                active={value === AUTO_VALUE}
                onPick={() => pick(AUTO_VALUE)}
              />
              {filtered.map((m) => (
                <OptionRow
                  key={m.id}
                  title={m.name}
                  subtitle={`${m.provider} · ${m.id}`}
                  tags={m.tags}
                  active={value === m.id}
                  onPick={() => pick(m.id)}
                />
              ))}
              {filtered.length === 0 && (
                <p className="px-2 py-3 text-xs text-ink-muted">
                  {models.length === 0
                    ? 'Каталог моделей пуст — синхронизируйте его в настройках AI. «Автовыбор» работает и без каталога.'
                    : 'Модели не найдены'}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function OptionRow({
  title,
  subtitle,
  tags = [],
  active,
  onPick,
}: {
  title: string;
  subtitle: string;
  tags?: string[];
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={`w-full rounded-lg px-2.5 py-2 text-left transition ${
        active ? 'bg-accent/15 ring-1 ring-accent/40' : 'hover:bg-surface-hover'
      }`}
    >
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="text-xs text-ink-muted">{subtitle}</p>
      {tags.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {tags.slice(0, 4).map((t) => (
            <span key={t} className="pill text-[10px]">
              {TAG_LABELS[t] ?? t}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
