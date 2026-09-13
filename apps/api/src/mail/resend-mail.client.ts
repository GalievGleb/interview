import { Injectable } from '@nestjs/common';

export type AuthMailPurpose = 'verify_email' | 'reset_password';
export type MailFetch = typeof fetch;

export interface ResendMailConfig {
  apiKey: string;
  from: string;
}

function mailCopy(purpose: AuthMailPurpose, code: string) {
  const reset = purpose === 'reset_password';
  const title = reset ? 'Сброс пароля SkillCue' : 'Код подтверждения SkillCue';
  const action = reset ? 'сброса пароля' : 'подтверждения почты';
  return {
    subject: title,
    text: `Код ${action}: ${code}. Он действует 10 минут. Если вы не запрашивали код, проигнорируйте письмо.`,
    html: [
      '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:32px;color:#13202b">',
      '<div style="font-size:24px;font-weight:800;color:#13a86b">SkillCue</div>',
      `<h1 style="font-size:22px;margin:24px 0 8px">${title}</h1>`,
      `<p style="color:#526170">Введите этот код для ${action}:</p>`,
      `<div style="font-size:34px;font-weight:800;letter-spacing:8px;margin:24px 0">${code}</div>`,
      '<p style="color:#526170">Код действует 10 минут. Если вы не запрашивали его, просто проигнорируйте письмо.</p>',
      '</div>',
    ].join(''),
  };
}

@Injectable()
export class ResendMailClient {
  private readonly config: ResendMailConfig;
  private readonly fetcher: MailFetch;

  constructor(config?: ResendMailConfig, fetcher: MailFetch = fetch) {
    this.config = config ?? {
      apiKey: process.env.RESEND_API_KEY ?? '',
      from: process.env.AUTH_MAIL_FROM ?? 'SkillCue <no-reply@skill-cue.ru>',
    };
    this.fetcher = fetcher;
  }

  async sendVerificationCode(
    email: string,
    code: string,
    purpose: AuthMailPurpose,
  ): Promise<void> {
    if (!this.config.apiKey) {
      throw new Error('Transactional email is not configured');
    }
    const copy = mailCopy(purpose, code);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await this.fetcher('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.config.from,
          to: [email],
          subject: copy.subject,
          text: copy.text,
          html: copy.html,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error('Transactional email provider rejected the request');
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'Transactional email provider rejected the request') {
        throw error;
      }
      throw new Error('Transactional email provider is unavailable');
    } finally {
      clearTimeout(timeout);
    }
  }
}
