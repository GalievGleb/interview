import { useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  Check,
  CircleAlert,
  ExternalLink,
  FilePenLine,
  Loader2,
  LogIn,
  LogOut,
  MessageCircle,
  MonitorUp,
  Play,
  Save,
  Search,
  Send,
  SkipForward,
  StopCircle,
  X,
  Zap,
} from 'lucide-react';
import type {
  HhAssistantConfig,
  HhAssistantState,
  HhChatConfig,
  HhChatState,
  HhOAuthConfig,
  HhOAuthState,
  HhQueueItem,
  HhQueueStatus,
} from '../types/electron';

const STATUS_LABELS: Record<HhQueueStatus, string> = {
  new: 'Новая',
  opened: 'Открыта',
  prepared: 'Письмо готово',
  sent: 'Отправлено',
  skipped: 'Пропущена',
};

const STATUS_STYLES: Record<HhQueueStatus, string> = {
  new: 'border-surface-border bg-surface-elevated text-ink-muted',
  opened: 'border-blue-500/25 bg-blue-500/10 text-blue-300',
  prepared: 'border-amber-500/25 bg-amber-500/10 text-amber-200',
  sent: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
  skipped: 'border-surface-border bg-surface text-ink-faint',
};

const EMPTY_CONFIG: HhAssistantConfig = {
  query: '',
  area: '113',
  experience: '',
  employment: 'full',
  schedule: '',
  salaryFrom: null,
  onlyWithSalary: false,
  excludedKeywords: [],
  excludedEmployers: [],
  maxQueueSize: 30,
  maxPages: 2,
  coverLetterTemplate:
    'Здравствуйте! Меня заинтересовала вакансия «{vacancy}» в {company}. Буду рад обсудить мой релевантный опыт и задачи команды на интервью.',
  autoSend: true,
  resumeTitleContains: '',
  delayBetweenSec: 20,
  dailyLimit: 50,
  autoRunDaily: false,
  autoRunHour: 10,
};

type QueueFilter = 'active' | 'sent' | 'skipped' | 'all';

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function countByStatus(queue: HhQueueItem[], status: HhQueueStatus): number {
  return queue.filter((item) => item.status === status).length;
}

