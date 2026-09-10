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
import {
  VerifiedLicense,
  mintLicenseKey,
  normalizePlan,
  verifyLicenseKey,
} from './license.util';

const OPENROUTER_BASE = process.env.GATEWAY_UPSTREAM_BASE ?? 'https://openrouter.ai/api/v1';

type ChatUpstreamStyle = 'openrouter' | 'openai';

function knownUpstreamStyle(baseURL: string): ChatUpstreamStyle | null {
  try {
    const hostname = new URL(baseURL).hostname.toLowerCase();
    if (hostname === 'openrouter.ai') return 'openrouter';
    if (hostname === 'api.openai.com') return 'openai';
  } catch {
    // Invalid/custom bases retain the existing explicit-style fallback below.
  }
  return null;
}

function resolveUpstreamStyle(
  baseURL: string,
  configuredStyle: string | undefined,
): ChatUpstreamStyle {
  const knownStyle = knownUpstreamStyle(baseURL);
  if (knownStyle) return knownStyle;
  if (configuredStyle === 'openai' || configuredStyle === 'openrouter') {
    return configuredStyle;
  }
  return baseURL.includes('openrouter') ? 'openrouter' : 'openai';
}

// Стиль апстрима: у OpenRouter ID моделей с префиксом провайдера
// ("openai/gpt-4o-mini"), у OpenAI-совместимых (ProxyAPI, сам OpenAI) — голые
// ("gpt-4o-mini"). Для известных official hosts адрес авторитетнее stale env;
// у custom proxy сохраняем явный GATEWAY_UPSTREAM_STYLE, иначе выводим по URL.
const UPSTREAM_STYLE = resolveUpstreamStyle(
  OPENROUTER_BASE,
  process.env.GATEWAY_UPSTREAM_STYLE,
);

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

export interface ChatUpstreamRoute {
  baseURL: string;
  apiKey: string;
  style: ChatUpstreamStyle;
  model: string;
  directLive: boolean;
}

/**
 * OpenRouter may use its geo egress proxy. Direct OpenAI chat intentionally
 * ignores OPENROUTER_PROXY: it uses an explicit chat proxy or HTTPS_PROXY.
 */
export function proxyUrlForChatRoute(
  route: Pick<ChatUpstreamRoute, 'style' | 'directLive'>,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (route.directLive || route.style === 'openai') {
    return String(environment.OPENAI_CHAT_PROXY || environment.HTTPS_PROXY || '').trim();
  }
  return String(environment.OPENROUTER_PROXY || environment.HTTPS_PROXY || '').trim();
}

const proxyDispatchers = new Map<string, unknown>();

function proxyDispatcher(proxyURL: string): unknown {
  if (!proxyURL) return null;
  const cached = proxyDispatchers.get(proxyURL);
  if (cached) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ProxyAgent } = require('undici');
    const dispatcher = new ProxyAgent(proxyURL);
    proxyDispatchers.set(proxyURL, dispatcher);
    return dispatcher;
  } catch {
    return null;
  }
}

/** Добавляет подходящий egress-прокси к fetch-опциям выбранного апстрима. */
function upstreamInit(
  init: RequestInit,
  route: Pick<ChatUpstreamRoute, 'style' | 'directLive'>,
  environment: NodeJS.ProcessEnv = process.env,
): RequestInit {
  const dispatcher = proxyDispatcher(proxyUrlForChatRoute(route, environment));
  return dispatcher ? ({ ...init, dispatcher } as RequestInit) : init;
}

const DIRECT_LIVE_MODELS = new Set([
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o-mini',
]);

const DIRECT_SCREEN_MODELS = new Set(['gpt-5.6-sol', 'gpt-5.6']);

