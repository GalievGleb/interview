/**
 * Yandex SpeechKit v3 (gRPC RecognizeStreaming) — держим ключ Яндекса только
 * здесь, на сервере. Десктоп никогда его не видит: он получает бесплатный
 * триал/лицензию через /gateway/trial (см. gateway.service.ts) и подключается
 * сюда по WebSocket, мы проксируем аудио в Yandex и шлём события обратно.
 *
 * Протокол клиента ТОТ ЖЕ, что у локального /stt/stream в apps/api-py:
 *   {"type":"ready", ...} / {"type":"speech_started"}
 *   {"type":"transcript","text","is_final","speech_final"}
 *   {"type":"utterance_end","timings"} / {"type":"error","message"}
 * Поэтому Python-мост на десктопе — почти прозрачный релей без трансляции.
 *
 * Портировано из apps/api-py/app/services/stt/speechkit_stream.py (тот же
 * порядок событий v3: partial* -> final -> final_refinement -> eou_update;
 * финал шлём клиенту на eou_update, текст берём из refinement).
 */
import { Injectable, Logger } from '@nestjs/common';
import { credentials, Metadata, ClientDuplexStream } from '@grpc/grpc-js';
import { sttService as sttServiceRuntime } from '@yandex-cloud/nodejs-sdk/ai-stt-v3';
import { YANDEX_STT_ENDPOINT, alternativesText, buildSessionOptions } from './yandex-stt.util';
import type { StreamingRequest, StreamingResponse } from './yandex-stt-types';

export type SttResponseMessage =
  | { type: 'ready'; engine: string; model: string; sample_rate: number }
  | { type: 'speech_started' }
  | { type: 'transcript'; text: string; is_final: boolean; speech_final: boolean }
  | { type: 'utterance_end'; timings: Record<string, number | null> }
  | { type: 'error'; message: string };

export interface SpeechKitProxyHandle {
  sendAudio: (data: Buffer) => void;
  /** Закрывает поток к Yandex и возвращает секунды аудио для учёта квоты. */
  close: () => number;
}

const MODEL_NAME = 'speechkit-v3-general';

@Injectable()
export class GatewaySttService {
  private readonly logger = new Logger('GatewaySttYandex');

  createSpeechKitProxy(
    apiKey: string,
    language: string,
    sampleRate: number,
    onMessage: (msg: SttResponseMessage) => void,
  ): SpeechKitProxyHandle {
    const client = new sttServiceRuntime.RecognizerClient(
      YANDEX_STT_ENDPOINT,
      credentials.createSsl(),
    );
    const metadata = new Metadata();
    metadata.set('authorization', `Api-Key ${apiKey}`);

    const call: ClientDuplexStream<StreamingRequest, StreamingResponse> =
      client.recognizeStreaming(metadata);

    let closed = false;
    let speechStartedSent = false;
    let speechStartedAt = 0;
    let firstPartialAt = 0;
    let partialCount = 0;
    let pendingFinalText = '';
    let audioSeconds = 0;
    // 16-bit mono PCM: 2 bytes/sample.
    const bytesPerSecond = sampleRate * 2;

    const emitSpeechStarted = () => {
      if (speechStartedSent) return;
      speechStartedSent = true;
      speechStartedAt = Date.now();
      firstPartialAt = 0;
      partialCount = 0;
      onMessage({ type: 'speech_started' });
    };

    const emitFinal = () => {
      const text = pendingFinalText;
      pendingFinalText = '';
      speechStartedSent = false;
      if (!text) return;
      const now = Date.now();
      const timings: Record<string, number | null> = {
        speechMs: speechStartedAt ? now - speechStartedAt : null,
        firstPartialMs:
          firstPartialAt && speechStartedAt ? firstPartialAt - speechStartedAt : null,
        speechEndToFinalMs: null, // серверный EOU — паузу меряет SpeechKit
        partialCount,
      };
      onMessage({ type: 'transcript', text, is_final: true, speech_final: true });
      onMessage({ type: 'utterance_end', timings });
    };

    call.write({ sessionOptions: buildSessionOptions(language, sampleRate) });

    call.on('data', (resp: StreamingResponse) => {
      if (resp.partial) {
        const text = alternativesText(resp.partial);
        if (!text) return;
        emitSpeechStarted();
        partialCount += 1;
        if (!firstPartialAt) firstPartialAt = Date.now();
        onMessage({ type: 'transcript', text, is_final: false, speech_final: false });
        return;
      }
      if (resp.final) {
        const text = alternativesText(resp.final);
        if (text) pendingFinalText = text;
        return;
      }
      if (resp.finalRefinement) {
        const text = alternativesText(resp.finalRefinement.normalizedText);
        if (text) pendingFinalText = text;
        return;
      }
      if (resp.eouUpdate) {
        emitFinal();
      }
    });

    call.on('error', (err: Error) => {
      if (closed) return;
      this.logger.warn(`SpeechKit gRPC error: ${err.message}`);
      onMessage({ type: 'error', message: `SpeechKit: ${err.message}` });
    });

    call.on('end', () => {
      // Финал, который сервер отправил, но eou не пришёл до закрытия потока.
      if (pendingFinalText) emitFinal();
    });

    return {
      sendAudio: (data: Buffer) => {
        if (closed) return;
        audioSeconds += data.length / bytesPerSecond;
        call.write({ chunk: { data } });
      },
      close: () => {
        if (closed) return 0;
        closed = true;
        try {
          call.end();
        } catch {
          /* поток уже закрыт */
        }
        return audioSeconds > 0 ? Math.max(1, Math.ceil(audioSeconds)) : 0;
      },
    };
  }

  readyMessage(sampleRate: number): SttResponseMessage {
    return { type: 'ready', engine: 'speechkit', model: MODEL_NAME, sample_rate: sampleRate };
  }
}
