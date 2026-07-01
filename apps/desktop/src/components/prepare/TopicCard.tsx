import { topicStatusText, topicStatusTone } from '../../lib/vacancyReview/readiness';
import type { TopicScore } from '../../lib/vacancyReview/types';

interface Props {
  topic: TopicScore;
  onPractice?: (topicId: string) => void;
}

/** One card in the Interview Readiness Map — a vacancy-derived topic, not a generic skill. */
export default function TopicCard({ topic, onPractice }: Props) {
  const tone = topicStatusTone(topic.status);
  return (
    <div className={`prep-card prep-topic prep-topic-${tone} p-4`}>
      <div className="flex items-start justify-between gap-3 pl-2">
        <div className="min-w-0">
          <p className="prep-faint">{topic.category}</p>
          <p className="prep-h2 truncate">{topic.title}</p>
        </div>
        <span className={`prep-chip prep-tone-${tone} shrink-0`}>{topicStatusText(topic.status)}</span>
      </div>

      <div className="mt-3 flex items-center gap-3 pl-2">
        <span className="text-[22px] font-bold" style={{ color: 'var(--prep-ink)' }}>
          {topic.score}%
        </span>
        <div className={`prep-bar prep-bar-${tone} flex-1`}>
          <span style={{ width: `${topic.score}%` }} />
        </div>
        <span className="prep-faint shrink-0">{topic.questionsAsked} вопр.</span>
      </div>

      <p className="prep-sub mt-3 pl-2">{topic.feedback}</p>

      {topic.missingPoints.length > 0 && (
        <p className="mt-2 pl-2 text-[12.5px]" style={{ color: 'var(--prep-ink-muted)' }}>
          <span className="font-semibold">Не хватает: </span>
          {topic.missingPoints.join(', ')}
        </p>
      )}

      <div className="mt-3 flex items-center justify-between gap-2 pl-2">
        <p className="text-[12.5px]" style={{ color: 'var(--prep-ink-faint)' }}>
          {topic.nextAction}
        </p>
        {onPractice && (
          <button
            type="button"
            className="prep-btn-ghost prep-btn-sm shrink-0"
            onClick={() => onPractice(topic.topicId)}
          >
            Потренировать тему
          </button>
        )}
      </div>
    </div>
  );
}