const STRUCTURED_SCREEN_WORKLOAD = 'structured-screen-v1';
const STRUCTURED_SCREEN_PHASES = new Set(['observation', 'answer', 'repair']);
const STRUCTURED_SCREEN_ANSWER_SCHEMAS = new Set([
  'screen_analysis',
  'screen_checklist',
  'screen_direct_answer',
  'screen_execution_result',
]);
const STRUCTURED_SCREEN_FORBIDDEN_OPTIONS = [
  'provider',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'functions',
  'function_call',
] as const;

type StructuredScreenPhase = 'observation' | 'answer' | 'repair';

export interface StructuredScreenRequestHeaders {
  workload?: unknown;
  phase?: unknown;
}

export interface ChatRouteAuthorization {
  screenAuthorized?: boolean;
}

function isValidInlineImage(part: unknown): boolean {
  if (!part || typeof part !== 'object') return false;
  if ((part as { type?: unknown }).type !== 'image_url') return false;
  const imageURL = (part as { image_url?: unknown }).image_url;
  if (!imageURL || typeof imageURL !== 'object') return false;
  const url = String((imageURL as { url?: unknown }).url ?? '').trim();
  const match = /^data:image\/(png|jpe?g|webp|gif);base64,([a-z0-9+/]+={0,2})$/i.exec(url);
  if (!match || match[2].length % 4 !== 0) return false;
  try {
    const decoded = Buffer.from(match[2], 'base64');
    if (!decoded.length || decoded.toString('base64') !== match[2]) return false;
    switch (match[1].toLowerCase()) {
      case 'png':
        return decoded.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      case 'jpg':
      case 'jpeg':
        return decoded.length >= 3 && decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff;
      case 'gif':
        return decoded.subarray(0, 6).toString('ascii') === 'GIF87a' || decoded.subarray(0, 6).toString('ascii') === 'GIF89a';
      case 'webp':
        return decoded.length >= 12 && decoded.subarray(0, 4).toString('ascii') === 'RIFF' && decoded.subarray(8, 12).toString('ascii') === 'WEBP';
      default:
        return false;
    }
  } catch {
    return false;
  }
}

function hasCurrentImageInput(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  const current = messages.at(-1);
  if (!current || typeof current !== 'object') return false;
  if ((current as { role?: unknown }).role !== 'user') return false;
  const content = (current as { content?: unknown }).content;
  return Array.isArray(content) && content.some(isValidInlineImage);
}

function containsImageInput(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (
    (value as { type?: unknown }).type === 'image_url' ||
    (value as { type?: unknown }).type === 'input_image' ||
    Object.prototype.hasOwnProperty.call(value, 'image_url')
  ) {
    return true;
  }
  const nested = Array.isArray(value) ? value : Object.values(value);
  return nested.some((item) => containsImageInput(item, seen));
}

function hasAnyImageInput(messages: unknown): boolean {
  return containsImageInput(messages, new WeakSet<object>());
}

function exactStructuredScreenModel(model: unknown): string | null {
  if (typeof model !== 'string' || model !== model.trim()) return null;
  const bareModel = model.startsWith('openai/') ? model.slice('openai/'.length) : model;
  return DIRECT_SCREEN_MODELS.has(bareModel) ? bareModel : null;
}

