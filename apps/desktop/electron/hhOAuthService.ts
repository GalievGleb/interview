import fs from 'fs';
import path from 'path';
import http from 'http';
import { URL } from 'url';
import { safeStorage, shell } from 'electron';

// ─── Константы HH OAuth ────────────────────────────────────────────────────

const HH_AUTH_URL = 'https://hh.ru/oauth/authorize';
const HH_TOKEN_URL = 'https://hh.ru/oauth/token';
const HH_API_BASE = 'https://api.hh.ru';

// Пользователь должен зарегистрировать приложение на https://dev.hh.ru/
// и получить client_id + client_secret.
// redirect_uri: для desktop-приложения используем локальный http-сервер
// на случайном порту, который ловит редирект с code.
const DEFAULT_REDIRECT_PORT = 17_285;

// ─── Типы ───────────────────────────────────────────────────────────────────

export interface HhOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectPort: number;
}

export interface HhTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix-ms
}

export interface HhOAuthState {
  connected: boolean;
  email: string | null;
  name: string | null;
  employerId: string | null;
  expiresAt: number | null;
  error: string | null;
}

export interface HhResume {
  id: string;
  title: string;
  url: string;
  updatedAt: string;
}

export interface HhNegotiation {
  id: string;
  vacancyId: string;
  vacancyTitle: string;
  vacancyUrl: string;
  companyName: string;
  state: string; // 'response' | 'discussion' | 'employer_interested' | 'offer' | 'refusal' | etc.
  hasNewMessages: boolean;
  messagesUnread: number;
  updatedAt: string;
}

export interface HhChatMessage {
  id: string;
  text: string;
  author: 'me' | 'them';
  createdAt: string;
  read: boolean;
}

// ─── Хранилище ──────────────────────────────────────────────────────────────

interface PersistedHhAuth {
  config: HhOAuthConfig;
  tokens: HhTokens | null;
}

function oauthStatePath(userDataDir: string): string {
  return path.join(userDataDir, 'hh-oauth.json');
}

// ─── Сервис ─────────────────────────────────────────────────────────────────

export class HhOAuthService {
  private readonly userDataDir: string;
  private config: HhOAuthConfig;
  private tokens: HhTokens | null = null;
  private authServer: http.Server | null = null;
  private authPromise: Promise<HhTokens> | null = null;
  private authResolve: ((tokens: HhTokens) => void) | null = null;
  private authReject: ((err: Error) => void) | null = null;

  constructor(userDataDir: string) {
    this.userDataDir = userDataDir;
    const persisted = this.load();
    this.config = persisted?.config ?? {
      clientId: '',
      clientSecret: '',
      redirectPort: DEFAULT_REDIRECT_PORT,
    };
    this.tokens = persisted?.tokens ?? null;
  }

  // ─── Публичные методы ──────────────────────────────────────────────────

  getState(): HhOAuthState {
    return {
      connected: this.tokens !== null && this.tokens.expiresAt > Date.now(),
      email: null,
      name: null,
      employerId: null,
      expiresAt: this.tokens?.expiresAt ?? null,
      error: null,
    };
  }

  getConfig(): HhOAuthConfig {
    return { ...this.config };
  }

  saveConfig(partial: Partial<HhOAuthConfig>): HhOAuthConfig {
    this.config = { ...this.config, ...partial };
    this.persist();
    return this.getConfig();
  }

  /** Запускает OAuth flow: открывает браузер, ждёт редирект с code. */
  async startAuth(): Promise<HhTokens> {
    if (!this.config.clientId || !this.config.clientSecret) {
      throw new Error(
        'Сначала укажите client_id и client_secret приложения HH.\n' +
          'Зарегистрируйте приложение на https://dev.hh.ru/',
      );
    }

    // Если уже есть активный процесс — отменяем
    this.cancelAuth();

    this.authPromise = new Promise<HhTokens>((resolve, reject) => {
      this.authResolve = resolve;
      this.authReject = reject;
    });

    // Запускаем локальный сервер для перехвата редиректа
    await this.startRedirectServer();

    // Открываем HH в браузере
    const authUrl = this.buildAuthUrl();
    void shell.openExternal(authUrl);

    return this.authPromise;
  }

  /** Обменять code на токены (можно вызвать вручную, если редирект не сработал). */
  async exchangeCode(code: string): Promise<HhTokens> {
    const tokens = await this.requestTokens({ code });
    this.tokens = tokens;
    this.persist();
    return tokens;
  }

  /** Обновить access_token через refresh_token. */
  async refreshTokens(): Promise<HhTokens | null> {
    if (!this.tokens?.refreshToken) return null;
    try {
      const tokens = await this.requestTokens({ refreshToken: this.tokens.refreshToken });
      this.tokens = tokens;
      this.persist();
      return tokens;
    } catch {
      this.tokens = null;
      this.persist();
      return null;
    }
  }

