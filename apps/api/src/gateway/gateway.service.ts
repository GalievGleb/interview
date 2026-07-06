/**
 * OpenAI-совместимый гейтвей SkillCue.
 *
 * Десктоп ходит сюда вместо OpenRouter: Bearer-токен — лицензионный ключ
 * (Ed25519, проверка офлайн), апстрим-ключ OpenRouter живёт только на сервере.
 * Расход токенов копится в Redis помесячно на анонимный id ключа; при
 * исчерпании бюджета тарифа — 402 в формате ошибки OpenAI, десктоп показывает
 * сообщение как есть.
 */
import { HttpException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { VerifiedLicense, verifyLicenseKey } from './license.util';

const OPENROUTER_BASE = process.env.GATEWAY_UPSTREAM_BASE ?? 'https://openrouter.ai/api/v1';
const MODELS_CACHE_KEY = 'gw:models';
const MODELS_CACHE_TTL_S = 600;
// Ключ расхода живёт ~45 дней: текущий месяц + запас на чтение статистики.
const USAGE_TTL_S = 45 * 24 * 3600;
const RATE_LIMIT_PER_MIN = 60;

function monthStamp(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Защита расходов: бюджет тарифа — в ТОКЕНАХ, но цена токена у моделей отличается
// в ~100 раз. Без ограничения покупатель может пустить весь бюджет через дорогую
// модель и разорить владельца. GATEWAY_ALLOWED_MODELS (через запятую) ограничивает
// список; пусто — разрешены все (обратная совместимость). Матч по префиксу, чтобы
// "openai/gpt-4o-mini" покрывал версии.
function envModels(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean);
}

// Политика моделей: блоклист (GATEWAY_BLOCKED_MODELS) удобен для «запретить пару
// дорогих», allowlist (GATEWAY_ALLOWED_MODELS) — для «разрешить только эти».
// Блок имеет приоритет. Оба по префиксу. Пусто = без ограничения.
function isModelAllowed(model: string): boolean {
  const m = (model || '').toLowerCase();
  const blocked = envModels('GATEWAY_BLOCKED_MODELS');
  if (blocked.some((b) => m === b || m.startsWith(b))) return false;
  const allow = envModels('GATEWAY_ALLOWED_MODELS');
  if (allow.length === 0) return true;
  return allow.some((a) => m === a || m.startsWith(a));
}

@Injectable()
export class GatewayService {
  private readonly logger = new Logger('Gateway');

  constructor(private readonly redis: RedisService) {}

  private upstreamKey(): string {
    const key = process.env.OPENROUTER_API_KEY ?? '';
    if (!key) {
      throw new HttpException(
        { error: { message: 'Gateway is not configured (no upstream key)', code: 'gateway_unconfigured' } },
        503,
      );
    }
    return key;
  }

  /** Публичная проверка живости для мониторинга: Redis + наличие апстрим-ключа. */
  async health(): Promise<{ ok: boolean; redis: boolean; upstreamConfigured: boolean; ts: number }> {
    let redisOk = false;
    try {
      redisOk = (await this.redis.getClient().ping()) === 'PONG';
    } catch {
      redisOk = false;
    }
    return {
      ok: redisOk,
      redis: redisOk,
      upstreamConfigured: Boolean(process.env.OPENROUTER_API_KEY),
      ts: Date.now(),
    };
  }

  /** Bearer <SKILLCUE-...> → проверенная лицензия, иначе 401. */
  authorize(authHeader: string | undefined): VerifiedLicense {
    const token = (authHeader ?? '').replace(/^Bearer\s+/i, '').trim();
    const license = verifyLicenseKey(token);
    if (!license) {
      throw new UnauthorizedException({
        error: {
          message: 'Невалидный или истёкший лицензионный ключ SkillCue.',
          code: 'invalid_license',
        },
      });
    }
    return license;
  }

  private usageKey(licenseId: string): string {
    return `gw:tok:${licenseId}:${monthStamp()}`;
  }

  async usedTokens(licenseId: string): Promise<number> {
    const raw = await this.redis.getClient().get(this.usageKey(licenseId));
    return raw ? parseInt(raw, 10) || 0 : 0;
  }

  async assertQuota(license: VerifiedLicense): Promise<void> {
    let okRate: boolean;
    let used: number;
    try {
      okRate = await this.redis.checkRateLimit(
        `gw:rate:${license.id}:${Math.floor(Date.now() / 60_000)}`,
        RATE_LIMIT_PER_MIN,
        90,
      );
      used = await this.usedTokens(license.id);
    } catch (e) {
      // Redis недоступен — fail-closed, но с понятным 503, а не сырым 500.
      this.logger.error(`Redis unavailable in assertQuota: ${e}`);
      throw new HttpException(
        {
          error: {
            message: 'Сервис временно недоступен, попробуйте через минуту.',
            code: 'service_unavailable',
          },
        },
        503,
      );
    }
    if (!okRate) {
      throw new HttpException(
        { error: { message: 'Слишком много запросов — подождите минуту.', code: 'rate_limited' } },
        429,
      );
    }
    if (used >= license.budget) {
      throw new HttpException(
        {
          error: {
            message:
              'Месячный лимит токенов тарифа исчерпан. Лимит обновится 1-го числа; ' +
              'нужен больший объём — свяжитесь с поддержкой.',
            code: 'token_quota_exceeded',
          },
        },
        402,
      );
    }
  }

  async recordUsage(licenseId: string, tokens: number): Promise<void> {
    if (tokens <= 0) return;
    try {
      const client = this.redis.getClient();
      const key = this.usageKey(licenseId);
      const total = await client.incrby(key, Math.ceil(tokens));
      if (total === Math.ceil(tokens)) {
        await client.expire(key, USAGE_TTL_S);
      }
    } catch (e) {
      // Метрика — не критичнее уже отданного ответа: логируем, но не роняем запрос.
      this.logger.error(`recordUsage failed (tokens lost from metering): ${e}`);
    }
  }

  async usageInfo(license: VerifiedLicense) {
    const used = await this.usedTokens(license.id);
    return {
      plan: license.payload.plan ?? 'max',
      month: monthStamp(),
      tokensUsed: used,
      tokensBudget: license.budget,
      tokensLeft: Math.max(0, license.budget - used),
    };
  }

  // Каталог кэшируется сырым; политику моделей применяем НА ВОЗВРАТЕ, чтобы смена
  // blocklist/allowlist действовала сразу, без ожидания протухания кэша.
  private filterCatalog(catalog: unknown): unknown {
    const c = catalog as { data?: Array<{ id?: string }> };
    if (!c || !Array.isArray(c.data)) return catalog;
    return { ...c, data: c.data.filter((m) => isModelAllowed(String(m?.id ?? ''))) };
  }

  /** GET /v1/models — прокси с кэшем; заблокированные модели скрыты из списка,
   * чтобы приложение не показывало то, что вернёт 403. */
  async models(): Promise<unknown> {
    const cached = await this.redis.getClient().get(MODELS_CACHE_KEY);
    if (cached) return this.filterCatalog(JSON.parse(cached));
    const resp = await fetch(`${OPENROUTER_BASE}/models`, {
      headers: { Authorization: `Bearer ${this.upstreamKey()}` },
    });
    if (!resp.ok) {
      throw new HttpException(
        { error: { message: `Upstream /models failed: ${resp.status}`, code: 'upstream_error' } },
        502,
      );
    }
    const data = await resp.json();
    await this.redis
      .getClient()
      .set(MODELS_CACHE_KEY, JSON.stringify(data), 'EX', MODELS_CACHE_TTL_S);
    return this.filterCatalog(data);
  }

  /**
   * POST /v1/chat/completions. Возвращает upstream-Response; стрим пробрасывает
   * контроллер, а мы считаем токены: точно — из usage-чанка (просим его через
   * stream_options), грубо — по символам, если провайдер usage не прислал.
   */
  async chatCompletions(
    license: VerifiedLicense,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    await this.assertQuota(license);

    const model = String(body.model ?? '');
    if (!isModelAllowed(model)) {
      throw new HttpException(
        {
          error: {
            message: `Модель «${model}» недоступна на этом тарифе.`,
            code: 'model_not_allowed',
          },
        },
        403,
      );
    }

    const upstreamBody: Record<string, unknown> = { ...body };
    if (upstreamBody.stream) {
      upstreamBody.stream_options = { include_usage: true, ...(body.stream_options as object) };
    }

    const resp = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.upstreamKey()}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://skillcue.app',
        'X-Title': 'SkillCue',
      },
      body: JSON.stringify(upstreamBody),
      // Клиент отключился посреди стрима → контроллер абортит апстрим, чтобы
      // не платить OpenRouter за токены, которых покупатель уже не увидит.
      signal,
    });
    return resp;
  }

  /** Оценка расхода по символам — фолбэк, когда usage-чанк не пришёл. */
  estimateTokens(body: Record<string, unknown>, completionChars: number): number {
    const promptChars = JSON.stringify(body.messages ?? '').length;
    return Math.ceil(promptChars / 4) + Math.ceil(completionChars / 4);
  }

  /**
   * Админ-статистика расхода за текущий месяц: сколько лицензий активно и сколько
   * токенов потрачено (мониторинг счёта OpenRouter владельца). Email не хранится —
   * только анонимные id ключей.
   */
  async usageStats(): Promise<{
    month: string;
    activeLicenses: number;
    totalTokens: number;
    top: Array<{ id: string; tokens: number }>;
  }> {
    const month = monthStamp();
    const client = this.redis.getClient();
    const pattern = `gw:tok:*:${month}`;
    const rows: Array<{ id: string; tokens: number }> = [];
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length) {
        const vals = await client.mget(...keys);
        keys.forEach((k, i) => {
          rows.push({ id: k.split(':')[2] ?? '?', tokens: parseInt(vals[i] ?? '0', 10) || 0 });
        });
      }
    } while (cursor !== '0');
    rows.sort((a, b) => b.tokens - a.tokens);
    return {
      month,
      activeLicenses: rows.length,
      totalTokens: rows.reduce((s, r) => s + r.tokens, 0),
      top: rows.slice(0, 20),
    };
  }
}
