/**
 * Мост «подготовка → live»: слабые темы из последнего mock-отчёта.
 * Live-промпт получает их, чтобы ответы на эти темы были особенно конкретными
 * (кандидату труднее импровизировать там, где mock показал пробел).
 */
import { latestCompleted } from './vacancyReviewStore';
import { loadSessionWeakTopics } from '../sessionKnowledge';

export function getWeakTopicTitles(limit = 5): string[] {
  const report = latestCompleted()?.report;
  const rank = { critical: 0, weak: 1 } as const;
  const mockTopics = report
    ? report.topicScores
        .filter((t): t is typeof t & { status: keyof typeof rank } => t.status in rank)
        .sort((a, b) => {
          const byStatus = rank[a.status as keyof typeof rank] - rank[b.status as keyof typeof rank];
          return byStatus !== 0 ? byStatus : a.score - b.score;
        })
        .map((topic) => topic.title)
    : [];
  const sessionTopics = loadSessionWeakTopics()
    .sort((left, right) => left.score - right.score)
    .map((topic) => topic.topic);
  const seen = new Set<string>();
  return [...mockTopics, ...sessionTopics].filter((topic) => {
    const key = topic.normalize('NFKC').trim().toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}
