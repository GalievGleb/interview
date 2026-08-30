export const OPENAI_REALTIME_STT_MODEL = 'gpt-4o-mini-transcribe';
export const OPENAI_REALTIME_SAMPLE_RATE = 24_000;
export const REALTIME_RU_TECHNICAL_VOCABULARY =
  'тест-дизайн, тест-дизайна, классы эквивалентности, граничные значения, ' +
  'Python, pytest, Docker, REST API, HTTP, JSON, SQL, Playwright, CI/CD, Kafka, Kubernetes';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stripRealtimeTechnicalVocabularyEcho(text: string): string {
  let cleaned = String(text ?? '').trim();
  cleaned = cleaned.replace(
    new RegExp(escapeRegExp(REALTIME_RU_TECHNICAL_VOCABULARY), 'giu'),
    ' ',
  );
  cleaned = cleaned.replace(/\s+/gu, ' ').trim();
  cleaned = cleaned
    .replace(/^(?:[.,;:!?—-]+\s+)+/gu, '')
    .replace(/(?:\s+[.,;:!?—-]+)+$/gu, '')
    .trim();
  return /^[.,;:!?—-]+$/u.test(cleaned) ? '' : cleaned;
}

export function buildRealtimeSessionUpdate(language = 'ru') {
  const russian = language.toLocaleLowerCase().startsWith('ru');
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: OPENAI_REALTIME_SAMPLE_RATE },
          transcription: {
            model: OPENAI_REALTIME_STT_MODEL,
            ...(russian ? { prompt: REALTIME_RU_TECHNICAL_VOCABULARY } : {}),
            language: russian ? 'ru' : 'en',
          },
          turn_detection: null,
        },
      },
    },
  } as const;
}

export interface RealtimeCommitMetadata {
  clientTurnId: string;
  forceRequestId?: string;
}

/** Match asynchronous transcript completion events to explicit client commits. */
export class RealtimeCommitCorrelator {
  private readonly waiting: RealtimeCommitMetadata[] = [];
  private readonly byItem = new Map<string, RealtimeCommitMetadata>();
  private readonly byTurn = new Map<string, RealtimeCommitMetadata>();

  enqueue(metadata: RealtimeCommitMetadata): void {
    const stored = { ...metadata };
    this.waiting.push(stored);
    this.byTurn.set(stored.clientTurnId, stored);
  }

  assignItem(itemId: string): RealtimeCommitMetadata | undefined {
    const metadata = this.waiting.shift();
    if (!metadata || !itemId) return undefined;
    this.byItem.set(itemId, metadata);
    return { ...metadata };
  }

  bindForce(clientTurnId: string, forceRequestId: string): boolean {
    const metadata = this.byTurn.get(clientTurnId);
    if (!metadata || !forceRequestId) return false;
    metadata.forceRequestId = forceRequestId;
    return true;
  }

  metadataForItem(itemId: string): RealtimeCommitMetadata | undefined {
    const metadata = this.byItem.get(itemId);
    return metadata ? { ...metadata } : undefined;
  }

  complete(itemId: string): RealtimeCommitMetadata | undefined {
    const metadata = this.byItem.get(itemId);
    if (!metadata) return undefined;
    this.byItem.delete(itemId);
    this.byTurn.delete(metadata.clientTurnId);
    return { ...metadata };
  }
}

export function audioDurationSecondsFromPcmBytes(
  byteCount: number,
  sampleRate = OPENAI_REALTIME_SAMPLE_RATE,
): number {
  if (!Number.isFinite(byteCount) || byteCount <= 0 || sampleRate <= 0) return 0;
  return byteCount / (sampleRate * 2);
}
