import type { SessionDetail } from './api';
import type { DebugEvent } from './liveDebugRecorder';

interface ReportAppInfo {
  version: string;
  channel: string;
  platform: string;
}

interface DiagnosticExchange {
  question?: string;
  pipeline?: { model?: string; modelSource?: string };
  latency?: {
    sttLatencyMs?: number | null;
    llmLatencyMs?: number;
    totalLatencyMs?: number;
    breakdown?: { llmFirstTokenMs?: number; llmTotalMs?: number };
  };
}

const MAX_REPORT_CHARS = 900_000;

export function redactSessionReportText(value: string): string {
  return value
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, '%USERPROFILE%')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-(?:or-v1-)?[A-Za-z0-9_-]{20,}/gi, '[REDACTED]')
    .replace(/\bSKILLCUE-[A-Za-z0-9._-]{8,}/gi, '[REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]');
}

function text(value: unknown): string {
  return redactSessionReportText(typeof value === 'string' ? value : String(value ?? ''));
}

function ms(value: number | null | undefined): string {
  return Number.isFinite(value) ? `${Math.round(value as number)} мс` : '—';
}

function escapeCell(value: unknown): string {
  return text(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function diagnosticExchanges(session: SessionDetail): DiagnosticExchange[] {
  const raw = session.diagnostics?.extra?.exchanges;
  return Array.isArray(raw) ? raw as DiagnosticExchange[] : [];
}

function eventDetail(event: DebugEvent): string {
  if (event.reason) return text(event.reason);
  if (event.text) return text(event.text);
  const allowed = ['model', 'engine', 'sampleRate', 'reconnected', 'recoverable', 'sttLatencyMs', 'llmLatencyMs'];
  const values = Object.entries(event.meta ?? {})
    .filter(([key]) => allowed.includes(key))
    .map(([key, value]) => `${key}=${text(value)}`);
  return values.join(', ');
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

export function buildSessionDebugReport(input: {
  session: SessionDetail;
  issue: string;
  app: ReportAppInfo;
}): { filename: string; content: string } {
  const { session, app } = input;
  const diagnostics = session.diagnostics;
  const exchanges = diagnosticExchanges(session);
  const events = diagnostics?.events.slice(0, 500) ?? [];
  const sttReady = events.find((event) => event.type === 'ready' && event.meta?.model);
  const sttModel = typeof sttReady?.meta?.model === 'string' ? sttReady.meta.model : null;
  const llmModels = unique([
    ...session.answers.map((answer) => answer.model),
    ...exchanges.map((exchange) => exchange.pipeline?.model),
  ]);
  const modelSources = unique(exchanges.map((exchange) => exchange.pipeline?.modelSource));
  const latencies = exchanges.map((exchange) => exchange.latency).filter(Boolean);
  const maxStt = Math.max(0, ...latencies.map((value) => value?.sttLatencyMs ?? 0));
  const maxLlm = Math.max(0, ...latencies.map((value) => value?.llmLatencyMs ?? 0));
  const errorEvents = events.filter((event) => event.type === 'error');
  const issue = input.issue.trim() || 'Описание не добавлено.';
  const parts = [
    '# Отчёт SkillCue по сессии',
    '',
    '> Отчёт создан пользователем для диагностики. Секреты и локальное имя пользователя удалены автоматически.',
    '',
    '## Что сломалось',
    '',
    text(issue),
    '',
    '## Приложение',
    '',
    `- SkillCue: \`${escapeCell(app.version)}\` (${escapeCell(app.channel)})`,
    `- Система: \`${escapeCell(app.platform)}\``,
    `- Отчёт создан: ${new Date().toISOString()}`,
    '',
    '## Сессия',
    '',
    `- ID: \`${escapeCell(session.id)}\``,
    `- Название: ${escapeCell(session.title || 'Без названия')}`,
    `- Начало: ${escapeCell(session.started_at)}`,
    `- Конец: ${escapeCell(session.ended_at || 'не зафиксирован')}`,
    `- Реплик: ${session.transcripts.length}; подсказок: ${session.answers.length}`,
    '',
    '## Модели и источники',
    '',
    `- STT: ${sttModel ? `\`${escapeCell(sttModel)}\`` : 'не записано'}`,
    `- LLM: ${llmModels.length ? llmModels.map((model) => `\`${escapeCell(model)}\``).join(', ') : 'не записано'}`
      + (modelSources.length ? ` (${modelSources.map((source) => `\`${escapeCell(source)}\``).join(', ')})` : ''),
    `- Аудиоисточники: ${diagnostics?.extra?.sources ? escapeCell(JSON.stringify(diagnostics.extra.sources)) : 'не записано'}`,
    '',
    '## Быстрый диагноз',
    '',
  ];

  if (!diagnostics) {
    parts.push('Live-тайминг не записывался этой версией SkillCue. Для старой сессии доступны модель, транскрипт и сохранённые подсказки.');
  } else if (latencies.length === 0) {
    parts.push('События live-сессии записаны, но завершённых обменов с полным таймингом нет.');
  } else {
    parts.push(`- Самый медленный этап: ${maxLlm >= maxStt ? 'LLM' : 'STT'} (STT max ${ms(maxStt)}, LLM max ${ms(maxLlm)}).`);
    parts.push(`- Ошибок/переподключений в таймлайне: ${errorEvents.length}.`);
  }

  parts.push('', '## Тайминги ответов', '');
  if (exchanges.length === 0) {
    parts.push('Подробные тайминги ответов отсутствуют.');
  } else {
    parts.push('| # | Вопрос | STT | Первый токен LLM | LLM всего | End-to-end |', '|---:|---|---:|---:|---:|---:|');
    exchanges.forEach((exchange, index) => {
      const latency = exchange.latency;
      parts.push(`| ${index + 1} | ${escapeCell(exchange.question || '—')} | ${ms(latency?.sttLatencyMs)} | ${ms(latency?.breakdown?.llmFirstTokenMs)} | ${ms(latency?.breakdown?.llmTotalMs ?? latency?.llmLatencyMs)} | ${ms(latency?.totalLatencyMs)} |`);
    });
  }

  parts.push('', '## События STT/LLM', '');
  if (events.length === 0) {
    parts.push('Таймлайн отсутствует.');
  } else {
    parts.push('| От старта | Событие | Канал | Детали |', '|---:|---|---|---|');
    events.forEach((event) => {
      parts.push(`| ${event.tMs} мс | ${escapeCell(event.type)} | ${escapeCell(event.speaker ?? '—')} | ${escapeCell(eventDetail(event) || '—')} |`);
    });
  }

  parts.push('', '## Транскрипт', '');
  if (session.transcripts.length === 0) parts.push('Транскрипт пуст.');
  session.transcripts.forEach((line) => {
    const speaker = line.speaker === 'me' ? 'Кандидат' : 'Интервьюер';
    parts.push(`- **${speaker} · ${escapeCell(line.ts)}:** ${text(line.text)}`);
  });

  parts.push('', '## Подсказки SkillCue', '');
  if (session.answers.length === 0) parts.push('Подсказок нет.');
  session.answers.forEach((answer, index) => {
    parts.push(`### ${index + 1}. ${text(answer.question)}`, '', text(answer.spoken || answer.short || 'Пустой ответ'), '');
  });

  const id = session.id.replace(/[^a-z0-9-]/gi, '-').slice(0, 9) || 'session';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return {
    filename: `skillcue-session-${id}-${stamp}.md`,
    content: parts.join('\n').slice(0, MAX_REPORT_CHARS),
  };
}
