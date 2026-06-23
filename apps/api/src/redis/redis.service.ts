import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor() {
    this.client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  }

  getClient(): Redis {
    return this.client;
  }

  async checkRateLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
    const current = await this.client.incr(key);
    if (current === 1) {
      await this.client.expire(key, windowSec);
    }
    return current <= limit;
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}
