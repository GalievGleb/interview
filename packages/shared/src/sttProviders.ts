export type SttProviderId = 'openai-mini';
export type SttProviderMode = 'cloud';

export interface SttProviderDiagnostics {
  default: SttProviderId;
  engine: 'openai-mini';
  model: 'gpt-4o-mini-transcribe';
  providers: Array<{
    id: SttProviderId;
    displayName: string;
    mode: SttProviderMode;
    available: boolean;
    reason: string;
    model: string | null;
    device: string | null;
    estimatedLatencyMs: number | null;
    privacyDescription: string;
    resourceUsage: string;
    lastError: string | null;
  }>;
}
