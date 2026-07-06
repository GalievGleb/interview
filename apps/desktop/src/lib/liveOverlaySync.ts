/**
 * Что показывать в панели ответа оверлея во время live-сессии.
 *
 * Тонкость: на старте нового ответа streamText сбрасывается в '' раньше, чем
 * придёт первый токен, а lastEntry ещё держит ПРЕДЫДУЩИЙ ответ. Наивное
 * `streamText || lastEntry.spoken` показало бы старый ответ в паре с новым
 * вопросом (с мигающим курсором, будто он стримится) — пользователь на живом
 * собеседовании может зачитать ответ не на тот вопрос. Поэтому пока идёт
 * генерация (streaming) без единого токена — показываем пустой текст (лоадер),
 * а не залежавшийся прошлый ответ.
 */
export interface LiveExchangeView {
  /** Обновлять ли панель (false — оставить как есть, нечего показывать). */
  show: boolean;
  /** Текст ответа: стрим, прошлый ответ (в простое) или '' (лоадер при генерации). */
  text: string;
}

export function deriveLiveExchange(
  streamText: string,
  streaming: boolean,
  lastSpoken: string | undefined,
): LiveExchangeView {
  const text = streamText || (streaming ? '' : lastSpoken ?? '');
  // Показываем, если есть что показать ИЛИ идёт генерация (нужен лоадер).
  return { show: Boolean(text) || streaming, text };
}
