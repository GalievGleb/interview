import { Injectable, ForbiddenException } from '@nestjs/common';
import OpenAI from 'openai';
import { PersonaMode } from '@interview/shared';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { RedisService } from '../redis/redis.service';
import { buildSuggestMessages } from './prompts';
import { SubStatus } from '@prisma/client';

@Injectable()
export class LlmService {
  private openai: OpenAI | null = null;

  constructor(
    private readonly subscriptionsService: SubscriptionsService,
    private readonly redisService: RedisService,
  ) {}

  private getClient(): OpenAI {
    if (!this.openai) {
      const key = process.env.OPENAI_API_KEY;
      if (!key) {
        throw new Error('OPENAI_API_KEY is not configured');
      }
      this.openai = new OpenAI({ apiKey: key });
    }
    return this.openai;
  }

  async *streamSuggest(userId: string, transcript: string, mode: PersonaMode) {
    const devMode = process.env.DEV_SKIP_SUBSCRIPTION === 'true';

    const allowed = await this.redisService.checkRateLimit(
      `llm:${userId}`,
      devMode ? 60 : 30,
      60,
    );
    if (!allowed) {
      yield { type: 'error' as const, message: 'Rate limit exceeded' };
      return;
    }

    if (!devMode) {
      const sub = await this.subscriptionsService.getByUserId(userId);
      if (!sub || sub.status !== SubStatus.ACTIVE) {
        yield { type: 'error' as const, message: 'Active subscription required' };
        return;
      }

      if (!this.subscriptionsService.checkLlmQuota(sub)) {
        yield { type: 'error' as const, message: 'LLM token quota exceeded' };
        return;
      }

      const limits = await this.subscriptionsService.getSubscriptionInfo(userId);
      if (limits.limits && !limits.limits.modes.includes(mode)) {
        throw new ForbiddenException(`Mode ${mode} requires Pro subscription`);
      }
    }

    try {
      const stream = await this.getClient().chat.completions.create({
        model: 'gpt-4o-mini',
        messages: buildSuggestMessages(transcript, mode),
        stream: true,
        max_tokens: 500,
      });

      let totalTokens = 0;
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content ?? '';
        if (text) {
          totalTokens += Math.ceil(text.length / 4);
          yield { type: 'chunk' as const, text };
        }
      }

      if (process.env.DEV_SKIP_SUBSCRIPTION !== 'true') {
        await this.subscriptionsService.incrementLlmUsage(userId, totalTokens);
      }
      yield { type: 'done' as const };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'LLM request failed';
      yield { type: 'error' as const, message };
    }
  }
}
