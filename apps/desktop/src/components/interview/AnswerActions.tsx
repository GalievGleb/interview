import CopyAnswerButton from './CopyAnswerButton';
import type { AnswerRevisionMode } from '../../lib/answerRevision';

interface AnswerActionsProps {
  answer: string;
  disabled?: boolean;
  revising?: boolean;
  onRevise?: (mode: AnswerRevisionMode) => void;
}

export default function AnswerActions({
  answer,
  disabled = false,
  revising = false,
  onRevise,
}: AnswerActionsProps) {
  const blocked = disabled || revising || !answer.trim();

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
      {onRevise ? (
        <>
          <button
            type="button"
            className="btn-secondary btn-sm"
            disabled={blocked}
            onClick={() => onRevise('shorter')}
            title="Сократить ответ для устного ответа"
          >
            Shorter
          </button>
          <button
            type="button"
            className="btn-secondary btn-sm"
            disabled={blocked}
            onClick={() => onRevise('regenerate')}
            title="Сгенерировать ответ заново"
          >
            Regenerate
          </button>
        </>
      ) : null}
      <CopyAnswerButton text={answer} />
    </div>
  );
}
