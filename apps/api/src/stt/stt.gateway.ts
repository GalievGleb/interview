import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server } from 'ws';
import { JwtService } from '@nestjs/jwt';
import { SttService } from './stt.service';
import { SttStreamMessage, SttResponseMessage } from '@interview/shared';
import { IncomingMessage } from 'http';

interface SttSession {
  proxy: { sendAudio: (data: string) => void; close: () => void } | null;
}

@WebSocketGateway({ path: '/stt/stream' })
export class SttGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private sessions = new Map<object, SttSession>();

  constructor(
    private readonly sttService: SttService,
    private readonly jwtService: JwtService,
  ) {}

  async handleConnection(client: WebSocket, request: IncomingMessage) {
    const token = this.extractToken(request);
    if (!token) {
      client.close(4001, 'Unauthorized');
      return;
    }

    let userId: string;
    try {
      const payload = this.jwtService.verify(token, {
        secret: process.env.JWT_ACCESS_SECRET ?? 'dev-access-secret-change-me',
      });
      userId = payload.sub;
    } catch {
      client.close(4001, 'Unauthorized');
      return;
    }

    const session: SttSession = { proxy: null };
    this.sessions.set(client, session);

    session.proxy = await this.sttService.createDeepgramProxy(userId, (msg: SttResponseMessage) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(msg));
      }
    });

    client.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as SttStreamMessage;
        if (message.type === 'audio' && message.data && session.proxy) {
          session.proxy.sendAudio(message.data);
        }
        if (message.type === 'stop' && session.proxy) {
          session.proxy.close();
        }
      } catch {
        // ignore
      }
    };
  }

  handleDisconnect(client: WebSocket) {
    const session = this.sessions.get(client);
    if (session?.proxy) {
      session.proxy.close();
    }
    this.sessions.delete(client);
  }

  private extractToken(request: IncomingMessage): string | null {
    const url = request.url ?? '';
    const match = url.match(/[?&]token=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }
}
