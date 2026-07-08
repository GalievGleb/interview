/**
 * WebSocket-поверхность STT-прокси гейтвея: /gateway/stt/stream.
 *
 * Авторизация — тот же лицензионный ключ, что и у /v1/chat/completions, но
 * передаётся query-параметром `key` (WS handshake из десктопа не даёт удобно
 * выставить заголовок Authorization). Протокол клиент<->сервер намеренно
 * идентичен локальному /stt/stream в apps/api-py (см. gateway-stt.service.ts) —
 * Python-мост десктопа получается почти прозрачным релеем.
 */
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { HttpException } from '@nestjs/common';
import { Server } from 'ws';
import { IncomingMessage } from 'http';
import { verifyLicenseKey } from './license.util';
import { GatewaySttQuotaService } from './gateway-stt-quota.util';
import { GatewaySttService, SpeechKitProxyHandle } from './gateway-stt.service';

const ALLOWED_SAMPLE_RATES = new Set([8000, 16000, 44100, 48000]);

interface SttSession {
  proxy: SpeechKitProxyHandle | null;
  licenseId: string;
}

@WebSocketGateway({ path: '/gateway/stt/stream' })
export class GatewaySttGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private sessions = new Map<object, SttSession>();

  constructor(
    private readonly sttService: GatewaySttService,
    private readonly quota: GatewaySttQuotaService,
  ) {}

  async handleConnection(client: WebSocket, request: IncomingMessage) {
    const params = this.parseParams(request);
    const license = verifyLicenseKey(params.key);
    if (!license) {
      client.close(4001, 'Invalid or expired license');
      return;
    }

    const apiKey = process.env.YANDEX_API_KEY;
    if (!apiKey) {
      this.safeSend(client, { type: 'error', message: 'STT gateway is not configured' });
      client.close(1011, 'STT gateway not configured');
      return;
    }

    try {
      await this.quota.assertCanStart(license);
    } catch (e) {
      const message =
        e instanceof HttpException
          ? ((e.getResponse() as { error?: { message?: string } })?.error?.message ??
            'Service unavailable')
          : 'Service unavailable';
      this.safeSend(client, { type: 'error', message });
      client.close(4002, 'Quota exceeded');
      return;
    }

    const session: SttSession = { proxy: null, licenseId: license.id };
    this.sessions.set(client, session);

    this.safeSend(client, this.sttService.readyMessage(params.sampleRate));

    session.proxy = this.sttService.createSpeechKitProxy(
      apiKey,
      params.language,
      params.sampleRate,
      (msg) => this.safeSend(client, msg),
    );

    client.onmessage = (event) => {
      if (Buffer.isBuffer(event.data) && session.proxy) {
        session.proxy.sendAudio(event.data as Buffer);
      }
    };
  }

  handleDisconnect(client: WebSocket) {
    const session = this.sessions.get(client);
    if (session?.proxy) {
      const seconds = session.proxy.close();
      void this.quota.recordUsage(session.licenseId, seconds);
    }
    this.sessions.delete(client);
  }

  private safeSend(client: WebSocket, msg: unknown): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(msg));
    }
  }

  private parseParams(request: IncomingMessage): {
    key: string;
    language: string;
    sampleRate: number;
  } {
    const url = request.url ?? '';
    const get = (name: string): string => {
      const m = url.match(new RegExp(`[?&]${name}=([^&]+)`));
      return m ? decodeURIComponent(m[1]) : '';
    };
    const sampleRate = parseInt(get('sample_rate'), 10);
    return {
      key: get('key'),
      language: get('language') || 'ru',
      sampleRate: ALLOWED_SAMPLE_RATES.has(sampleRate) ? sampleRate : 16000,
    };
  }
}
