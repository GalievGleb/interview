import {
  RealtimeCommitCorrelator,
  stripRealtimeTechnicalVocabularyEcho,
} from './gateway-stt-realtime.protocol';

type JsonRecord = Record<string, unknown>;

function requiredString(event: JsonRecord, field: string): string {
  const value = event[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Realtime STT event is missing ${field}`);
  }
  return value;
}

/**
 * Pure protocol adapter between the trusted desktop client and OpenAI Realtime.
 * Keeping this class free of sockets makes correlation and validation deterministic.
 */
export class RealtimeSttBridge {
  private readonly correlator = new RealtimeCommitCorrelator();
  private pcmByteCount = 0;

  constructor(readonly language = 'ru') {}

  get receivedPcmBytes(): number {
    return this.pcmByteCount;
  }

  acceptAudio(pcm: Buffer): JsonRecord {
    if (!Buffer.isBuffer(pcm) || pcm.length === 0) {
      throw new Error('Realtime STT audio frame must contain PCM data');
    }
    this.pcmByteCount += pcm.length;
    return {
      type: 'input_audio_buffer.append',
      audio: pcm.toString('base64'),
    };
  }

  acceptControl(event: JsonRecord): JsonRecord | undefined {
    if (event.type === 'commit') {
      this.correlator.enqueue({
        clientTurnId: requiredString(event, 'client_turn_id'),
      });
      return { type: 'input_audio_buffer.commit' };
    }

    if (event.type === 'bind_force') {
      const clientTurnId = requiredString(event, 'client_turn_id');
      const forceRequestId = requiredString(event, 'force_request_id');
      // Completion and Ctrl+Enter may cross on the wire. A late bind is a
      // harmless no-op; the local bridge still owns the force request id.
      this.correlator.bindForce(clientTurnId, forceRequestId);
      return undefined;
    }

    throw new Error(`Unsupported realtime STT control: ${String(event.type)}`);
  }

  acceptUpstream(event: JsonRecord): JsonRecord | undefined {
    const type = event.type;
    const itemId = typeof event.item_id === 'string' ? event.item_id : '';

    if (type === 'input_audio_buffer.committed') {
      const metadata = this.correlator.assignItem(requiredString(event, 'item_id'));
      if (!metadata) return undefined;
      return {
        type: 'turn_committed',
        item_id: itemId,
        client_turn_id: metadata.clientTurnId,
        ...(metadata.forceRequestId
          ? { force_request_id: metadata.forceRequestId }
          : {}),
      };
    }

    if (type === 'conversation.item.input_audio_transcription.delta') {
      const metadata = this.correlator.metadataForItem(itemId);
      if (!metadata || typeof event.delta !== 'string') return undefined;
      return {
        type: 'transcript_delta',
        item_id: itemId,
        client_turn_id: metadata.clientTurnId,
        ...(metadata.forceRequestId
          ? { force_request_id: metadata.forceRequestId }
          : {}),
        delta: event.delta,
      };
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      const metadata = this.correlator.complete(itemId);
      if (!metadata || typeof event.transcript !== 'string') return undefined;
      return {
        type: 'transcript_completed',
        item_id: itemId,
        client_turn_id: metadata.clientTurnId,
        ...(metadata.forceRequestId
          ? { force_request_id: metadata.forceRequestId }
          : {}),
        transcript: stripRealtimeTechnicalVocabularyEcho(event.transcript),
      };
    }

    if (type === 'error') {
      return {
        type: 'error',
        message: 'Realtime transcription is temporarily unavailable',
      };
    }

    return undefined;
  }
}
