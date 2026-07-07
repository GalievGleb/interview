import type { ReadinessLabel, TopicStatus } from './types';
import { t, type I18nKey } from '../i18n';

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

const LABEL_KEY: Record<ReadinessLabel, I18nKey> = {
  not_ready: 'readiness.label.not_ready',
  weak: 'readiness.label.weak',
  almost_ready: 'readiness.label.almost_ready',
  ready: 'readiness.label.ready',
  strong: 'readiness.label.strong',
};

export function readinessLabelText(label: ReadinessLabel): string {
  return t(LABEL_KEY[label]);
}

const STATUS_KEY: Record<TopicStatus, I18nKey> = {
  strong: 'readiness.status.strong',
  medium: 'readiness.status.medium',
  weak: 'readiness.status.weak',
  critical: 'readiness.status.critical',
};

export function topicStatusText(status: TopicStatus): string {
  return t(STATUS_KEY[status]);
}

/** Tone token for the Preparation palette (--prep-green/blue/amber/red). */
export function topicStatusTone(status: TopicStatus): 'green' | 'blue' | 'amber' | 'red' {
  switch (status) {
    case 'strong':
      return 'green';
    case 'medium':
      return 'amber';
    case 'weak':
      return 'amber';
    case 'critical':
      return 'red';
  }
}

export function readinessTone(label: ReadinessLabel): 'green' | 'blue' | 'amber' | 'red' {
  if (label === 'strong' || label === 'ready') return 'green';
  if (label === 'almost_ready') return 'amber';
  if (label === 'weak') return 'amber';
  return 'red';
}
