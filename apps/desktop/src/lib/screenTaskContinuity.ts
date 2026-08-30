export interface PreviousScreenTask {
  question: string;
  answer: string;
}

export interface ScreenCaptureCueLine {
  text: string;
  sequence: number;
  source?: string;
}

const SPOKEN_SCREEN_CAPTURE_CUE =
  /(?:^|[.!?]\s*)(?:сейчас\s+)?покаж(?:у|ем)\s+(?:(?:сво[её]|текущее|готовое)\s+)?решени[ея](?=$|[\s.!?,])/iu;

const SCREEN_TASK_FOLLOW_UP =
  /(?:(?:не\s+удаляй|оставь|сохрани)[^.!?\n]{0,100}(?:код|решени|проверк|услови|фильтр)|(?:улучш|доработ|измени|поменя|исправ|добав|перепиш|рефактор)[а-яё]*[^.!?\n]{0,100}(?:эт[оауи]|предыдущ|текущ|код|решени|задани|задач|запрос)|(?:это|этот|эту|предыдущее|текущее)\s+(?:решени|код|задани|задач)[а-яё]*[^.!?\n]{0,80}(?:улучш|доработ|измени|поменя|исправ|добав|перепиш|рефактор)[а-яё]*|(?:теперь|а\s+теперь)[^.!?\n]{0,100}(?:измени|поменя|добав|убер|остав|сохрани|улучш|доработ)|(?:как\s+(?:можно\s+)?(?:улучшить|доработать|изменить))[^.!?\n]{0,80}(?:это|решени|задани|задач|код)|(?:keep|do\s+not\s+delete|improve|change|modify|refactor|extend)[^.!?\n]{0,100}(?:this|previous|current|code|solution|task))/iu;

const MAX_PREVIOUS_QUESTION_CHARS = 700;
const MAX_PREVIOUS_ANSWER_CHARS = 2800;

function clipTail(text: string, limit: number): string {
  const normalized = text.trim();
  if (normalized.length <= limit) return normalized;
  return `…${normalized.slice(-limit)}`;
}

export function isSpokenScreenCaptureCue(text: string): boolean {
  return SPOKEN_SCREEN_CAPTURE_CUE.test(text.trim());
}

export function findLatestUnconsumedScreenCaptureCue<T extends ScreenCaptureCueLine>(
  lines: T[],
  consumedSequence: number,
): T | null {
  return (
    lines
      .filter(
        (line) =>
          line.sequence > consumedSequence && isSpokenScreenCaptureCue(line.text),
      )
      .at(-1) ?? null
  );
}

export function screenCaptureRequestFromCue(_text: string): string {
  return (
    'Реши текущее задание на экране. Если это продолжение предыдущего задания, ' +
    'сохрани неизменённые части и внеси только запрошенное изменение.'
  );
}

export function isScreenTaskFollowUp(text: string): boolean {
  return SCREEN_TASK_FOLLOW_UP.test(text.trim());
}

export function buildScreenTaskContinuityContext(
  currentRequest: string,
  previous: PreviousScreenTask | null,
): string {
  if (!previous || !isScreenTaskFollowUp(currentRequest)) return '';
  const question = clipTail(previous.question, MAX_PREVIOUS_QUESTION_CHARS);
  const answer = clipTail(previous.answer, MAX_PREVIOUS_ANSWER_CHARS);
  if (!question && !answer) return '';
  return [
    'ПРЕДЫДУЩЕЕ ЗАДАНИЕ С ЭКРАНА (используй только если текущая просьба его продолжает):',
    question || '(нет текста)',
    'ПРЕДЫДУЩИЙ ОТВЕТ SKILLCUE:',
    answer || '(нет ответа)',
    'Текущий скриншот важнее этого контекста. Верни полное обновлённое решение, не diff.',
  ].join('\n');
}
