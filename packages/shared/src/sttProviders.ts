/**
 * Speech-to-text provider + local-model descriptors for the UI.
 *
 * This is the front-end mirror of the Python provider layer
 * (`apps/api-py/app/services/stt/`). It exists so onboarding and the
 * Speech-Recognition settings screen can render model cards and privacy copy
 * without a backend round-trip, while live availability/diagnostics still come
 * from `GET /stt/providers`.
 *
 * Strategy encoded here:
 *  - Local Whisper is the default/primary engine.
 *  - Deepgram is optional "Legacy Cloud STT", never the default.
 *  - No Ollama provider exists in the live path.
 */

export type SttProviderId = 'whisper-local' | 'deepgram-cloud';
export type SttProviderMode = 'local' | 'cloud';
export type WhisperQuality = 'fast' | 'balanced' | 'quality' | 'max';

/** Privacy/resource copy — kept byte-for-byte in sync with the backend. */
export const STT_PRIVACY_LOCAL =
  'Audio is processed on your device and is not sent to our servers for transcription.';
export const STT_PRIVACY_CLOUD =
  'Audio may be sent to a third-party speech-to-text provider.';
export const STT_RESOURCE_USAGE_LOCAL =
  'Local transcription uses your CPU/GPU and may affect battery life, performance, and fan noise.';

export interface SttProviderDescriptor {
  id: SttProviderId;
  displayName: string;
  mode: SttProviderMode;
  /** Default experience the product ships with. */
  isDefault: boolean;
  privacyDescription: string;
  /** Rough nominal latency for ordering/expectation-setting, not a promise. */
  estimatedLatencyMs: number;
}

export const STT_PROVIDERS: SttProviderDescriptor[] = [
  {
    id: 'whisper-local',
    displayName: 'Local Whisper',
    mode: 'local',
    isDefault: true,
    privacyDescription: STT_PRIVACY_LOCAL,
    estimatedLatencyMs: 700,
  },
];

export interface WhisperModelCard {
  quality: WhisperQuality;
  /** faster-whisper size string / download resolver key. */
  modelId: string;
  label: string;
  recommended: boolean;
  description: string;
  /** Approximate download size in MB — shown with a "~", never as exact. */
  approxDownloadMb: number;
  recommendedRamGb: number;
  recommendedDevice: 'cpu' | 'gpu' | 'any';
  expectedSpeed: 'fastest' | 'balanced' | 'slower' | 'gpu-only';
}

export const WHISPER_MODEL_CARDS: WhisperModelCard[] = [
  {
    quality: 'fast',
    modelId: 'tiny',
    label: 'Fast',
    recommended: false,
    description:
      'For weak laptops or battery mode. Lowest resource usage, fastest startup, lower accuracy on technical terms. Best for quick testing or older machines.',
    approxDownloadMb: 75,
    recommendedRamGb: 2,
    recommendedDevice: 'cpu',
    expectedSpeed: 'fastest',
  },
  {
    quality: 'balanced',
    modelId: 'small',
    label: 'Balanced',
    recommended: true,
    description:
      'For most modern laptops. Good speed/accuracy balance, recommended default for live interviews. Good for QA/Python terms with glossary correction.',
    approxDownloadMb: 480,
    recommendedRamGb: 4,
    recommendedDevice: 'any',
    expectedSpeed: 'balanced',
  },
  {
    quality: 'quality',
    modelId: 'medium',
    label: 'Quality',
    recommended: false,
    description:
      'For powerful laptops/desktops. Better accuracy, higher CPU/GPU and memory usage. Better for noisy audio or difficult terminology.',
    approxDownloadMb: 1500,
    recommendedRamGb: 8,
    recommendedDevice: 'gpu',
    expectedSpeed: 'slower',
  },
  {
    quality: 'max',
    modelId: 'large-v3',
    label: 'Max accuracy',
    recommended: false,
    description:
      'Best accuracy on Russian and technical terms. Needs an NVIDIA GPU to stay fast (~1s per question on a modern GPU; very slow on CPU). Largest download. Recommended when a GPU is available.',
    approxDownloadMb: 3100,
    recommendedRamGb: 10,
    recommendedDevice: 'gpu',
    expectedSpeed: 'gpu-only',
  },
];

export const DEFAULT_WHISPER_QUALITY: WhisperQuality = 'balanced';

/**
 * "Auto choose for my device" — mirrors the backend heuristic. Prefers
 * Balanced when unsure, falls back to Fast on weak devices, only suggests
 * Quality with clear headroom.
 */
export function recommendWhisperQuality(opts: {
  totalRamGb: number | null;
  hasGpu: boolean;
}): WhisperQuality {
  const { totalRamGb, hasGpu } = opts;
  if (totalRamGb == null) return DEFAULT_WHISPER_QUALITY;
  if (totalRamGb < 4) return 'fast';
  if (hasGpu && totalRamGb >= 16) return 'quality';
  return 'balanced';
}

/** Shape returned by `GET /stt/providers` (for typing the fetch). */
export interface SttProviderDiagnostics {
  default: SttProviderId;
  localModel: string;
  device: string;
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
  models: Array<WhisperModelCard & { downloadRepo: string }>;
}
