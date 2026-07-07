/**
 * Локальные вехи активации: установка → первый разбор вакансии → первый
 * завершённый mock → первая live-сессия.
 *
 * Зачем: (1) знать, докуда дошёл пользователь — попадает в отчёт «Сообщить о
 * проблеме», помогает поддержке; (2) подложка для будущей opt-in аналитики,
 * когда/если появится сервер. Ничего никуда не уходит само — только локально.
 *
 * Каждая веха фиксируется ОДИН раз (первая метка не перезаписывается), поэтому
 * timestamp'ы отражают реальный момент прохождения воронки.
 */

const KEY = 'skillcue.activation.v1';

export type ActivationMilestone =
  | 'firstRun'
  | 'vacancyAnalyzed'
  | 'mockCompleted'
  | 'liveStarted';

export type ActivationRecord = Partial<Record<ActivationMilestone, number>>;

function read(): ActivationRecord {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as ActivationRecord) : {};
  } catch {
    return {};
  }
}

function write(rec: ActivationRecord): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(rec));
  } catch {
    /* storage unavailable — non-fatal */
  }
}

/** Отметить веху первым разом. Возвращает true, если это ПЕРВОЕ прохождение. */
export function markMilestone(id: ActivationMilestone, at: number = Date.now()): boolean {
  const rec = read();
  if (rec[id]) return false; // уже пройдено — не перезаписываем
  rec[id] = at;
  write(rec);
  return true;
}

export function getActivation(): ActivationRecord {
  return read();
}

/** Порядковый номер достигнутой ступени воронки (0..4) — для прогресс-индикатора. */
export function activationStage(rec: ActivationRecord = read()): number {
  const order: ActivationMilestone[] = [
    'firstRun',
    'vacancyAnalyzed',
    'mockCompleted',
    'liveStarted',
  ];
  let stage = 0;
  for (const m of order) {
    if (rec[m]) stage += 1;
    else break;
  }
  return stage;
}