export default function HhApplicationsPage() {
  const assistant = window.electronAPI?.hhAssistant;
  const hhOAuth = window.electronAPI?.hhOAuth;
  const hhChat = window.electronAPI?.hhChat;
  const [state, setState] = useState<HhAssistantState | null>(null);
  const [draft, setDraft] = useState<HhAssistantConfig>(EMPTY_CONFIG);
  const [excludedKeywords, setExcludedKeywords] = useState('');
  const [excludedEmployers, setExcludedEmployers] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<QueueFilter>('active');

  // OAuth state
  const [oauthState, setOAuthState] = useState<HhOAuthState | null>(null);
  const [oauthConfig, setOAuthConfig] = useState<HhOAuthConfig>({
    clientId: '',
    clientSecret: '',
    redirectPort: 17285,
  });
  const [oauthLoading, setOAuthLoading] = useState(false);
  const [loginValue, setLoginValue] = useState('');
  const [passwordValue, setPasswordValue] = useState('');
  const [loginMessage, setLoginMessage] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);

  // Chat state
  const [chatState, setChatState] = useState<HhChatState | null>(null);
  const [chatConfig, setChatConfig] = useState<HhChatConfig>({
    enabled: false,
    pollIntervalSec: 60,
    dailyReplyLimit: 20,
    replyDelaySec: 15,
    replyPrompt: '',
    onlyDiscussions: true,
    minMessageLength: 15,
    ignoredKeywords: 'отказ, не готовы, закрыли, другой кандидат',
  });

  useEffect(() => {
    if (!assistant) return;
    let active = true;
    void assistant.getState().then((next) => {
      if (!active || !next) return;
      setState(next);
      setDraft(next.config);
      setExcludedKeywords(next.config.excludedKeywords.join(', '));
      setExcludedEmployers(next.config.excludedEmployers.join(', '));
    });
    const unsubscribe = assistant.onState((next) => {
      if (!active) return;
      setState(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [assistant]);

  // Load OAuth state
  useEffect(() => {
    if (!hhOAuth) return;
    void hhOAuth.getState().then((s) => {
      if (s) setOAuthState(s);
    });
    void hhOAuth.getConfig().then((c) => {
      if (c) setOAuthConfig(c);
    });
  }, [hhOAuth]);

  // Load Chat state
  useEffect(() => {
    if (!hhChat) return;
    void hhChat.getState().then((s) => {
      if (s) setChatState(s);
    });
    void hhChat.getConfig().then((c) => {
      if (c) setChatConfig(c);
    });
  }, [hhChat]);

  const visibleQueue = useMemo(() => {
    const queue = state?.queue ?? [];
    if (filter === 'all') return queue;
    if (filter === 'active') {
      return queue.filter((item) => !['sent', 'skipped'].includes(item.status));
    }
    return queue.filter((item) => item.status === filter);
  }, [filter, state?.queue]);

  const run = async (key: string, action: () => Promise<HhAssistantState>) => {
    setBusy(key);
    try {
      const next = await action();
      if (next) setState(next);
    } finally {
      setBusy(null);
    }
  };

  const currentConfig = (): HhAssistantConfig => ({
    ...draft,
    excludedKeywords: splitList(excludedKeywords),
    excludedEmployers: splitList(excludedEmployers),
  });

  const save = async () => {
    if (!assistant) return;
    await run('save', async () => {
      const next = await assistant.saveConfig(currentConfig());
      setDraft(next.config);
      return next;
    });
  };

  const scan = async () => {
    if (!assistant) return;
    await run('scan', async () => {
      await assistant.saveConfig(currentConfig());
      return assistant.scan();
    });
  };

  if (!assistant) {
    return (
      <div className="panel-card mx-auto max-w-xl p-8 text-center">
        <MonitorUp className="mx-auto mb-4 text-ink-muted" size={28} />
        <h1 className="page-title">Отклики доступны в desktop-приложении</h1>
        <p className="page-subtitle mt-2">
          Браузерный помощник запускается из Electron и не работает в обычной веб-версии.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-emerald-300">
            <span className="sc-dot sc-dot--live" />
            Браузерный помощник HH
          </div>
          <h1 className="page-title text-2xl">Очередь откликов</h1>
          <p className="page-subtitle mt-2">
            SkillCue сам собирает вакансии, открывает HH, выбирает резюме, заполняет письмо
            и подтверждает отклик. Вы только один раз настраиваете фильтры — дальше всё
            происходит без вашего участия.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy !== null}
            onClick={() =>
              void run(
                state?.browserOpen ? 'close' : 'browser',
                () =>
                  state?.browserOpen
                    ? assistant.closeBrowser()
                    : assistant.openBrowser(),
              )
            }
          >
            {busy === 'browser' || busy === 'close' ? (
              <Loader2 className="animate-spin" size={16} />
            ) : state?.browserOpen ? (
              <X size={16} />
            ) : (
              <ExternalLink size={16} />
            )}
            {state?.browserOpen ? 'Закрыть браузер' : 'Открыть HH'}
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy !== null || !draft.query.trim() || state?.applying}
            onClick={() => void scan()}
          >
            {busy === 'scan' ? (
              <Loader2 className="animate-spin" size={16} />
            ) : (
              <Search size={16} />
            )}
            Собрать вакансии
          </button>
          {state?.applying ? (
            <button
              type="button"
              className="btn-secondary border-red-500/40 text-red-200"
              onClick={() => void run('stop', () => assistant.stopApply())}
            >
              <StopCircle size={16} />
              Остановить
              {state.applyProgress
                ? ` (${state.applyProgress.done}/${state.applyProgress.total})`
                : ''}
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary"
              disabled={busy !== null || !draft.query.trim()}
              onClick={() =>
                void run('applyAll', async () => {
                  await assistant.saveConfig(currentConfig());
                  return assistant.applyAll();
                })
              }
            >
              {busy === 'applyAll' ? (
                <Loader2 className="animate-spin" size={16} />
              ) : (
                <Zap size={16} />
              )}
              Откликнуться на все
            </button>
          )}
        </div>
      </header>

      {state?.message && (
        <div
          className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${
            state.phase === 'error'
              ? 'border-red-500/25 bg-red-500/10 text-red-200'
              : state.phase === 'manual_required'
                ? 'border-amber-500/25 bg-amber-500/10 text-amber-100'
                : 'border-surface-border bg-surface-light text-ink-muted'
          }`}
          role="status"
        >
          {state.phase === 'manual_required' || state.phase === 'error' ? (
            <CircleAlert className="mt-0.5 shrink-0" size={16} />
          ) : (
            <span className="sc-dot sc-dot--live mt-1.5 shrink-0" />
          )}
          <span>{state.message}</span>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
        <aside className="panel-card h-fit overflow-hidden">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">Фильтры поиска</h2>
              <p className="mt-0.5 text-xs text-ink-faint">Настройки сохраняются локально</p>
            </div>
          </div>
          <div className="space-y-4 p-4">
            <label className="block">
              <span className="label">Должность или специализация</span>
              <input
                className="field"
                value={draft.query}
                onChange={(event) => setDraft({ ...draft, query: event.target.value })}
                placeholder="QA Automation Engineer"
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="label">Регион</span>
                <select
                  className="field"
                  value={draft.area}
                  onChange={(event) => setDraft({ ...draft, area: event.target.value })}
                >
                  <option value="113">Россия</option>
                  <option value="1">Москва</option>
                  <option value="2">Санкт-Петербург</option>
                </select>
              </label>
              <label className="block">
                <span className="label">Опыт</span>
                <select
                  className="field"
                  value={draft.experience}
                  onChange={(event) =>
                    setDraft({ ...draft, experience: event.target.value })
                  }
                >
                  <option value="">Любой</option>
                  <option value="noExperience">Нет опыта</option>
                  <option value="between1And3">1–3 года</option>
                  <option value="between3And6">3–6 лет</option>
                  <option value="moreThan6">Более 6 лет</option>
                </select>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="label">Формат</span>
                <select
                  className="field"
                  value={draft.schedule}
                  onChange={(event) => setDraft({ ...draft, schedule: event.target.value })}
                >
                  <option value="">Любой</option>
                  <option value="remote">Удалённо</option>
                  <option value="fullDay">Полный день</option>
                  <option value="flexible">Гибкий график</option>
                </select>
              </label>
              <label className="block">
                <span className="label">Зарплата от</span>
                <input
                  className="field"
                  type="number"
                  min={0}
                  step={10_000}
                  value={draft.salaryFrom ?? ''}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      salaryFrom: event.target.value ? Number(event.target.value) : null,
                    })
                  }
                  placeholder="150000"
                />
              </label>
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-muted">
              <input
                type="checkbox"
                checked={draft.onlyWithSalary}
                onChange={(event) =>
                  setDraft({ ...draft, onlyWithSalary: event.target.checked })
                }
                className="h-4 w-4 accent-emerald-500"
              />
              Только с указанной зарплатой
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="label">Вакансий в очереди</span>
                <input
                  className="field"
                  type="number"
                  min={5}
                  max={100}
                  value={draft.maxQueueSize}
                  onChange={(event) =>
                    setDraft({ ...draft, maxQueueSize: Number(event.target.value) })
                  }
                />
              </label>
              <label className="block">
                <span className="label">Страниц поиска</span>
                <input
                  className="field"
                  type="number"
                  min={1}
                  max={5}
                  value={draft.maxPages}
                  onChange={(event) =>
                    setDraft({ ...draft, maxPages: Number(event.target.value) })
                  }
                />
              </label>
            </div>

            <label className="block">
              <span className="label">Резюме (подстрока названия)</span>
              <input
                className="field"
                value={draft.resumeTitleContains}
                onChange={(event) =>
                  setDraft({ ...draft, resumeTitleContains: event.target.value })
                }
                placeholder="Например: QA Automation"
              />
            </label>

            <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3.5">
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-ink">
                <input
                  type="checkbox"
                  checked={draft.autoSend}
                  onChange={(event) =>
                    setDraft({ ...draft, autoSend: event.target.checked })
                  }
                  className="h-4 w-4 accent-emerald-500"
                />
                Полный авто-отклик
              </label>
              <p className="mt-1 text-xs leading-relaxed text-ink-faint">
                SkillCue сам жмёт «Откликнуться», выбирает резюме и подтверждает отправку.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="label">Пауза между, сек</span>
                <input
                  className="field"
                  type="number"
                  min={5}
                  max={120}
                  value={draft.delayBetweenSec}
                  onChange={(event) =>
                    setDraft({ ...draft, delayBetweenSec: Number(event.target.value) })
                  }
                />
              </label>
              <label className="block">
                <span className="label">Лимит в день</span>
                <input
                  className="field"
                  type="number"
                  min={1}
                  max={200}
                  value={draft.dailyLimit}
                  onChange={(event) =>
                    setDraft({ ...draft, dailyLimit: Number(event.target.value) })
                  }
                />
              </label>
            </div>

            <div className="rounded-xl border border-surface-border bg-surface px-3.5 py-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-ink">
                <input
                  type="checkbox"
                  checked={draft.autoRunDaily}
                  onChange={(event) =>
                    setDraft({ ...draft, autoRunDaily: event.target.checked })
                  }
                  className="h-4 w-4 accent-emerald-500"
                />
                <CalendarClock size={15} className="text-ink-muted" />
                Ежедневный авто-прогон
              </label>
              <div className="mt-2.5 flex items-center gap-2 pl-6">
                <span className="text-xs text-ink-faint">в</span>
                <input
                  className="field w-20"
                  type="number"
                  min={0}
                  max={23}
                  disabled={!draft.autoRunDaily}
                  value={draft.autoRunHour}
                  onChange={(event) =>
                    setDraft({ ...draft, autoRunHour: Number(event.target.value) })
                  }
                />
                <span className="text-xs text-ink-faint">:00 · до {draft.dailyLimit} откликов</span>
              </div>
            </div>

            <details className="group rounded-xl border border-surface-border bg-surface px-3.5 py-3">
              <summary className="cursor-pointer select-none text-sm font-medium text-ink">
                Исключения и письмо
              </summary>
              <div className="mt-4 space-y-4">
                <label className="block">
                  <span className="label">Исключить слова в названии</span>
                  <input
                    className="field"
                    value={excludedKeywords}
                    onChange={(event) => setExcludedKeywords(event.target.value)}
                    placeholder="стажёр, продажи"
                  />
                </label>
                <label className="block">
                  <span className="label">Исключить компании</span>
                  <input
                    className="field"
                    value={excludedEmployers}
                    onChange={(event) => setExcludedEmployers(event.target.value)}
                    placeholder="через запятую"
                  />
                </label>
                <label className="block">
                  <span className="label">
                    Шаблон письма · {'{vacancy}'} · {'{company}'}
                  </span>
                  <textarea
                    className="field min-h-32 resize-y leading-relaxed"
                    value={draft.coverLetterTemplate}
                    onChange={(event) =>
                      setDraft({ ...draft, coverLetterTemplate: event.target.value })
                    }
                  />
                </label>
              </div>
            </details>

            <button
              type="button"
              className="btn-secondary w-full"
              disabled={busy !== null}
              onClick={() => void save()}
            >
              {busy === 'save' ? (
                <Loader2 className="animate-spin" size={16} />
              ) : (
                <Save size={16} />
              )}
              Сохранить настройки
            </button>
          </div>

          {/* ─── Вход по телефону/почте ─── */}
          {assistant && (
            <div className="border-t border-surface-border p-4">
              <div className="mb-3 flex items-center gap-2">
                <LogIn size={16} className="text-ink-muted" />
                <h3 className="text-sm font-semibold text-ink">
                  Вход по телефону/почте
                </h3>
              </div>

              <div className="space-y-3">
                <label className="block">
                  <span className="label">Телефон или почта</span>
                  <input
                    className="field"
                    value={loginValue}
                    onChange={(e) => setLoginValue(e.target.value)}
                    placeholder="+7 (999) 123-45-67 или email@mail.ru"
                    disabled={loginBusy}
                  />
                </label>
                <label className="block">
                  <span className="label">Пароль</span>
                  <input
                    className="field"
                    type="password"
                    value={passwordValue}
                    onChange={(e) => setPasswordValue(e.target.value)}
                    placeholder="••••••••"
                    disabled={loginBusy}
                  />
                </label>

                {loginMessage && (
                  <div
                    className={`rounded-lg px-3 py-2 text-xs ${
                      loginMessage.includes('успешно')
                        ? 'bg-emerald-500/10 text-emerald-200'
                        : 'bg-amber-500/10 text-amber-200'
                    }`}
                  >
                    {loginMessage}
                  </div>
                )}

                <button
                  type="button"
                  className="btn-primary btn-sm w-full"
                  disabled={loginBusy || !loginValue.trim() || !passwordValue.trim()}
                  onClick={async () => {
                    if (!assistant) return;
                    setLoginBusy(true);
                    setLoginMessage('');
                    const result = await assistant.login(
                      loginValue.trim(),
                      passwordValue,
                    );
                    setLoginMessage(result.message);
                    setLoginBusy(false);
                    // Обновляем состояние
                    if (result.ok) {
                      setState(await assistant.getState());
                    }
                  }}
                >
                  {loginBusy ? (
                    <Loader2 className="animate-spin" size={14} />
                  ) : (
                    <LogIn size={14} />
                  )}
                  Войти в HH
                </button>

                <p className="text-[11px] leading-relaxed text-ink-faint">
                  Вход происходит автоматически через открытый браузер HH.
                  Пароль не сохраняется.
                </p>
              </div>
            </div>
          )}

          {/* ─── OAuth-секция ─── */}
          {hhOAuth && (
            <div className="border-t border-surface-border p-4">
              <div className="mb-3 flex items-center gap-2">
                <LogIn size={16} className="text-ink-muted" />
                <h3 className="text-sm font-semibold text-ink">Авторизация HH</h3>
                {oauthState?.connected && (
                  <span className="sc-dot sc-dot--live ml-auto" />
                )}
              </div>

              {oauthState?.connected ? (
                <div className="space-y-2">
                  <div className="rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                    Подключено · Токен активен
                  </div>
                  <button
                    type="button"
                    className="btn-ghost btn-sm w-full text-red-300"
                    disabled={oauthLoading}
                    onClick={async () => {
                      setOAuthLoading(true);
                      await hhOAuth.logout();
                      setOAuthState(await hhOAuth.getState());
                      setOAuthLoading(false);
                    }}
                  >
                    <LogOut size={14} />
                    Выйти из HH
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <label className="block">
                    <span className="label">Client ID</span>
                    <input
                      className="field"
                      value={oauthConfig.clientId}
                      onChange={(e) =>
                        setOAuthConfig({ ...oauthConfig, clientId: e.target.value })
                      }
                      placeholder="Из dev.hh.ru"
                    />
                  </label>
                  <label className="block">
                    <span className="label">Client Secret</span>
                    <input
                      className="field"
                      type="password"
                      value={oauthConfig.clientSecret}
                      onChange={(e) =>
                        setOAuthConfig({ ...oauthConfig, clientSecret: e.target.value })
                      }
                      placeholder="••••••••"
                    />
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn-ghost btn-sm flex-1"
                      disabled={oauthLoading}
                      onClick={async () => {
                        await hhOAuth.saveConfig(oauthConfig);
                      }}
                    >
                      <Save size={14} />
                      Сохранить
                    </button>
                    <button
                      type="button"
                      className="btn-primary btn-sm flex-1"
                      disabled={oauthLoading || !oauthConfig.clientId}
                      onClick={async () => {
                        setOAuthLoading(true);
                        const result = await hhOAuth.startAuth();
                        if (!result.ok) {
                          alert(result.error);
                        }
                        setOAuthState(await hhOAuth.getState());
                        setOAuthLoading(false);
                      }}
                    >
                      {oauthLoading ? (
                        <Loader2 className="animate-spin" size={14} />
                      ) : (
                        <LogIn size={14} />
                      )}
                      Войти через HH
                    </button>
                  </div>
                  <p className="text-[11px] leading-relaxed text-ink-faint">
                    Зарегистрируйте приложение на{' '}
                    <a
                      href="https://dev.hh.ru/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-emerald-400 underline"
                      onClick={(e) => {
                        e.preventDefault();
                        void window.electronAPI?.openExternal('https://dev.hh.ru/');
                      }}
                    >
                      dev.hh.ru
                    </a>
                    , указав redirect_uri:{' '}
                    <code className="rounded bg-surface px-1 text-emerald-300">
                      http://127.0.0.1:{oauthConfig.redirectPort}/callback
                    </code>
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ─── Chat-секция ─── */}
          {hhChat && (
            <div className="border-t border-surface-border p-4">
              <div className="mb-3 flex items-center gap-2">
                <MessageCircle size={16} className="text-ink-muted" />
                <h3 className="text-sm font-semibold text-ink">Авто-ответы в чат</h3>
                {chatState?.enabled && (
                  <span className="sc-dot sc-dot--live ml-auto" />
                )}
              </div>

              <div className="space-y-3">
                <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-emerald-500"
                    checked={chatConfig.enabled}
                    onChange={async (e) => {
                      const next = { ...chatConfig, enabled: e.target.checked };
                      setChatConfig(next);
                      await hhChat.saveConfig(next);
                      setChatState(await hhChat.getState());
                    }}
                  />
                  Включить авто-ответы
                </label>

                {chatConfig.enabled && (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block">
                        <span className="label">Проверка, сек</span>
                        <input
                          className="field"
                          type="number"
                          min={30}
                          max={600}
                          value={chatConfig.pollIntervalSec}
                          onChange={(e) =>
                            setChatConfig({
                              ...chatConfig,
                              pollIntervalSec: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                      <label className="block">
                        <span className="label">Лимит в день</span>
                        <input
                          className="field"
                          type="number"
                          min={1}
                          max={50}
                          value={chatConfig.dailyReplyLimit}
                          onChange={(e) =>
                            setChatConfig({
                              ...chatConfig,
                              dailyReplyLimit: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                    </div>

                    <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-muted">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-emerald-500"
                        checked={chatConfig.onlyDiscussions}
                        onChange={(e) =>
                          setChatConfig({
                            ...chatConfig,
                            onlyDiscussions: e.target.checked,
                          })
                        }
                      />
                      Только чаты (не отклики)
                    </label>

                    {chatState && (
                      <div className="rounded-lg bg-surface-light px-3 py-2 text-xs text-ink-muted">
                        {chatState.polling
                          ? 'Активен · проверка чатов…'
                          : 'Ожидание следующей проверки'}
                        {chatState.repliesToday > 0 &&
                          ` · ответов сегодня: ${chatState.repliesToday}`}
                      </div>
                    )}

                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="btn-ghost btn-sm flex-1"
                        onClick={async () => {
                          await hhChat.saveConfig(chatConfig);
                        }}
                      >
                        <Save size={14} />
                        Сохранить
                      </button>
                      <button
                        type="button"
                        className="btn-secondary btn-sm flex-1"
                        onClick={async () => {
                          setChatState(await hhChat.pollNow());
                        }}
                      >
                        <Play size={14} />
                        Проверить сейчас
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </aside>

        <section className="panel-card min-w-0 overflow-hidden">
          <div className="panel-header flex-wrap gap-3">
            <div>
              <h2 className="panel-title">Найденные вакансии</h2>
              <p className="mt-0.5 text-xs text-ink-faint">
                {state?.queue.length ?? 0} в очереди ·{' '}
                {countByStatus(state?.queue ?? [], 'sent')} отправлено
              </p>
            </div>
            <div className="segmented">
              {(
                [
                  ['active', 'К работе'],
                  ['sent', 'Отправлены'],
                  ['skipped', 'Пропущены'],
                  ['all', 'Все'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`segmented-item ${
                    filter === value ? 'segmented-item-active' : ''
                  }`}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="max-h-[calc(100vh-275px)] min-h-[360px] overflow-y-auto">
            {visibleQueue.length === 0 ? (
              <div className="flex min-h-[360px] flex-col items-center justify-center px-8 text-center">
                <Search className="mb-4 text-ink-faint" size={28} />
                <h3 className="text-base font-semibold text-ink">
                  {state?.queue.length
                    ? 'В этой группе вакансий нет'
                    : 'Настройте поиск и соберите очередь'}
                </h3>
                <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-muted">
                  SkillCue откроет обычный видимый браузер. Если HH запросит вход,
                  проверку или ответы работодателю, продолжите вручную в этом окне.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-surface-border">
                {visibleQueue.map((vacancy) => (
                  <VacancyRow
                    key={vacancy.id}
                    vacancy={vacancy}
                    busy={busy}
                    applying={Boolean(state?.applying)}
                    onOpen={() =>
                      void run(`open:${vacancy.id}`, () =>
                        assistant.openVacancy(vacancy.id),
                      )
                    }
                    onFill={() =>
                      void run(`fill:${vacancy.id}`, () =>
                        assistant.fillLetter(vacancy.id),
                      )
                    }
                    onApplyOne={() =>
                      void run(`apply:${vacancy.id}`, () =>
                        assistant.applyOne(vacancy.id),
                      )
                    }
                    onMark={(status) =>
                      void run(`mark:${vacancy.id}`, () =>
                        assistant.mark(vacancy.id, status),
                      )
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function VacancyRow({
  vacancy,
  busy,
  applying,
  onOpen,
  onFill,
  onApplyOne,
  onMark,
}: {
  vacancy: HhQueueItem;
  busy: string | null;
  applying: boolean;
  onOpen: () => void;
  onFill: () => void;
  onApplyOne: () => void;
  onMark: (status: 'sent' | 'skipped') => void;
}) {
  const rowBusy = busy?.endsWith(vacancy.id);
  return (
    <article className="group flex flex-wrap items-center gap-4 px-5 py-4 transition-colors hover:bg-surface-hover">
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <h3 className="truncate text-[15px] font-semibold text-ink">{vacancy.title}</h3>
          <span
            className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
              STATUS_STYLES[vacancy.status]
            }`}
          >
            {STATUS_LABELS[vacancy.status]}
          </span>
          {vacancy.status === 'sent' && vacancy.sentAt && (
            <span className="text-[11px] text-ink-faint">
              {new Date(vacancy.sentAt).toLocaleString('ru-RU', {
                day: '2-digit',
                month: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-muted">
          <span>{vacancy.company || 'Компания не указана'}</span>
          {vacancy.salary && <span className="font-medium text-ink">{vacancy.salary}</span>}
        </div>
        {vacancy.reason && vacancy.status === 'skipped' && (
          <p className="mt-1.5 text-xs leading-relaxed text-amber-200">{vacancy.reason}</p>
        )}
      </div>

      {rowBusy ? (
        <Loader2 className="shrink-0 animate-spin text-ink-muted" size={18} />
      ) : (
        <div className="flex shrink-0 items-center gap-1.5">
          {!['sent', 'skipped'].includes(vacancy.status) && (
            <>
              <button
                type="button"
                className="btn-ghost btn-sm"
                disabled={busy !== null}
                onClick={onOpen}
              >
                <ExternalLink size={15} />
                Открыть
              </button>
              <button
                type="button"
                className="btn-ghost btn-sm"
                disabled={busy !== null}
                onClick={onFill}
              >
                <FilePenLine size={15} />
                Письмо
              </button>
              <button
                type="button"
                className="btn-secondary btn-sm"
                disabled={busy !== null || applying}
                onClick={onApplyOne}
              >
                <Send size={15} />
                Откликнуться
              </button>
              <button
                type="button"
                className="btn-ghost btn-sm tip px-2"
                data-tip="Отметить как отправленную"
                aria-label="Отметить как отправленную"
                disabled={busy !== null}
                onClick={() => onMark('sent')}
              >
                <Check size={16} />
              </button>
              <button
                type="button"
                className="btn-ghost btn-sm tip px-2"
                data-tip="Пропустить вакансию"
                aria-label="Пропустить вакансию"
                disabled={busy !== null}
                onClick={() => onMark('skipped')}
              >
                <SkipForward size={16} />
              </button>
            </>
          )}
        </div>
      )}
    </article>
  );
}
