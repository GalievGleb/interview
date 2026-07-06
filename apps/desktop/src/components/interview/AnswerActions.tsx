import CopyAnswerButton from './CopyAnswerButton';
import FeedbackButtons from './FeedbackButtons';
import type { AnswerRevisionMode } from '../../lib/answerRevision';

interface AnswerActionsProps {
  answer: string;
  /** Если передан вопрос — показываем 👍/👎 (оценка идёт в тюнинг качества). */
  question?: string;
  disabled?: boolean;
  revising?: boolean;
  onRevise?: (mode: AnswerRevisionMode) => void;
  onEdit?: () => void;
}

export default function AnswerActions({
  answer,
  question,
  disabled = false,
  revising = false,
  onRevise,
  onEdit,
}: AnswerActionsProps) {
  const blocked = disabled || revising || !answer.trim();

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
      {/* key: новый вопрос — свежая пара 👍/👎, иначе оценка залипает с прошлого ответа. */}
      {question && answer.trim() ? (
        <FeedbackButtons key={question} question={question} answer={answer} />
      ) : null}
      {onEdit ? (
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={blocked}
          onClick={onEdit}
          title="Отредактировать ответ вручную"
        >
          Изменить
        </button>
      ) : null}
      {onRevise ? (
        <>
          <button
            type="button"
            className="btn-secondary btn-sm"
            disabled={blocked}
            onClick={() => onRevise('shorter')}
            title="Сократить ответ для устного ответа"
          >
            Короче
          </button>
          <button
            type="button"
            className="btn-secondary btn-sm"
            disabled={blocked}
            onClick={() => onRevise('regenerate')}
            title="Сгенерировать ответ заново"
          >
            Заново
          </button>
        </>
      ) : null}
      <CopyAnswerButton text={answer} />
    </div>
  );
}