  /** Получить действующий access_token (с авто-рефрешем). */
  async getAccessToken(): Promise<string | null> {
    if (!this.tokens) return null;
    if (this.tokens.expiresAt > Date.now() + 30_000) {
      return this.tokens.accessToken;
    }
    const refreshed = await this.refreshTokens();
    return refreshed?.accessToken ?? null;
  }

  /** Сбросить авторизацию. */
  logout(): void {
    this.tokens = null;
    this.persist();
  }

  dispose(): void {
    this.cancelAuth();
  }

  // ─── HH API-запросы (с авторизацией) ───────────────────────────────────

  private async hhApi<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const token = await this.getAccessToken();
    if (!token) throw new Error('Не авторизован в HH. Выполните вход.');

    const url = `${HH_API_BASE}${endpoint}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'SkillCue/1.0 (interview-copilot@skillcue.ru)',
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HH API ${res.status}: ${body.slice(0, 300)}`);
    }

    return res.json() as Promise<T>;
  }

  /** Получить список резюме текущего пользователя. */
  async getResumes(): Promise<HhResume[]> {
    const data = await this.hhApi<{ items: Array<{ id: string; title: string; alternate_url: string; updated_at: string }> }>(
      '/resumes/mine',
    );
    return data.items.map((item) => ({
      id: item.id,
      title: item.title,
      url: item.alternate_url,
      updatedAt: item.updated_at,
    }));
  }

  /** Получить список переговоров (откликов + чатов). */
  async getNegotiations(): Promise<HhNegotiation[]> {
    const data = await this.hhApi<{
      items: Array<{
        id: string;
        vacancy: { id: string; name: string; alternate_url: string; employer?: { name: string } };
        state: { id: string; name: string };
        has_updates: boolean;
        messages_unread: number;
        updated_at: string;
      }>;
    }>('/negotiations?per_page=50&order_by=updated_at');

    return data.items.map((item) => ({
      id: String(item.id),
      vacancyId: String(item.vacancy?.id ?? ''),
      vacancyTitle: item.vacancy?.name ?? '',
      vacancyUrl: item.vacancy?.alternate_url ?? '',
      companyName: item.vacancy?.employer?.name ?? '',
      state: item.state?.id ?? 'unknown',
      hasNewMessages: Boolean(item.has_updates),
      messagesUnread: item.messages_unread ?? 0,
      updatedAt: item.updated_at,
    }));
  }

  /** Получить сообщения в переговорах. */
  async getMessages(negotiationId: string): Promise<HhChatMessage[]> {
    const data = await this.hhApi<{
      items: Array<{
        id: string;
        text: string;
        author: { participant_type: string };
        created_at: string;
        read: boolean;
      }>;
    }>(`/negotiations/${negotiationId}/messages`);

    return data.items.map((msg) => ({
      id: msg.id,
      text: msg.text ?? '',
      author: msg.author?.participant_type === 'applicant' ? 'me' : 'them',
      createdAt: msg.created_at,
      read: msg.read,
    }));
  }

  /** Отправить сообщение в переговоры. */
  async sendMessage(negotiationId: string, text: string): Promise<void> {
    await this.hhApi(`/negotiations/${negotiationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message: text }),
    });
  }

  /** Откликнуться на вакансию через API (с письмом и выбором резюме). */
  async applyToVacancy(
    vacancyId: string,
    resumeId: string,
    coverLetter?: string,
  ): Promise<{ negotiationId: string }> {
    const body: Record<string, unknown> = {
      vacancy_id: vacancyId,
      resume_id: resumeId,
    };
    if (coverLetter) {
      body.message = coverLetter;
    }
    return this.hhApi('/negotiations', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /** Получить информацию о текущем пользователе. */
  async getMe(): Promise<{ email: string; name: string }> {
    return this.hhApi<{ email: string; first_name: string; last_name: string }>('/me').then(
      (data) => ({
        email: data.email,
        name: `${data.first_name ?? ''} ${data.last_name ?? ''}`.trim(),
      }),
    );
  }

  // ─── Приватные методы ─────────────────────────────────────────────────

  private load(): PersistedHhAuth | null {
    try {
      const raw = fs.readFileSync(oauthStatePath(this.userDataDir), 'utf8');
      // Migrate from the legacy plaintext format to an encrypted blob. If the
      // file holds a JSON object, transparently rewrite it encrypted once.
      const parsed = JSON.parse(raw) as PersistedHhAuth | { __encrypted: string };
      if ('__encrypted' in parsed && typeof parsed.__encrypted === 'string') {
        return JSON.parse(safeStorage.decryptString(Buffer.from(parsed.__encrypted, 'base64'))) as PersistedHhAuth;
      }
      return parsed as PersistedHhAuth;
    } catch {
      return null;
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(oauthStatePath(this.userDataDir)), { recursive: true });
      const value: PersistedHhAuth = { config: this.config, tokens: this.tokens };
      if (safeStorage.isEncryptionAvailable()) {
        const encrypted = safeStorage.encryptString(JSON.stringify(value)).toString('base64');
        fs.writeFileSync(oauthStatePath(this.userDataDir), JSON.stringify({ __encrypted: encrypted }), 'utf8');
      } else {
        // No OS keystore (e.g. CI/headless). Fall back to plaintext and log it —
        // the alternative is losing OAuth state entirely on every restart.
        console.warn('[hh-oauth] safeStorage unavailable — tokens stored unencrypted');
        fs.writeFileSync(oauthStatePath(this.userDataDir), JSON.stringify(value, null, 2), 'utf8');
      }
    } catch (error) {
      console.warn('[hh-oauth] persist failed:', error);
    }
  }

  private buildAuthUrl(): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: `http://127.0.0.1:${this.config.redirectPort}/callback`,
      state: crypto.randomUUID(),
    });
    return `${HH_AUTH_URL}?${params.toString()}`;
  }

  private async requestTokens(
    params: { code: string } | { refreshToken: string },
  ): Promise<HhTokens> {
    const body = new URLSearchParams();
    body.set('grant_type', 'code' in params ? 'authorization_code' : 'refresh_token');
    body.set('client_id', this.config.clientId);
    body.set('client_secret', this.config.clientSecret);

    if ('code' in params) {
      body.set('code', params.code);
      body.set('redirect_uri', `http://127.0.0.1:${this.config.redirectPort}/callback`);
    } else {
      body.set('refresh_token', params.refreshToken);
    }

    const res = await fetch(HH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'SkillCue/1.0 (interview-copilot@skillcue.ru)',
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`HH OAuth token error ${res.status}: ${errBody.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000 - 60_000, // 1 мин запас
    };
  }

  private async startRedirectServer(): Promise<void> {
    await this.stopRedirectServer();

    return new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const parsed = new URL(req.url ?? '/', `http://127.0.0.1:${this.config.redirectPort}`);

        if (parsed.pathname === '/callback') {
          const code = parsed.searchParams.get('code');
          const error = parsed.searchParams.get('error');

          if (error) {
            const desc = parsed.searchParams.get('error_description') ?? error;
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.callbackHtml(false, desc));
            this.reject(new Error(`HH OAuth error: ${desc}`));
            return;
          }

          if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.callbackHtml(false, 'Код авторизации не получен.'));
            this.reject(new Error('No authorization code received'));
            return;
          }

          // Успех — обмениваем code на токены
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.callbackHtml(true, 'Авторизация успешна! Можете закрыть эту страницу.'));

          this.requestTokens({ code })
            .then((tokens) => {
              this.tokens = tokens;
              this.persist();
              this.resolve(tokens);
            })
            .catch((err) => {
              this.reject(err);
            })
            .finally(() => {
              void this.stopRedirectServer();
            });
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      });

      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // Порт занят — пробуем следующий
          this.config.redirectPort += 1;
          this.persist();
          this.startRedirectServer().then(resolve).catch(reject);
        } else {
          reject(err);
        }
      });

      server.listen(this.config.redirectPort, '127.0.0.1', () => {
        this.authServer = server;
        resolve();
      });
    });
  }

  private async stopRedirectServer(): Promise<void> {
    if (this.authServer) {
      return new Promise<void>((resolve) => {
        this.authServer!.close(() => {
          this.authServer = null;
          resolve();
        });
      });
    }
  }

  private cancelAuth(): void {
    if (this.authReject) {
      this.authReject(new Error('Авторизация отменена'));
      this.authReject = null;
      this.authResolve = null;
      this.authPromise = null;
    }
    void this.stopRedirectServer();
  }

  private resolve(tokens: HhTokens): void {
    this.authResolve?.(tokens);
    this.authResolve = null;
    this.authReject = null;
    this.authPromise = null;
  }

  private reject(err: Error): void {
    this.authReject?.(err);
    this.authResolve = null;
    this.authReject = null;
    this.authPromise = null;
  }

  private callbackHtml(success: boolean, message: string): string {
    const color = success ? '#10b981' : '#ef4444';
    const icon = success ? '✅' : '❌';
    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>SkillCue — HH Авторизация</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0f1117; color: #e5e7eb; }
    .card { text-align: center; padding: 40px; border-radius: 16px; border: 1px solid #1f2937; background: #161b22; max-width: 400px; }
    .icon { font-size: 48px; }
    h1 { color: ${color}; margin: 16px 0 8px; font-size: 20px; }
    p { color: #9ca3af; font-size: 14px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${success ? 'Готово!' : 'Ошибка'}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
  }
}