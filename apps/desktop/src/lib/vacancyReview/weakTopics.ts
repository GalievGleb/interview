/**
 * Мост «подготовка → live»: слабые темы из последнего mock-отчёта.
 * Live-промпт получает их, чтобы ответы на эти темы были особенно конкретными
 * (кандидату труднее импровизировать там, где mock показал пробел).
 */
import { latestCompleted } from './vacancyReviewStore';

export function getWeakTopicTitles(limit = 5): string[] {
  const report = latestCompleted()?.report;
  if (!report) return [];
  const rank = { critical: 0, weak: 1 } as const;
  return report.topicScores
    .filter((t): t is typeof t & { status: keyof typeof rank } => t.status in rank)
    .sort((a, b) => {
      const byStatus = rank[a.status as keyof typeof rank] - rank[b.status as keyof typeof rank];
      return byStatus !== 0 ? byStatus : a.score - b.score; // худшие — первыми
    })
    .slice(0, limit)
    .map((t) => t.title);
}
