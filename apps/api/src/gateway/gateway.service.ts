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
import { createHash } from 'crypto';
import { RedisService } from '../redis/redis.service';
import { VerifiedLicense, mintLicenseKey, verifyLicenseKey } from './license.util';

const OPENROUTER_BASE = process.env.GATEWAY_UPSTREAM_BASE ?? 'https://openrouter.ai/api/v1';

// Egress-прокси для апстрима. OpenRouter (Cloudflare) блокирует часть IP по гео
// (403 "Access denied by security policy"); с РФ-сервера прямой доступ закрыт.
// Если задан OPENROUTER_PROXY (или HTTPS_PROXY) — все запросы к OpenRouter идут
// через него. undici грузим лениво: нет пакета/прокси — работаем напрямую.
const PROXY_URL = process.env.OPENROUTER_PROXY || process.env.HTTPS_PROXY || '';
let proxyDispatcher: unknown = null;
if (PROXY_URL) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ProxyAgent } = require('undici');
    proxyDispatcher = new ProxyAgent(PROXY_URL);
  } catch {
    /* undici недоступен — прокси не активен, идём напрямую */
  }
}
/** Добавляет egress-прокси к fetch-опциям, когда прокси настроен. */
function upstreamInit(init: RequestInit): RequestInit {
  return proxyDispatcher ? ({ ...init, dispatcher: proxyDispatcher } as RequestInit) : init;
}

// Стиль апстрима: у OpenRouter ID моделей с префиксом провайдера
// ("openai/gpt-4o-mini"), у OpenAI-совместимых (ProxyAPI, сам OpenAI) — голые
// ("gpt-4o-mini"). Определяем по env, иначе по адресу: openrouter → openrouter.
// ProxyAPI работает из РФ напрямую (в отличие от OpenRouter), поэтому это наш
// активный апстрим; OpenRouter остаётся вариантом (сменить env + рестарт).
const UPSTREAM_STYLE =
  process.env.GATEWAY_UPSTREAM_STYLE ||
  (OPENROUTER_BASE.includes('openrouter') ? 'openrouter' : 'openai');

// Приводим модель к тому, что понимает активный апстрим. ProxyAPI отдаёт модели
// OpenAI с голыми ID. Сохраняем только явный quality-first GPT-5.6 Sol route;
// остальные кросс-провайдерные ID по-прежнему сводим к gpt-4o/mini, чтобы не
// расширять дорогую модельную поверхность лицензионного шлюза.
function mapModelForUpstream(model: string, style = UPSTREAM_STYLE): string {
  const raw = (model || '').trim();
  if (style === 'openrouter') return raw || 'openai/gpt-4o-mini';
  const low = raw.toLowerCase().replace(/^openai\//, '');
  if (low === 'gpt-5.6-sol' || low === 'gpt-5.6') return low;
  const FAST = ['mini', 'nano', 'haiku', 'flash', 'small', 'lite'];
  return FAST.some((k) => low.includes(k)) ? 'gpt-4o-mini' : 'gpt-4o';
}

/** Remove OpenRouter-only options before forwarding to an OpenAI-compatible API. */
export function sanitizeOpenAiUpstreamBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized = { ...body };
  delete sanitized.provider;
  return sanitized;
}

type ChatUpstreamStyle = 'openrouter' | 'openai';

export interface ChatUpstreamRoute {
  baseURL: string;
  apiKey: string;
  style: ChatUpstreamStyle;
  model: string;
  directLive: boolean;
}

const DIRECT_LIVE_MODELS = new Set([
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o-mini',
]);

/**
 * Route only the latency-critical, explicitly throughput-sorted live models
 * directly to OpenAI. All ordinary, user-selected, and expensive models keep
 * the configured gateway upstream and its existing policy surface.
 */
