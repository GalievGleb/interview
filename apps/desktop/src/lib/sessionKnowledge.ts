import { api } from './api';

export const SESSION_KNOWLEDGE_STORAGE_KEY = 'skillcue:session-knowledge:v1';
export const SESSION_KNOWLEDGE_EPOCH_KEY = 'skillcue:session-knowledge-epoch:v1';
let knowledgeWriteGeneration = 0;
let knowledgeEpochSequence = 0;

function claimKnowledgeWriteEpoch(): string {
  const epoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${++knowledgeEpochSequence}`;
  localStorage.setItem(SESSION_KNOWLEDGE_EPOCH_KEY, epoch);
  return epoch;
}

export interface RawSessionKnowledgeTopic {
  topic: string;
  score: number;
  confidence: number;
}

export interface SessionKnowledgeTopic extends RawSessionKnowledgeTopic {
  evidenceCount: number;
}

export interface SessionKnowledge {
  weakTopics: SessionKnowledgeTopic[];
  strongTopics: SessionKnowledgeTopic[];
  updatedAt: string;
}

function topicKey(topic: string): string {
  return topic.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function isTopic(value: unknown): value is SessionKnowledgeTopic {
  if (!value || typeof value !== 'object') return false;
  const topic = value as Partial<SessionKnowledgeTopic>;
  return (
    typeof topic.topic === 'string' &&
    Boolean(topic.topic.trim()) &&
    typeof topic.score === 'number' &&
    Number.isFinite(topic.score) &&
    topic.score >= 0 &&
    topic.score <= 100 &&
    typeof topic.confidence === 'number' &&
    Number.isFinite(topic.confidence) &&
    topic.confidence >= 0 &&
    topic.confidence <= 1 &&
    typeof topic.evidenceCount === 'number' &&
    Number.isInteger(topic.evidenceCount) &&
    topic.evidenceCount > 0
  );
}

export function mergeKnowledgeTopics(
  topics: RawSessionKnowledgeTopic[],
): SessionKnowledgeTopic[] {
  const groups = new Map<
    string,
    { topic: string; weightedScore: number; totalWeight: number; confidence: number; count: number }
  >();
  for (const item of topics) {
    const display = item.topic.replace(/\s+/g, ' ').trim();
    const key = topicKey(display);
    if (!key || !Number.isFinite(item.score) || !Number.isFinite(item.confidence)) continue;
    const confidence = Math.min(1, Math.max(0, item.confidence));
    const weight = confidence || 0.01;
    const current = groups.get(key) ?? {
      topic: display,
      weightedScore: 0,
      totalWeight: 0,
      confidence: 0,
      count: 0,
    };
    current.weightedScore += Math.min(100, Math.max(0, item.score)) * weight;
    current.totalWeight += weight;
    current.confidence += confidence;
    current.count += 1;
    groups.set(key, current);
  }
  return [...groups.values()]
    .map((group) => ({
      topic: group.topic,
      score: Math.round(group.weightedScore / group.totalWeight),
      confidence: Number((group.confidence / group.count).toFixed(2)),
      evidenceCount: group.count,
    }))
    .sort((left, right) => left.score - right.score || left.topic.localeCompare(right.topic));
}

export function saveSessionKnowledge(knowledge: SessionKnowledge): void {
  knowledgeWriteGeneration += 1;
  claimKnowledgeWriteEpoch();
  localStorage.setItem(SESSION_KNOWLEDGE_STORAGE_KEY, JSON.stringify(knowledge));
}

export function clearSessionKnowledge(): void {
  knowledgeWriteGeneration += 1;
  claimKnowledgeWriteEpoch();
  localStorage.removeItem(SESSION_KNOWLEDGE_STORAGE_KEY);
}

export function loadSessionWeakTopics(): SessionKnowledgeTopic[] {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_KNOWLEDGE_STORAGE_KEY) ?? '{}');
    return Array.isArray(value.weakTopics) ? value.weakTopics.filter(isTopic) : [];
  } catch {
    return [];
  }
}

export async function refreshSessionKnowledge(): Promise<void> {
  const generation = ++knowledgeWriteGeneration;
  const epoch = claimKnowledgeWriteEpoch();
  const knowledge = await api.getKnowledgeMap();
  if (
    generation !== knowledgeWriteGeneration ||
    localStorage.getItem(SESSION_KNOWLEDGE_EPOCH_KEY) !== epoch
  ) return;
  localStorage.setItem(SESSION_KNOWLEDGE_STORAGE_KEY, JSON.stringify(knowledge));
}
