export type ReadinessFailureCode = 'provider_unavailable';

export function readinessFailureCopy(code: unknown): { title: string; body: string } | null {
  if (code !== 'provider_unavailable') return null;
  return {
    title: 'SkillCue требует внимания до созвона',
    body: 'Онлайн-ИИ сейчас не отвечает. Откройте SkillCue заранее и проверьте тариф или подключение.',
  };
}
