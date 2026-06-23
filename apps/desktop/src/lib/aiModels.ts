export type ChatMode = 'general' | 'coding' | 'fast' | 'deep';

export interface ModelPricing {
  prompt: string;
  completion: string;
}

export interface ModelCapabilities {
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
}

export interface NormalizedModel {
  id: string;
  name: string;
  provider: string;
  description: string;
  context_length: number;
  pricing: ModelPricing;
  capabilities: ModelCapabilities;
  tags: string[];
}

export interface AiSettings {
  provider: string;
  base_url: string;
  default_copilot_model: string;
  coding_assistant_model: string;
  fast_live_model: string;
  deep_reasoning_model: string;
  last_models_sync_at: string | null;
  models_cache_count: number;
  has_openrouter_key: boolean;
}

export const AUTO_VALUE = 'auto';

export const TAG_LABELS: Record<string, string> = {
  fast: 'Fast',
  coding: 'Coding',
  reasoning: 'Reasoning',
  cheap: 'Cheap',
  premium: 'Premium',
  free: 'Free',
  vision: 'Vision',
};

export function filterModels(models: NormalizedModel[], query: string): NormalizedModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter(
    (m) =>
      m.name.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q) ||
      m.provider.toLowerCase().includes(q),
  );
}

export function isModelMissing(modelId: string, models: NormalizedModel[]): boolean {
  if (modelId === AUTO_VALUE) return false;
  return !models.some((m) => m.id === modelId);
}

export function groupModelsForSelect(models: NormalizedModel[]): NormalizedModel[] {
  const recommended = new Set([
    'openai/gpt-4o-mini',
    'openai/gpt-4o',
    'anthropic/claude-3.5-sonnet',
    'google/gemini-2.0-flash-001',
    'deepseek/deepseek-chat',
  ]);
  const rec = models.filter((m) => recommended.has(m.id));
  const free = models.filter((m) => m.tags.includes('free') && !recommended.has(m.id));
  const fast = models.filter(
    (m) => m.tags.includes('fast') && !recommended.has(m.id) && !m.tags.includes('free'),
  );
  const coding = models.filter(
    (m) => m.tags.includes('coding') && !recommended.has(m.id) && !m.tags.includes('fast'),
  );
  const rest = models.filter(
    (m) =>
      !recommended.has(m.id) &&
      !m.tags.includes('free') &&
      !m.tags.includes('fast') &&
      !m.tags.includes('coding'),
  );
  const seen = new Set<string>();
  const merged = [...rec, ...free, ...fast, ...coding, ...rest];
  return merged.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}