export function resolveChatUpstreamRoute(
  body: Record<string, unknown>,
  environment: NodeJS.ProcessEnv = process.env,
): ChatUpstreamRoute {
  const rawModel = String(body.model ?? '').trim();
  const bareModel = rawModel.replace(/^openai\//i, '');
  const provider = body.provider as { sort?: unknown } | undefined;
  const wantsFastLive = body.stream === true && provider?.sort === 'throughput';
  const directBase = String(
    environment.OPENAI_STT_BASE_URL || 'https://api.openai.com/v1',
  )
    .trim()
    .replace(/\/+$/, '');
  const directKey = String(environment.OPENAI_API_KEY ?? '').trim();
  const directOpenAi = /^https:\/\/api\.openai\.com(?:\/|$)/i.test(directBase);

  if (
    wantsFastLive &&
    directOpenAi &&
    directKey &&
    DIRECT_LIVE_MODELS.has(bareModel.toLowerCase())
  ) {
    return {
      baseURL: directBase,
      apiKey: directKey,
      style: 'openai',
      model: bareModel,
      directLive: true,
    };
  }

  const baseURL = String(
    environment.GATEWAY_UPSTREAM_BASE || 'https://openrouter.ai/api/v1',
  )
    .trim()
    .replace(/\/+$/, '');
  const style: ChatUpstreamStyle =
    environment.GATEWAY_UPSTREAM_STYLE === 'openai' ||
    (!environment.GATEWAY_UPSTREAM_STYLE && !baseURL.includes('openrouter'))
      ? 'openai'
      : 'openrouter';
  return {
    baseURL,
    apiKey: String(environment.OPENROUTER_API_KEY ?? '').trim(),
    style,
    model: mapModelForUpstream(rawModel, style),
    directLive: false,
  };
}

const MODELS_CACHE_KEY = 'gw:models';
const MODELS_CACHE_TTL_S = 600;
// Ключ расхода живёт ~45 дней: текущий месяц + запас на чтение статистики.
const USAGE_TTL_S = 45 * 24 * 3600;
const RATE_LIMIT_PER_MIN = 60;
const TRIAL_LICENSE_TTL_S = 15 * 24 * 3600;
// Анти-фарм триалов: без лимитов эндпоинт /gateway/trial (без авторизации,
// дедуп по подконтрольному клиенту clientId) позволял намайнить бесконечно
// подписанных trial-ключей по 300k токенов каждый и разорить владельца по счёту
// апстрима. Ограничиваем выпуск НОВЫХ триалов по IP и глобально в день.
const TRIAL_MAX_PER_IP_DAY = Number(process.env.GATEWAY_TRIAL_MAX_PER_IP_DAY ?? 3);
const TRIAL_GLOBAL_DAILY_CAP = Number(process.env.GATEWAY_TRIAL_GLOBAL_DAILY_CAP ?? 500);
const DAY_TTL_S = 25 * 3600;

function monthStamp(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function dayStamp(): string {
  return new Date().toISOString().slice(0, 10);
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

function modelPolicyIds(model: string): string[] {
  const raw = (model || '').trim().toLowerCase();
  const bare = raw.replace(/^[^/]+\//, '');
  return raw === bare ? [raw] : [raw, bare];
}

// Политика моделей: блоклист (GATEWAY_BLOCKED_MODELS) удобен для «запретить пару
// дорогих», allowlist (GATEWAY_ALLOWED_MODELS) — для «разрешить только эти».
// Блок имеет приоритет. Оба по префиксу. Пусто = без ограничения.
function isModelAllowed(model: string): boolean {
  const ids = modelPolicyIds(model);
  const blocked = envModels('GATEWAY_BLOCKED_MODELS').flatMap(modelPolicyIds);
  if (blocked.some((b) => ids.some((m) => m === b || m.startsWith(b)))) return false;
  const allow = envModels('GATEWAY_ALLOWED_MODELS').flatMap(modelPolicyIds);
  if (allow.length === 0) return true;
  return allow.some((a) => ids.some((m) => m === a || m.startsWith(a)));
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

  /**
   * Анти-фарм НОВЫХ триалов: лимит по IP/день + глобальный дневной потолок.
   * Redis недоступен → fail-closed 503 (лучше отказать, чем отдать безлимит).
   * Считаем только реальные выпуски, cache-hit по clientId сюда не попадает.
   */
  private async assertTrialAllowed(ip: string): Promise<void> {
    const day = dayStamp();
    let ipOk: boolean;
    let minted: number;
    try {
      const ipHash = createHash('sha256').update(ip || 'unknown').digest('hex').slice(0, 24);
      ipOk = await this.redis.checkRateLimit(`gw:trialip:${ipHash}:${day}`, TRIAL_MAX_PER_IP_DAY, DAY_TTL_S);
      const client = this.redis.getClient();
      const capKey = `gw:trialcap:${day}`;
      minted = await client.incr(capKey);
      if (minted === 1) await client.expire(capKey, DAY_TTL_S);
    } catch (e) {
      this.logger.error(`Redis unavailable in assertTrialAllowed: ${e}`);
      throw new HttpException(
        { error: { message: 'Сервис временно недоступен, попробуйте позже.', code: 'service_unavailable' } },
        503,
      );
    }
    if (!ipOk || minted > TRIAL_GLOBAL_DAILY_CAP) {
      throw new HttpException(
        {
          error: {
            message: 'Лимит выдачи пробного доступа исчерпан — попробуйте позже или оформите тариф.',
            code: 'trial_limit_reached',
          },
        },
        429,
      );
    }
  }

  async issueTrial(
    clientId: string | undefined,
    ip = 'unknown',
  ): Promise<{ key: string; email: string; plan: 'trial' }> {
    const normalized = (clientId ?? '').trim().slice(0, 200);
    if (!normalized) {
      throw new UnauthorizedException({
        error: { message: 'Missing trial client id', code: 'missing_client_id' },
      });
    }

    const id = createHash('sha256').update(normalized).digest('hex').slice(0, 24);
    const redisKey = `gw:trial:${id}`;
    const email = `trial-${id}@skillcue.local`;
    const cached = await this.redis.getClient().get(redisKey);
    if (cached) return { key: cached, email, plan: 'trial' };

    // Новый триал — сначала анти-фарм лимиты, потом дорогая крипта/подпись.
    await this.assertTrialAllowed(ip);

    const privateKeyHex = process.env.LICENSE_PRIVATE_KEY_HEX ?? '';
    if (!privateKeyHex) {
      throw new HttpException(
        { error: { message: 'LICENSE_PRIVATE_KEY_HEX is not set', code: 'gateway_unconfigured' } },
        503,
      );
    }

    const key = mintLicenseKey({ email, plan: 'trial', days: 14, tokensMonth: 300_000 }, privateKeyHex);
    await this.redis.getClient().set(redisKey, key, 'EX', TRIAL_LICENSE_TTL_S);
    return { key, email, plan: 'trial' };
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
    const resp = await fetch(
      `${OPENROUTER_BASE}/models`,
      upstreamInit({ headers: { Authorization: `Bearer ${this.upstreamKey()}` } }),
    );
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

    const route = resolveChatUpstreamRoute(body);
    if (!route.apiKey) {
      throw new HttpException(
        {
          error: {
            message: 'Gateway is not configured (no upstream key)',
            code: 'gateway_unconfigured',
          },
        },
        503,
      );
    }

    let upstreamBody: Record<string, unknown> = { ...body };
    // ID модели — под выбранный апстрим (OpenRouter «openai/…» vs OpenAI «…»).
    upstreamBody.model = route.model;
    if (route.style === 'openai') {
      upstreamBody = sanitizeOpenAiUpstreamBody(upstreamBody);
      if (String(upstreamBody.model).startsWith('gpt-5')) {
        const reasoning = upstreamBody.reasoning as { effort?: unknown } | undefined;
        if (reasoning?.effort) upstreamBody.reasoning_effort = reasoning.effort;
        delete upstreamBody.reasoning;
        if (upstreamBody.max_tokens !== undefined) {
          upstreamBody.max_completion_tokens = upstreamBody.max_tokens;
          delete upstreamBody.max_tokens;
        }
      }
    }
    if (upstreamBody.stream) {
      upstreamBody.stream_options = { include_usage: true, ...(body.stream_options as object) };
    }

    const requestInit: RequestInit = {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${route.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://skillcue.app',
          'X-Title': 'SkillCue',
        },
        body: JSON.stringify(upstreamBody),
        // Клиент отключился посреди стрима → контроллер абортит апстрим, чтобы
        // не платить OpenRouter за токены, которых покупатель уже не увидит.
        signal,
      };
    const resp = await fetch(
      `${route.baseURL}/chat/completions`,
      route.directLive ? requestInit : upstreamInit(requestInit),
    );
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
