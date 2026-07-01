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

/** Privacy/resource copy — kept in sync with the backend (see app/services/stt/base.py). */
export const STT_PRIVACY_LOCAL =
  'Аудио обрабатывается на вашем устройстве и не отправляется на наши серверы для распознавания.';
export const STT_PRIVACY_CLOUD =
  'Аудио может отправляться стороннему провайдеру распознавания речи.';
export const STT_RESOURCE_USAGE_LOCAL =
  'Локальное распознавание использует CPU/GPU и может влиять на батарею, производительность и шум вентилятора.';

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
    label: 'Быстрая',
    recommended: false,
    description:
      'Для слабых ноутбуков или режима экономии батареи. Минимальное потребление ресурсов и самый быстрый старт, точность на технических терминах ниже. Хорошо подходит для быстрого тестирования или старых устройств.',
    approxDownloadMb: 75,
    recommendedRamGb: 2,
    recommendedDevice: 'cpu',
    expectedSpeed: 'fastest',
  },
  {
    quality: 'balanced',
    modelId: 'small',
    label: 'Сбалансированная',
    recommended: true,
    description:
      'Для большинства современных ноутбуков. Хороший баланс скорости и точности, рекомендуется по умолчанию для live-интервью. Хорошо справляется с QA/Python-терминами вместе с коррекцией по глоссарию.',
    approxDownloadMb: 480,
    recommendedRamGb: 4,
    recommendedDevice: 'any',
    expectedSpeed: 'balanced',
  },
  {
    quality: 'quality',
    modelId: 'medium',
    label: 'Качественная',
    recommended: false,
    description:
      'Для мощных ноутбуков/десктопов. Точность выше, но больше нагрузка на CPU/GPU и память. Лучше подходит для шумного звука или сложной терминологии.',
    approxDownloadMb: 1500,
    recommendedRamGb: 8,
    recommendedDevice: 'gpu',
    expectedSpeed: 'slower',
  },
  {
    quality: 'max',
    modelId: 'large-v3',
    label: 'Максимальная точность',
    recommended: false,
    description:
      'Максимальная точность на русском языке и технических терминах. Для скорости нужна видеокарта NVIDIA (~1с на вопрос на современной GPU; очень медленно на CPU). Самая большая загрузка. Рекомендуется при наличии GPU.',
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
