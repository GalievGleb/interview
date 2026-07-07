import { useState } from 'react';
import {
  GENERAL_MODE,
  addMode,
  removeMode,
  updateMode,
  useAnswerModes,
} from '../lib/answerModes';
import { useI18n } from '../lib/i18n';

/**
 * Управление режимами ответа (аналог Manage Modes в Cluely).
 * Режим = имя + инструкция для модели; активный подмешивается к запросам
 * оверлея. Выбор режима доступен и из меню оверлея.
 */
export default function AnswerModesSettings() {
  const { t } = useI18n();
  const { modes, active, setActive } = useAnswerModes();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

  const editing = editingId ? modes.find((m) => m.id === editingId) : null;

  return (
    <div className="sc-card mb-5 p-5">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-ink">{t('modes.title')}</h3>
        <p className="mt-0.5 text-xs text-ink-faint">{t('modes.desc')}</p>
      </div>

      <div className="space-y-1.5">
        {modes.map((mode) => (
          <div
            key={mode.id}
            className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
              active.id === mode.id
                ? 'border-accent/50 bg-accent-soft'
                : 'border-surface-border bg-surface-light/60 hover:bg-surface-hover'
            }`}
          >
            <button
              type="button"
              className="flex flex-1 items-center gap-2 text-left"
              onClick={() => setActive(mode.id)}
            >
              <span
                className={`text-sm ${active.id === mode.id ? 'text-accent' : 'text-transparent'}`}
              >
                ✓
              </span>
              <span>
                <span className="block text-[13px] font-semibold text-ink">
                  {mode.id === GENERAL_MODE.id ? t('modes.general') : mode.name}
                </span>
                <span className="block text-[11px] text-ink-faint">
                  {mode.id === GENERAL_MODE.id
                    ? t('modes.noInstruction')
                    : mode.instruction.trim()
                      ? mode.instruction.slice(0, 90) + (mode.instruction.length > 90 ? '…' : '')
                      : t('modes.instructionEmpty')}
                </span>
              </span>
            </button>
            {mode.id !== GENERAL_MODE.id && (
              <div className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => setEditingId(editingId === mode.id ? null : mode.id)}
                >
                  {editingId === mode.id ? t('modes.done') : t('common.change')}
                </button>
                <button
                  type="button"
                  className="btn-secondary btn-sm text-red-400"
                  onClick={() => {
                    if (editingId === mode.id) setEditingId(null);
                    removeMode(mode.id);
                  }}
                >
                  {t('common.delete')}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {editing && (
        <div className="mt-3 rounded-xl border border-surface-border bg-surface-panel p-3.5">
          <label className="label">{t('modes.nameLabel')}</label>
          <input
            className="field mb-3"
            value={editing.name}
            onChange={(e) => updateMode(editing.id, { name: e.target.value })}
          />
          <label className="label">{t('modes.instructionLabel')}</label>
          <textarea
            className="field min-h-[96px] resize-y"
            placeholder={t('modes.instructionPlaceholder')}
            value={editing.instruction}
            onChange={(e) => updateMode(editing.id, { instruction: e.target.value })}
          />
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <input
          className="field flex-1"
          placeholder={t('modes.newPlaceholder')}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newName.trim()) {
              const m = addMode(newName);
              setNewName('');
              setEditingId(m.id);
            }
          }}
        />
        <button
          type="button"
          className="btn-primary btn-sm shrink-0"
          disabled={!newName.trim()}
          onClick={() => {
            const m = addMode(newName);
            setNewName('');
            setEditingId(m.id);
          }}
        >
          {t('modes.create')}
        </button>
      </div>
    </div>
  );
}
