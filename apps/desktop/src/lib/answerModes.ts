import { useSyncExternalStore } from 'react';

/**
 * Режимы ответа (как Modes в Cluely): именованные пресеты с инструкцией,
 * которая подмешивается к запросам из оверлея. «Общий» — встроенный,
 * без инструкции, его нельзя удалить. Хранение — localStorage, поэтому
 * оверлей и настройки (разные окна) синхронизируются через storage-событие.
 */

export interface AnswerMode {
  id: string;
  name: string;
  /** Инструкция для модели: стиль, роль, стек, язык ответов и т.п. */
  instruction: string;
}

const MODES_KEY = 'skillcue.answerModes';
const ACTIVE_KEY = 'skillcue.answerMode';

export const GENERAL_MODE: AnswerMode = {
  id: 'general',
  name: 'Общий',
  instruction: '',
};

const DEFAULT_CUSTOM: AnswerMode[] = [
  {
    id: 'interview',
    name: 'Собеседование',
    instruction:
      'Я на техническом собеседовании. Отвечай от первого лица, разговорным языком, ' +
      '40–80 слов, без markdown-заголовков — так, чтобы я мог произнести ответ вслух.',
  },
];

interface Snapshot {
  modes: AnswerMode[];
  activeId: string;
}

let snapshot: Snapshot = load();
const listeners = new Set<() => void>();

function load(): Snapshot {
  let custom: AnswerMode[] = DEFAULT_CUSTOM;
  try {
    const raw = localStorage.getItem(MODES_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        custom = parsed.filter(
          (m): m is AnswerMode =>
            !!m &&
            typeof m === 'object' &&
            typeof (m as AnswerMode).id === 'string' &&
            typeof (m as AnswerMode).name === 'string' &&
            typeof (m as AnswerMode).instruction === 'string',
        );
      }
    }
  } catch {
    custom = DEFAULT_CUSTOM;
  }
  const modes = [GENERAL_MODE, ...custom.filter((m) => m.id !== GENERAL_MODE.id)];
  const savedActive = localStorage.getItem(ACTIVE_KEY) ?? GENERAL_MODE.id;
  const activeId = modes.some((m) => m.id === savedActive) ? savedActive : GENERAL_MODE.id;
  return { modes, activeId };
}

function persist(): void {
  const custom = snapshot.modes.filter((m) => m.id !== GENERAL_MODE.id);
  localStorage.setItem(MODES_KEY, JSON.stringify(custom));
  localStorage.setItem(ACTIVE_KEY, snapshot.activeId);
  listeners.forEach((l) => l());
}

// Другое окно (оверлей ↔ настройки) поменяло режимы — перечитываем.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === MODES_KEY || e.key === ACTIVE_KEY) {
      snapshot = load();
      listeners.forEach((l) => l());
    }
  });
}

export function getModes(): AnswerMode[] {
  return snapshot.modes;
}

export function getActiveMode(): AnswerMode {
  return snapshot.modes.find((m) => m.id === snapshot.activeId) ?? GENERAL_MODE;
}

export function setActiveMode(id: string): void {
  if (!snapshot.modes.some((m) => m.id === id)) return;
  snapshot = { ...snapshot, activeId: id };
  persist();
}

export function addMode(name: string): AnswerMode {
  const mode: AnswerMode = {
    id: `mode-${Date.now().toString(36)}`,
    name: name.trim() || 'Новый режим',
    instruction: '',
  };
  snapshot = { ...snapshot, modes: [...snapshot.modes, mode], activeId: mode.id };
  persist();
  return mode;
}

export function updateMode(id: string, patch: Partial<Pick<AnswerMode, 'name' | 'instruction'>>): void {
  if (id === GENERAL_MODE.id) return; // встроенный не редактируется
  snapshot = {
    ...snapshot,
    modes: snapshot.modes.map((m) => (m.id === id ? { ...m, ...patch } : m)),
  };
  persist();
}

export function removeMode(id: string): void {
  if (id === GENERAL_MODE.id) return;
  snapshot = {
    ...snapshot,
    modes: snapshot.modes.filter((m) => m.id !== id),
    activeId: snapshot.activeId === id ? GENERAL_MODE.id : snapshot.activeId,
  };
  persist();
}

/** Префикс к запросу оверлея; пустая строка для «Общего». */
export function modeInstructionPrefix(): string {
  const mode = getActiveMode();
  if (!mode.instruction.trim()) return '';
  return `Инструкция режима «${mode.name}»: ${mode.instruction.trim()}\n\n`;
}

export function useAnswerModes(): {
  modes: AnswerMode[];
  active: AnswerMode;
  setActive: (id: string) => void;
} {
  const snap = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot,
  );
  return {
    modes: snap.modes,
    active: snap.modes.find((m) => m.id === snap.activeId) ?? GENERAL_MODE,
    setActive: setActiveMode,
  };
}
