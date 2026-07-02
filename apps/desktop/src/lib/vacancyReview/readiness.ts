import type { ReadinessLabel, TopicStatus } from './types';

export function topicStatusFromScore(score: number): TopicStatus {
  if (score >= 75) return 'strong';
  if (score >= 55) return 'medium';
  if (score >= 35) return 'weak';
  return 'critical';
}

export function readinessLabelFromScore(score: number): ReadinessLabel {
  if (score >= 85) return 'strong';
  if (score >= 70) return 'ready';
  if (score >= 50) return 'almost_ready';
  if (score >= 30) return 'weak';
  return 'not_ready';
}

const LABEL_TEXT: Record<ReadinessLabel, string> = {
  not_ready: 'Не готовы',
  weak: 'Слабо',
  almost_ready: 'Почти готовы',
  ready: 'Готовы',
  strong: 'Уверенно',
};

export function readinessLabelText(label: ReadinessLabel): string {
  return LABEL_TEXT[label];
}

const STATUS_TEXT: Record<TopicStatus, string> = {
  strong: 'Сильно',
  medium: 'Средне',
  weak: 'Слабо',
  critical: 'Критично',
};

export function topicStatusText(status: TopicStatus): string {
  return STATUS_TEXT[status];
}

/** Tone token for the Preparation palette (--prep-green/blue/amber/red). */
export function topicStatusTone(status: TopicStatus): 'green' | 'blue' | 'amber' | 'red' {
  switch (status) {
    case 'strong':
      return 'green';
    case 'medium':
      return 'blue';
    case 'weak':
      return 'amber';
    case 'critical':
      return 'red';
  }
}

export function readinessTone(label: ReadinessLabel): 'green' | 'blue' | 'amber' | 'red' {
  if (label === 'strong' || label === 'ready') return 'green';
  if (label === 'almost_ready') return 'blue';
  if (label === 'weak') return 'amber';
  return 'red';
}
