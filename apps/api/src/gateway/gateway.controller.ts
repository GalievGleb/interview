/**
 * HTTP-поверхность гейтвея.
 *
 * /v1/* — OpenAI-совместимые эндпоинты: десктопу достаточно сменить base_url и
 * подставить лицензионный ключ вместо API-ключа OpenRouter.
 * /gateway/issue — выпуск ключей (админ-секрет); сюда же будет ходить вебхук
 * оплаты, когда подключится ЮKassa.
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { IsEmail, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { GatewayService } from './gateway.service';
import { BillingService } from './billing.service';
import { mintLicenseKey } from './license.util';

class IssueDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsIn(['basic', 'max'])
  plan?: 'basic' | 'max';

  @IsOptional()
  @IsInt()
  @Min(1)
  days?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  tokensMonth?: number;
}

class TrialDto {
  @IsString()
  clientId!: string;
}

class CheckoutDto {
  @IsIn(['basic', 'max'])
  plan!: 'basic' | 'max';

  @IsIn(['monthly', 'yearly'])
  period!: 'monthly' | 'yearly';

  @IsEmail()
  email!: string;
}

@Controller()
export class GatewayController {
  constructor(
    private readonly gateway: GatewayService,
    private readonly billing: BillingService,
  ) {}

  @Get('health')
  async health() {
    return this.gateway.health(); // без авторизации — для аптайм-мониторинга
  }

  @Get('v1/models')
  async models(@Headers('authorization') auth: string | undefined) {
    this.gateway.authorize(auth); // каталог только по валидному ключу
    return this.gateway.models();
  }

  @Get('v1/usage')
  async usage(@Headers('authorization') auth: string | undefined) {
    const license = this.gateway.authorize(auth);
    return this.gateway.usageInfo(license);
  }

  @Post('v1/chat/completions')
  async chatCompletions(
    @Headers('authorization') auth: string | undefined,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const license = this.gateway.authorize(auth);
    // Клиент отключился → абортим апстрим (перестаём жечь токены OpenRouter).
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const upstream = await this.gateway.chatCompletions(license, body, ac.signal);

    if (!upstream.ok && !upstream.body) {
      res.status(upstream.status).json({
        error: { message: `Upstream error ${upstream.status}`, code: 'upstream_error' },
      });
      return;
    }

    if (!body.stream) {
      const data = (await upstream.json()) as {
        usage?: { total_tokens?: number };
        choices?: Array<{ message?: { content?: string } }>;
      };
      const tokens =
        data.usage?.total_tokens ??
        this.gateway.estimateTokens(body, data.choices?.[0]?.message?.content?.length ?? 0);
      await this.gateway.recordUsage(license.id, tokens);
      res.status(upstream.status).json(data);
      return;
    }

    // SSE-проброс: чанки уходят клиенту как есть; параллельно ищем usage-чанк
    // (stream_options.include_usage) для точного учёта, иначе оценка по символам.
    res.status(upstream.status);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    let exactTokens: number | null = null;
    let completionChars = 0;
    let lineBuffer = '';
    const decoder = new TextDecoder();

    try {
      // @ts-expect-error — ReadableStream асинхронно итерируем в Node 18+.
      for await (const chunk of upstream.body) {
        const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        res.write(buf);
        lineBuffer += decoder.decode(buf, { stream: true });
        let nl: number;
        while ((nl = lineBuffer.indexOf('\n')) >= 0) {
          const line = lineBuffer.slice(0, nl).trim();
          lineBuffer = lineBuffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload) as {
              usage?: { total_tokens?: number };
              choices?: Array<{ delta?: { content?: string } }>;
            };
            completionChars += parsed.choices?.[0]?.delta?.content?.length ?? 0;
            if (parsed.usage?.total_tokens) exactTokens = parsed.usage.total_tokens;
          } catch {
            /* неполный JSON в чанке — просто пробрасываем дальше */
          }
        }
      }
    } catch {
      // Обрыв клиента (AbortError) или сбой апстрима — расход за уже полученное
      // спишется в finally; повторно ошибку не бросаем, res закрывается ниже.
    } finally {
      const tokens = exactTokens ?? this.gateway.estimateTokens(body, completionChars);
      await this.gateway.recordUsage(license.id, tokens).catch(() => undefined);
      if (!res.writableEnded) res.end();
    }
  }

  private requireAdmin(adminSecret: string | undefined): void {
    const expected = process.env.GATEWAY_ADMIN_SECRET ?? '';
    if (!expected || adminSecret !== expected) {
      throw new UnauthorizedException({
        error: { message: 'Bad admin secret', code: 'unauthorized' },
      });
    }
  }

  @Get('gateway/stats')
  async stats(@Headers('x-admin-secret') adminSecret: string | undefined) {
    this.requireAdmin(adminSecret);
    return this.gateway.usageStats();
  }

  @Post('gateway/trial')
  async trial(@Body() dto: TrialDto, @Req() req: Request) {
    // За egress-прокси/nginx реальный адрес — в X-Forwarded-For (первый хоп).
    const fwd = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
    const ip = fwd || req.socket?.remoteAddress || 'unknown';
    return this.gateway.issueTrial(dto.clientId, ip);
  }

  @Post('gateway/issue')
  async issue(
    @Headers('x-admin-secret') adminSecret: string | undefined,
    @Body() dto: IssueDto,
  ) {
    this.requireAdmin(adminSecret);
    const privateKeyHex = process.env.LICENSE_PRIVATE_KEY_HEX ?? '';
    if (!privateKeyHex) {
      throw new HttpException(
        { error: { message: 'LICENSE_PRIVATE_KEY_HEX is not set', code: 'gateway_unconfigured' } },
        503,
      );
    }
    const key = mintLicenseKey(
      { email: dto.email, plan: dto.plan, days: dto.days, tokensMonth: dto.tokensMonth },
      privateKeyHex,
    );
    return { key, email: dto.email, plan: dto.plan ?? 'max' };
  }

  // ---- Оплата ЮKassa --------------------------------------------------------

  /** Создать платёж и вернуть ссылку на оплату (редирект на ЮKassa). */
  @Post('gateway/checkout')
  async checkout(@Body() dto: CheckoutDto) {
    return this.billing.createCheckout(dto.plan, dto.period, dto.email);
  }

  /** Вебхук ЮKassa. Всегда отвечаем 200, чтобы не ловить бесконечные ретраи. */
  @Post('gateway/yookassa/webhook')
  async yookassaWebhook(@Body() body: Record<string, unknown>) {
    await this.billing.handleWebhook(body);
    return { ok: true };
  }

  /** Опрос страницей успеха: как только оплата подтверждена — вернём ключ. */
  @Get('gateway/checkout/status')
  async checkoutStatus(@Query('payment') paymentId: string) {
    return this.billing.status(paymentId);
  }
}
