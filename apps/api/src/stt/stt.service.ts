import { Injectable } from '@nestjs/common';
import WebSocket from 'ws';
import { SubStatus } from '@prisma/client';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { RedisService } from '../redis/redis.service';
import { SttResponseMessage } from '@interview/shared';

@Injectable()
export class SttService {
  constructor(
    private readonly subscriptionsService: SubscriptionsService,
    private readonly redisService: RedisService,
  ) {}

  async createDeepgramProxy(userId: string, onMessage: (msg: SttResponseMessage) => void) {
    const devMode = process.env.DEV_SKIP_SUBSCRIPTION === 'true';

    if (!devMode) {
      const allowed = await this.redisService.checkRateLimit(`stt:${userId}`, 5, 60);
      if (!allowed) {
        onMessage({ type: 'error', message: 'Rate limit exceeded' });
        return null;
      }

      const sub = await this.subscriptionsService.getByUserId(userId);
      if (!sub || sub.status !== SubStatus.ACTIVE) {
        onMessage({ type: 'error', message: 'Active subscription required' });
        return null;
      }

      if (!this.subscriptionsService.checkSttQuota(sub)) {
        onMessage({ type: 'error', message: 'STT minutes quota exceeded' });
        return null;
      }
    } else {
      const allowed = await this.redisService.checkRateLimit(`stt:${userId}`, 30, 60);
      if (!allowed) {
        onMessage({ type: 'error', message: 'Rate limit exceeded' });
        return null;
      }
    }

    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      onMessage({ type: 'error', message: 'STT service not configured' });
      return null;
    }

    const dgUrl =
      'wss://api.deepgram.com/v1/listen?model=nova-2&language=multi&punctuate=true&interim_results=true&encoding=linear16&sample_rate=16000&channels=1';

    const dgWs = new WebSocket(dgUrl, {
      headers: { Authorization: `Token ${apiKey}` },
    });

    let audioBytesSent = 0;
    const startTime = Date.now();

    dgWs.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        const alt = parsed.channel?.alternatives?.[0];
        if (alt?.transcript) {
          onMessage({
            type: 'transcript',
            text: alt.transcript,
            isFinal: parsed.is_final ?? false,
          });
        }
      } catch {
        // ignore parse errors
      }
    });

    dgWs.on('error', () => {
      onMessage({ type: 'error', message: 'STT connection error' });
    });

    dgWs.on('close', async () => {
      if (process.env.DEV_SKIP_SUBSCRIPTION !== 'true') {
        const elapsedMin = Math.max(1, Math.ceil((Date.now() - startTime) / 60000));
        await this.subscriptionsService.incrementSttUsage(userId, elapsedMin);
        onMessage({ type: 'usage', minutesUsed: elapsedMin });
      }
    });

    return {
      sendAudio: (base64Audio: string) => {
        if (dgWs.readyState === WebSocket.OPEN) {
          const buffer = Buffer.from(base64Audio, 'base64');
          audioBytesSent += buffer.length;
          dgWs.send(buffer);
        }
      },
      close: () => {
        if (dgWs.readyState === WebSocket.OPEN) {
          dgWs.send(JSON.stringify({ type: 'CloseStream' }));
          dgWs.close();
        }
      },
    };
  }
}