function isManagedScreenModelEquivalent(model: unknown): boolean {
  if (typeof model !== 'string') return false;
  const bareModel = model.trim().replace(/^openai\//i, '').toLowerCase();
  return DIRECT_SCREEN_MODELS.has(bareModel);
}

function responseSchemaName(body: Record<string, unknown>): string | null {
  const responseFormat = body.response_format;
  if (!responseFormat || typeof responseFormat !== 'object') return null;
  if ((responseFormat as { type?: unknown }).type !== 'json_schema') return null;
  const jsonSchema = (responseFormat as { json_schema?: unknown }).json_schema;
  if (!jsonSchema || typeof jsonSchema !== 'object') return null;
  const schema = (jsonSchema as { schema?: unknown }).schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const name = (jsonSchema as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

function hasForbiddenStructuredOptions(body: Record<string, unknown>): boolean {
  return (
    STRUCTURED_SCREEN_FORBIDDEN_OPTIONS.some((key) =>
      Object.prototype.hasOwnProperty.call(body, key),
    ) || Object.prototype.hasOwnProperty.call(body, 'max_completion_tokens')
  );
}

function hasBoundedCompletionLimit(body: Record<string, unknown>, maximum: number): boolean {
  return (
    typeof body.max_tokens === 'number' &&
    Number.isInteger(body.max_tokens) &&
    body.max_tokens > 0 &&
    body.max_tokens <= maximum
  );
}

function classifyStructuredScreenHeaders(headers: StructuredScreenRequestHeaders): {
  attempted: boolean;
  phase: StructuredScreenPhase | null;
} {
  const attempted = headers.workload !== undefined || headers.phase !== undefined;
  if (
    !attempted ||
    headers.workload !== STRUCTURED_SCREEN_WORKLOAD ||
    typeof headers.phase !== 'string' ||
    !STRUCTURED_SCREEN_PHASES.has(headers.phase)
  ) {
    return { attempted, phase: null };
  }
  return { attempted: true, phase: headers.phase as StructuredScreenPhase };
}

function isValidStructuredScreenShape(
  body: Record<string, unknown>,
  phase: StructuredScreenPhase,
): boolean {
  if (body.stream !== undefined && body.stream !== false) return false;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return false;
  if (!exactStructuredScreenModel(body.model)) return false;
  if (hasForbiddenStructuredOptions(body)) return false;
  if (body.n !== undefined && body.n !== 1) return false;

  if (phase === 'observation') {
    return (
      hasBoundedCompletionLimit(body, 1_800) &&
      hasCurrentImageInput(body.messages) &&
      responseSchemaName(body) === 'screen_task_observation'
    );
  }

  if (!hasBoundedCompletionLimit(body, 4_200) || hasAnyImageInput(body.messages)) {
    return false;
  }
  if (body.response_format === undefined) return true;
  const schemaName = responseSchemaName(body);
  return schemaName !== null && STRUCTURED_SCREEN_ANSWER_SCHEMAS.has(schemaName);
}

function structuredScreenForbidden(): HttpException {
  return new HttpException(
    {
      error: {
        message: 'Structured screen request is not allowed.',
        code: 'structured_screen_not_allowed',
      },
    },
    403,
  );
}

function isQualityScreenRequest(body: Record<string, unknown>): boolean {
  const bareModel = String(body.model ?? '').trim().replace(/^openai\//i, '');
  return (
    body.stream === true &&
    DIRECT_SCREEN_MODELS.has(bareModel.toLowerCase()) &&
    hasCurrentImageInput(body.messages)
  );
}

function resolveConfiguredChatUpstreamRoute(
  rawModel: string,
  environment: NodeJS.ProcessEnv,
): ChatUpstreamRoute {
  const baseURL = String(
    environment.GATEWAY_UPSTREAM_BASE || 'https://openrouter.ai/api/v1',
  )
    .trim()
    .replace(/\/+$/, '');
  const style = resolveUpstreamStyle(baseURL, environment.GATEWAY_UPSTREAM_STYLE);
  return {
    baseURL,
    apiKey: String(environment.OPENROUTER_API_KEY ?? '').trim(),
    style,
    model: mapModelForUpstream(rawModel, style),
    directLive: false,
  };
}

/**
 * Route only the latency-critical, explicitly throughput-sorted live models
 * directly to OpenAI. All ordinary, user-selected, and expensive models keep
 * the configured gateway upstream and its existing policy surface.
 */
export function resolveChatUpstreamRoute(
  body: Record<string, unknown>,
  environment: NodeJS.ProcessEnv = process.env,
  authorization: ChatRouteAuthorization = {},
): ChatUpstreamRoute {
  const rawModel = String(body.model ?? '').trim();
  const bareModel = rawModel.replace(/^openai\//i, '');
  const provider = body.provider as { sort?: unknown } | undefined;
  const wantsFastLive = body.stream === true && provider?.sort === 'throughput';
  const wantsQualityScreen =
    authorization.screenAuthorized === true &&
    DIRECT_SCREEN_MODELS.has(bareModel.toLowerCase());
  const dedicatedChatKey = String(environment.OPENAI_CHAT_API_KEY ?? '').trim();
  const dedicatedChatBase = String(environment.OPENAI_CHAT_BASE_URL ?? '').trim();
  const hasOrphanDedicatedBase = Boolean(dedicatedChatBase) && !dedicatedChatKey;
  const directBase = String(
    dedicatedChatKey
      ? dedicatedChatBase || 'https://api.openai.com/v1'
      : environment.OPENAI_STT_BASE_URL || 'https://api.openai.com/v1',
  )
    .trim()
    .replace(/\/+$/, '');
  const directKey = hasOrphanDedicatedBase
    ? ''
    : dedicatedChatKey || String(environment.OPENAI_API_KEY || '').trim();
  const directOpenAi = /^https:\/\/api\.openai\.com(?:\/|$)/i.test(directBase);

  if (
    (wantsFastLive || wantsQualityScreen) &&
    directOpenAi &&
    directKey &&
    (DIRECT_LIVE_MODELS.has(bareModel.toLowerCase()) || wantsQualityScreen)
  ) {
    return {
      baseURL: directBase,
      apiKey: directKey,
      style: 'openai',
      model: bareModel,
      directLive: true,
    };
  }

  return resolveConfiguredChatUpstreamRoute(rawModel, environment);
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

function isModelBlocked(model: string): boolean {
  const ids = modelPolicyIds(model);
  const blocked = envModels('GATEWAY_BLOCKED_MODELS').flatMap(modelPolicyIds);
  return blocked.some((blockedId) =>
    ids.some((modelId) => modelId === blockedId || modelId.startsWith(blockedId)),
  );
}

function isStructuredScreenModelExplicitlyAllowed(model: string): boolean {
  const ids = modelPolicyIds(model);
  const allowed = envModels('GATEWAY_STRUCTURED_SCREEN_ALLOWED_MODELS').flatMap(
    modelPolicyIds,
  );
  return allowed.some((allowedId) => ids.some((modelId) => modelId === allowedId));
}

function prepareChatUpstreamBody(
  body: Record<string, unknown>,
  route: ChatUpstreamRoute,
): Record<string, unknown> {
  let upstreamBody: Record<string, unknown> = { ...body, model: route.model };
  if (route.style === 'openai') {
    upstreamBody = sanitizeOpenAiUpstreamBody(upstreamBody);
    if (String(upstreamBody.model).startsWith('gpt-5')) {
      const reasoning = upstreamBody.reasoning as { effort?: unknown } | undefined;
      if (reasoning?.effort) upstreamBody.reasoning_effort = reasoning.effort;
      delete upstreamBody.reasoning;
      delete upstreamBody.temperature;
      if (upstreamBody.max_tokens !== undefined) {
        upstreamBody.max_completion_tokens = upstreamBody.max_tokens;
        delete upstreamBody.max_tokens;
      }
    }
  }
  if (upstreamBody.stream) {
    upstreamBody.stream_options = {
      include_usage: true,
      ...(body.stream_options as object),
    };
  }
  return upstreamBody;
}

function isTransientUpstreamStatus(status: number): boolean {
  return status === 429 || status >= 500;
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
    const catalogRoute: ChatUpstreamRoute = {
      baseURL: OPENROUTER_BASE,
      apiKey: this.upstreamKey(),
      style: UPSTREAM_STYLE,
      model: '',
      directLive: false,
    };
    const resp = await fetch(
      `${OPENROUTER_BASE}/models`,
      upstreamInit(
        { headers: { Authorization: `Bearer ${catalogRoute.apiKey}` } },
        catalogRoute,
      ),
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
    requestHeaders: StructuredScreenRequestHeaders = {},
  ) {
    await this.assertQuota(license);

    const model = String(body.model ?? '');
    const plan = normalizePlan(license.payload.plan);
    const exactMaxPlan = license.payload.plan === 'max';
    const structuredClassification = classifyStructuredScreenHeaders(requestHeaders);
    const structuredScreen = structuredClassification.phase !== null;
    if (
      structuredClassification.attempted &&
      (!structuredClassification.phase ||
        !exactMaxPlan ||
        !isValidStructuredScreenShape(body, structuredClassification.phase))
    ) {
      throw structuredScreenForbidden();
    }

    const managedScreenModel = isManagedScreenModelEquivalent(body.model);
    if (!structuredClassification.attempted && managedScreenModel && plan !== 'max') {
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

    const fallbackAllowed = isModelAllowed(model);
    const qualityScreen = isQualityScreenRequest(body);
    const authorizedDirectScreen = structuredScreen || (qualityScreen && plan === 'max');
    const route = resolveChatUpstreamRoute(body, process.env, {
      screenAuthorized: authorizedDirectScreen,
    });
    if (structuredScreen && !route.directLive) {
      throw structuredScreenForbidden();
    }
    // A Max user may still use the legacy screen route when the dedicated
    // direct-screen credential is temporarily unavailable. In that case the
    // configured OpenRouter upstream is the safe compatibility fallback;
    // structured-screen requests remain fail-closed below.
    const maxQualityScreen =
      qualityScreen &&
      plan === 'max' &&
      (route.directLive || (route.style === 'openrouter' && Boolean(route.apiKey)));
    const maxStructuredScreen = structuredScreen && route.directLive && plan === 'max';
    const exactStructuredBlockOverride =
      maxStructuredScreen && isStructuredScreenModelExplicitlyAllowed(model);
    if (
      (isModelBlocked(model) && !exactStructuredBlockOverride && !maxQualityScreen) ||
      (!isModelAllowed(model) && !maxQualityScreen && !maxStructuredScreen) ||
      (qualityScreen && !maxQualityScreen)
    ) {
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

    const requestInitFor = (
      selectedRoute: ChatUpstreamRoute,
    ): RequestInit => ({
        method: 'POST',
        headers: {
          Authorization: `Bearer ${selectedRoute.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://skillcue.app',
          'X-Title': 'SkillCue',
        },
        body: JSON.stringify(prepareChatUpstreamBody(body, selectedRoute)),
        // Клиент отключился посреди стрима → контроллер абортит апстрим, чтобы
        // не платить OpenRouter за токены, которых покупатель уже не увидит.
        signal,
      });
    const fetchRoute = (selectedRoute: ChatUpstreamRoute) =>
      fetch(
        `${selectedRoute.baseURL}/chat/completions`,
        upstreamInit(requestInitFor(selectedRoute), selectedRoute),
      );

    try {
      const response = await fetchRoute(route);
      if (
        !route.directLive ||
        (!maxQualityScreen && !maxStructuredScreen) ||
        !isTransientUpstreamStatus(response.status)
      ) {
        return response;
      }

      const fallbackRoute = resolveConfiguredChatUpstreamRoute(model, process.env);
      if (
        !fallbackAllowed ||
        fallbackRoute.style !== 'openrouter' ||
        !fallbackRoute.apiKey
      ) {
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
      return fetchRoute(fallbackRoute);
    } catch (error) {
      if (signal?.aborted || (error as { name?: unknown })?.name === 'AbortError') throw error;
      if (!route.directLive || (!maxQualityScreen && !maxStructuredScreen)) throw error;
      const fallbackRoute = resolveConfiguredChatUpstreamRoute(model, process.env);
      if (
        !fallbackAllowed ||
        fallbackRoute.style !== 'openrouter' ||
        !fallbackRoute.apiKey
      ) {
        throw error;
      }
      return fetchRoute(fallbackRoute);
    }
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
