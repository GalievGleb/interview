/**
 * STT-квота гейтвея — учёт секунд аудио, отдельно от LLM-токенов
 * (gateway.service.ts). Каждая проксированная секунда стоит денег в Yandex,
 * поэтому лимит нужен с первого дня, а не когда кто-то накрутит счёт.
 */
import { Injectable, HttpException, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { VerifiedLicense, normalizePlan } from './license.util';

/** Месячные бюджеты STT (в секундах аудио), по тарифу. Переопределяются env. */
export const PLAN_STT_SECONDS_BUDGETS: Record<string, number> = {
  trial: Number(process.env.GATEWAY_STT_SECONDS_TRIAL ?? 20 * 60), // 20 минут
  basic: Number(process.env.GATEWAY_STT_SECONDS_BASIC ?? 5 * 3600), // 5 часов
  max: Number(process.env.GATEWAY_STT_SECONDS_MAX ?? 20 * 3600), // 20 часов
};

const NEW_SESSION_RATE_LIMIT = 10; // новых WS-подключений
const NEW_SESSION_RATE_WINDOW_S = 60;

function monthStamp(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function sttSecondsBudgetFor(license: VerifiedLicense): number {
  return PLAN_STT_SECONDS_BUDGETS[normalizePlan(license.payload.plan)];
}

@Injectable()
export class GatewaySttQuotaService {
  private readonly logger = new Logger('GatewaySttQuota');

  constructor(private readonly redis: RedisService) {}

  private usageKey(licenseId: string): string {
    return `gw:stt:${licenseId}:${monthStamp()}`;
  }

  async secondsUsed(licenseId: string): Promise<number> {
    const raw = await this.redis.getClient().get(this.usageKey(licenseId));
    return raw ? parseInt(raw, 10) || 0 : 0;
  }

  /** Новое WS-подключение: rate-limit + оставшийся месячный бюджет секунд. */
  async assertCanStart(license: VerifiedLicense): Promise<void> {
    let okRate: boolean;
    let used: number;
    try {
      okRate = await this.redis.checkRateLimit(
        `gw:sttrate:${license.id}`,
        NEW_SESSION_RATE_LIMIT,
        NEW_SESSION_RATE_WINDOW_S,
      );
      used = await this.secondsUsed(license.id);
    } catch (e) {
      this.logger.error(`Redis unavailable in assertCanStart: ${e}`);
      throw new HttpException(
        { error: { message: 'Сервис временно недоступен, попробуйте позже.', code: 'service_unavailable' } },
        503,
      );
    }
    if (!okRate) {
      throw new HttpException(
        { error: { message: 'Слишком много запросов — подождите минуту.', code: 'rate_limited' } },
        429,
      );
    }
    if (used >= sttSecondsBudgetFor(license)) {
      throw new HttpException(
        {
          error: {
            message: 'Месячный лимит распознавания речи исчерпан. Лимит обновится 1-го числа.',
            code: 'stt_quota_exceeded',
          },
        },
        402,
      );
    }
  }

  async recordUsage(licenseId: string, seconds: number): Promise<void> {
    if (seconds <= 0) return;
    try {
      const key = this.usageKey(licenseId);
      const total = await this.redis.getClient().incrby(key, Math.ceil(seconds));
      if (total === Math.ceil(seconds)) {
        await this.redis.getClient().expire(key, 45 * 24 * 3600);
      }
    } catch (e) {
      this.logger.error(`recordUsage failed (seconds lost from metering): ${e}`);
    }
  }
}
