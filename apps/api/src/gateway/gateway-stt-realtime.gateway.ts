import { HttpException, Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import { createHash } from 'node:crypto';
import { IncomingMessage } from 'node:http';
import WebSocket, { RawData } from 'ws';

import { GatewayService } from './gateway.service';
import { RealtimeSttBridge } from './gateway-stt-realtime.bridge';
import {
  OPENAI_REALTIME_SAMPLE_RATE,
  OPENAI_REALTIME_STT_MODEL,
  audioDurationSecondsFromPcmBytes,
  buildRealtimeSessionUpdate,
} from './gateway-stt-realtime.protocol';
import { GatewaySttQuotaService } from './gateway-stt-quota.util';

interface RealtimeUpstreamConfig {
  apiKey: string;
  url: string;
}

interface RealtimeGatewaySession {
  bridge: RealtimeSttBridge;
  licenseId: string;
  upstream: WebSocket;
}

export function resolveRealtimeSttUpstream(
  environment: NodeJS.ProcessEnv = process.env,
): RealtimeUpstreamConfig {
  const base = String(environment.OPENAI_STT_BASE_URL ?? 'https://api.openai.com/v1').trim();
  const parsed = new URL(base);
  if (parsed.protocol !== 'https:' || parsed.hostname.toLocaleLowerCase() !== 'api.openai.com') {
    throw new Error('Realtime STT requires a direct OpenAI API key and endpoint');
  }
  const apiKey = String(
    environment.OPENAI_STT_API_KEY ?? environment.OPENAI_API_KEY ?? '',
  ).trim();
  if (!apiKey) throw new Error('Realtime STT requires a direct OpenAI API key');

  parsed.protocol = 'wss:';
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/realtime`;
  parsed.search = '';
  parsed.searchParams.set('intent', 'transcription');
  return { apiKey, url: parsed.toString() };
}

export function realtimeSafetyIdentifier(licenseId: string): string {
  return createHash('sha256').update(licenseId).digest('hex').slice(0, 32);
}

function errorMessage(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'object' && response) {
      const nested = (response as { error?: { message?: unknown } }).error?.message;
      if (typeof nested === 'string' && nested) return nested;
    }
  }
  return 'Realtime transcription is temporarily unavailable';
}

@WebSocketGateway({ path: '/gateway/stt/stream' })
export class GatewaySttRealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger('GatewaySttRealtime');
  private readonly sessions = new Map<WebSocket, RealtimeGatewaySession>();

  constructor(
    private readonly gateway: GatewayService,
    private readonly quota: GatewaySttQuotaService,
  ) {}

  async handleConnection(client: WebSocket, request: IncomingMessage): Promise<void> {
    try {
      const license = this.gateway.authorize(request.headers.authorization);
      await this.quota.assertCanStart(license);
      const config = resolveRealtimeSttUpstream();
      const language = this.languageFrom(request.url);
      const bridge = new RealtimeSttBridge(language);
      const upstream = new WebSocket(config.url, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'OpenAI-Safety-Identifier': realtimeSafetyIdentifier(license.id),
        },
        handshakeTimeout: 10_000,
      });
      this.sessions.set(client, { bridge, licenseId: license.id, upstream });

      client.on('message', (data, isBinary) =>
        this.handleClientMessage(client, data, isBinary),
      );
      client.on('error', () => this.finalize(client));

      upstream.on('open', () => {
        upstream.send(JSON.stringify(buildRealtimeSessionUpdate(language)));
      });
      upstream.on('message', (data) => this.handleUpstreamMessage(client, data));
      upstream.on('error', (error) => {
        this.logger.warn(`OpenAI Realtime socket error: ${error.message}`);
        this.safeSend(client, {
          type: 'error',
          message: 'Realtime transcription is temporarily unavailable',
        });
        this.closeClient(client, 1011, 'Realtime STT unavailable');
      });
      upstream.on('close', () => {
        if (client.readyState === WebSocket.OPEN) {
          this.closeClient(client, 1011, 'Realtime STT unavailable');
        }
      });
    } catch (error) {
      this.safeSend(client, { type: 'error', message: errorMessage(error) });
      this.closeClient(client, 4001, 'Realtime STT rejected');
    }
  }

  handleDisconnect(client: WebSocket): void {
    this.finalize(client);
  }

  private handleClientMessage(client: WebSocket, data: RawData, isBinary: boolean): void {
    const session = this.sessions.get(client);
    if (!session) return;
    try {
      const upstreamEvent = isBinary
        ? session.bridge.acceptAudio(this.toBuffer(data))
        : session.bridge.acceptControl(
            JSON.parse(this.toBuffer(data).toString('utf8')) as Record<string, unknown>,
          );
      if (upstreamEvent && session.upstream.readyState === WebSocket.OPEN) {
        session.upstream.send(JSON.stringify(upstreamEvent));
      }
    } catch (error) {
      this.logger.warn(`Rejected realtime STT client event: ${String(error)}`);
      this.safeSend(client, { type: 'error', message: 'Invalid realtime STT event' });
      this.closeClient(client, 1008, 'Invalid realtime STT event');
    }
  }

  private handleUpstreamMessage(client: WebSocket, data: RawData): void {
    const session = this.sessions.get(client);
    if (!session) return;
    try {
      const event = JSON.parse(this.toBuffer(data).toString('utf8')) as Record<string, unknown>;
      if (event.type === 'session.updated') {
        this.safeSend(client, {
          type: 'ready',
          engine: 'openai-realtime',
          model: OPENAI_REALTIME_STT_MODEL,
          sample_rate: OPENAI_REALTIME_SAMPLE_RATE,
        });
        return;
      }
      const clientEvent = session.bridge.acceptUpstream(event);
      if (clientEvent) this.safeSend(client, clientEvent);
    } catch (error) {
      this.logger.warn(`Invalid OpenAI Realtime event: ${String(error)}`);
      this.safeSend(client, {
        type: 'error',
        message: 'Realtime transcription is temporarily unavailable',
      });
    }
  }

  private finalize(client: WebSocket): void {
    const session = this.sessions.get(client);
    if (!session) return;
    this.sessions.delete(client);
    if (
      session.upstream.readyState === WebSocket.OPEN ||
      session.upstream.readyState === WebSocket.CONNECTING
    ) {
      session.upstream.close();
    }
    const seconds = audioDurationSecondsFromPcmBytes(session.bridge.receivedPcmBytes);
    void this.quota.recordUsage(session.licenseId, seconds);
  }

  private safeSend(client: WebSocket, event: unknown): void {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
  }

  private closeClient(client: WebSocket, code: number, reason: string): void {
    if (client.readyState === WebSocket.OPEN) client.close(code, reason);
  }

  private languageFrom(rawUrl: string | undefined): string {
    const value = new URL(rawUrl ?? '/', 'http://localhost').searchParams.get('language');
    return value?.toLocaleLowerCase().startsWith('en') ? 'en' : 'ru';
  }

  private toBuffer(data: RawData): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (Array.isArray(data)) return Buffer.concat(data);
    throw new Error('Unsupported WebSocket payload');
  }
}
