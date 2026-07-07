/**
 * Локальный журнал ошибок (кольцевой буфер в localStorage).
 *
 * Приватность прежде всего: журнал НИКУДА не уходит сам. Он лишь прикладывается
 * к отчёту, который пользователь ЯВНО собирает кнопкой «Сообщить о проблеме».
 * Так «у меня не работает» превращается в отчёт с реальным стеком краша, а не
 * гаданием. Тихой телеметрии нет — она потребовала бы сервера и отдельного
 * согласия; для локально-приватного продукта это осознанно не делаем.
 */

const LOG_KEY = 'skillcue.errorLog.v1';
const OPT_OUT_KEY = 'skillcue.errorLog.optOut';
const MAX_ENTRIES = 40;
const MAX_STACK_CHARS = 2000;

export interface ErrorLogEntry {
  ts: number;
  /** render | window | promise — источник. */
  source: 'render' | 'window' | 'promise';
  message: string;
  stack?: string;
  /** Хэш-маршрут в момент ошибки — где именно упало. */
  route?: string;
}

/** Журнал выключен пользователем (Настройки → Приватность). По умолчанию включён. */
export function isErrorLogEnabled(): boolean {
  try {
    return localStorage.getItem(OPT_OUT_KEY) !== '1';
  } catch {
    return true;
  }
}

export function setErrorLogEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(OPT_OUT_KEY, enabled ? '0' : '1');
    if (!enabled) localStorage.removeItem(LOG_KEY); // отключил — стираем накопленное
  } catch {
    /* storage unavailable — non-fatal */
  }
}

export function getErrorLog(): ErrorLogEntry[] {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as ErrorLogEntry[]) : [];
  } catch {
    return [];
  }
}

export function clearErrorLog(): void {
  try {
    localStorage.removeItem(LOG_KEY);
  } catch {
    /* non-fatal */
  }
}

/** Записать ошибку в буфер (best-effort, никогда не бросает). */
export function recordError(
  source: ErrorLogEntry['source'],
  message: string,
  stack?: string,
): void {
  if (!isErrorLogEnabled()) return;
  try {
    const entry: ErrorLogEntry = {
      ts: Date.now(),
      source,
      message: String(message).slice(0, 500),
      stack: stack ? String(stack).slice(0, MAX_STACK_CHARS) : undefined,
      route: typeof location !== 'undefined' ? location.hash || undefined : undefined,
    };
    const next = [entry, ...getErrorLog()].slice(0, MAX_ENTRIES);
    localStorage.setItem(LOG_KEY, JSON.stringify(next));
  } catch {
    /* storage full / unavailable — журнал не критичен */
  }
}

/**
 * Глобальные перехватчики: необработанные ошибки и reject'ы промисов.
 * Вызывается один раз при старте приложения.
 */
export function installGlobalErrorCapture(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('error', (e) => {
    recordError('window', e.message || 'Unknown error', e.error?.stack);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    const msg = reason instanceof Error ? reason.message : String(reason);
    recordError('promise', msg, reason instanceof Error ? reason.stack : undefined);
  });
}
