import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import type { VerifiedLicense } from './license.util';

export const TTS_MODEL = 'gpt-4o-mini-tts';
export const TTS_VOICE = 'marin';
export const MAX_TTS_CHARS = 800;

const TTS_RATE_LIMIT = 30;
const TTS_RATE_WINDOW_SECONDS = 60;
const RUSSIAN_SPEECH_INSTRUCTIONS =
  'Говори естественно, спокойно и доброжелательно, как живой интервьюер. Без дикторской манеры.';
const ENGLISH_SPEECH_INSTRUCTIONS =
  'Speak naturally, calmly, and warmly like a real interviewer, without an announcer voice.';

export function normalizeTtsInput(raw: string): string {
  const input = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!input || input.length > MAX_TTS_CHARS) {
    throw new BadRequestException(`TTS input must contain 1-${MAX_TTS_CHARS} characters`);
  }
  return input;
}

export function buildTtsUpstreamBody(input: string, language: string) {
  return {
    model: TTS_MODEL,
    voice: TTS_VOICE,
    input: normalizeTtsInput(input),
    response_format: 'wav',
    instructions:
      language === 'ru' ? RUSSIAN_SPEECH_INSTRUCTIONS : ENGLISH_SPEECH_INSTRUCTIONS,
  } as const;
}

@Injectable()
export class GatewayTtsService {
  constructor(private readonly redis: RedisService) {}

  async synthesize(
    license: VerifiedLicense,
    input: string,
    language: string,
  ): Promise<Buffer> {
    const allowed = await this.redis.checkRateLimit(
      `gw:tts-rate:${license.id}`,
      TTS_RATE_LIMIT,
      TTS_RATE_WINDOW_SECONDS,
    );
    if (!allowed) {
      throw new HttpException(
        {
          error: {
            message: 'Слишком много запросов озвучки — подождите минуту.',
            code: 'rate_limited',
          },
        },
        429,
      );
    }

    const apiKey = process.env.OPENAI_API_KEY ?? '';
    if (!apiKey) {
      throw new HttpException(
        {
          error: {
            message: 'Озвучка временно недоступна.',
            code: 'gateway_unconfigured',
          },
        },
        503,
      );
    }

    const baseUrl = (process.env.OPENAI_TTS_BASE_URL ?? 'https://api.openai.com/v1').replace(
      /\/$/,
      '',
    );
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/audio/speech`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildTtsUpstreamBody(input, language)),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new HttpException(
        {
          error: {
            message: 'Не удалось подключиться к сервису озвучки.',
            code: 'tts_provider_unavailable',
          },
        },
        502,
      );
    }

    if (!response.ok) {
      throw new HttpException(
        {
          error: {
            message: 'Не удалось создать озвучку.',
            code: 'tts_provider_error',
          },
        },
        response.status >= 400 && response.status < 600 ? response.status : 502,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }
}
