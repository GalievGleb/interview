import type { SessionDetail } from './api';
import { sanitizeDiagnosticText, type DebugEvent, type DiagnosticRetention } from './liveDebugRecorder';
import type { ScreenAssistDiagnosticEntry } from './screenAssistDiagnostics';

interface ReportAppInfo { version: string; channel: string; platform: string }

interface DiagnosticExchange {
  question?: string;
  pipeline?: { model?: string; modelSource?: string };
  stt?: {
    utteranceId?: string; source?: string; capturedAtMs?: number;
    speechEndToFinalMs?: number; openaiInferenceMs?: number;
    queueWaitMs?: number; queueDepth?: number;
  };
  latency?: {
    sttLatencyMs?: number | null; llmLatencyMs?: number; totalLatencyMs?: number;
    breakdown?: { finalToAnswerStartMs?: number; llmFirstTokenMs?: number; llmTotalMs?: number };
  };
}

interface SourceHealthRecord {
  requested?: boolean; ready?: boolean; firstSignalAtMs?: number | null;
  firstSpeechAtMs?: number | null; warning?: string | null;
}

const MAX_REPORT_CHARS = 900_000;

export function redactSessionReportText(value: string): string {
  return sanitizeDiagnosticText(value, MAX_REPORT_CHARS)
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

function yesNo(value: boolean | null | undefined): string {
  return value == null ? 'не записано' : value ? 'да' : 'нет';
}

function observed(value: number | null | undefined, schemaVersion: number | undefined): string {
  if (value === undefined) return 'не записано';
  if (value === null) return schemaVersion === 2 ? 'нет' : 'не записано';
  return 'да';
}

function escapeCell(value: unknown): string {
  return text(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function diagnosticExchanges(session: SessionDetail): DiagnosticExchange[] {
  const raw = session.diagnostics?.extra?.exchanges;
  return Array.isArray(raw) ? raw as DiagnosticExchange[] : [];
}

function screenAssists(session: SessionDetail): ScreenAssistDiagnosticEntry[] {
  const raw = session.diagnostics?.extra?.screenAssists;
  return Array.isArray(raw) ? raw as ScreenAssistDiagnosticEntry[] : [];
}

function sourceHealth(session: SessionDetail): Record<string, SourceHealthRecord> {
  const raw = session.diagnostics?.extra?.sourceHealth;
  if (!raw || typeof raw !== 'object') return {};
  const sources = (raw as { sources?: unknown }).sources;
  return sources && typeof sources === 'object'
    ? sources as Record<string, SourceHealthRecord>
    : {};
}

function eventDetail(event: DebugEvent): string {
  const clip = (value: string): string => {
    const safe = text(value);
    return safe.length <= 550 ? safe : `${safe.slice(0, 520)}… [сокращено ${safe.length - 520} симв.]`;
  };
  if (event.reason) return clip(event.reason);
  if (event.text) return clip(event.text);
  const allowed = [
    'model', 'modelSource', 'engine', 'sampleRate', 'reconnected', 'recoverable',
    'sttLatencyMs', 'llmLatencyMs', 'speechEndToFinalMs', 'openaiInferenceMs',
    'queueWaitMs', 'queueDepth', 'capturedAtMs', 'utteranceId',
  ];
  return Object.entries(event.meta ?? {})
    .filter(([key]) => allowed.includes(key))
    .map(([key, value]) => `${key}=${text(value)}`)
    .join(', ');
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

function retentionLine(label: string, retention: DiagnosticRetention | undefined, retained: number): string {
  if (!retention) {
    return `- ${label}: ${retained}; отброшено: не записано; всего записано: не записано (схема без счётчиков).`;
  }
  return `- ${label}: ${retention.retained}; отброшено: ${retention.dropped}; всего записано: ${retention.total}; лимит: ${retention.limit}.`;
}

function appendOptionalSection(
  lines: string[],
  title: string,
  blocks: string[][],
  reserveForLater: number,
): void {
  lines.push('', title, '');
  let omittedItems = 0;
  let omittedLines = 0;
  blocks.forEach((block) => {
    const addition = `\n${block.join('\n')}`;
    if (lines.join('\n').length + addition.length + reserveForLater <= MAX_REPORT_CHARS) {
      lines.push(...block);
    } else {
      omittedItems += 1;
      omittedLines += block.length;
    }
  });
  if (omittedItems) {
    lines.push(`> ${title.replace(/^#+\s*/, '')} — ОПУЩЕНО ИЗ-ЗА ЛИМИТА: ${omittedLines} строк (${omittedItems} записей).`);
  }
}

export function buildSessionDebugReport(input: {
  session: SessionDetail; issue: string; app: ReportAppInfo;
}): { filename: string; content: string } {
  const { session, app } = input;
  const diagnostics = session.diagnostics;
  const exchanges = diagnosticExchanges(session);
  const screens = screenAssists(session);
  const events = diagnostics?.events ?? [];
  const health = sourceHealth(session);
  const sttReady = events.find((event) => event.type === 'ready' && event.meta?.model);
  const sttModel = typeof sttReady?.meta?.model === 'string' ? sttReady.meta.model : null;
  const llmModels = unique([
    ...session.answers.map((answer) => answer.model),
    ...exchanges.map((exchange) => exchange.pipeline?.model),
    ...screens.map((screen) => screen.model),
  ]);
  const modelSources = unique([
    ...exchanges.map((exchange) => exchange.pipeline?.modelSource),
    ...screens.map((screen) => screen.modelSource),
  ]);
  const latencies = exchanges.map((exchange) => exchange.latency).filter(Boolean);
  const sttLatencies = latencies
    .map((value) => value?.sttLatencyMs)
    .filter((value): value is number => Number.isFinite(value));
  const llmLatencies = latencies
    .map((value) => value?.llmLatencyMs)
    .filter((value): value is number => Number.isFinite(value));
  const maxStt = sttLatencies.length ? Math.max(...sttLatencies) : null;
  const maxLlm = llmLatencies.length ? Math.max(...llmLatencies) : null;
  const errorEvents = events.filter((event) => event.type === 'error');
  const reconnectEvents = events.filter((event) => (
    event.meta?.reconnected === true || /reconnect|переподключ/i.test(event.reason ?? '')
  ));
  const lowQualityEvents = events.filter((event) => event.type === 'low_quality');
  const warningEvents = events.filter((event) => event.type === 'source_warning');
  const degradedSources = diagnostics?.schemaVersion === 2
    ? Object.entries(health).filter(([, evidence]) => {
      const hasSignalEvidence = Object.prototype.hasOwnProperty.call(evidence, 'firstSignalAtMs');
      const hasSpeechEvidence = Object.prototype.hasOwnProperty.call(evidence, 'firstSpeechAtMs');
      return evidence.requested === true && (
        (hasSignalEvidence && evidence.firstSignalAtMs === null)
        || (hasSpeechEvidence && evidence.firstSpeechAtMs === null)
      );
    })
    : [];
  const parts = [
    '# Отчёт SkillCue по сессии', '',
    '> Отчёт создан пользователем для диагностики. Секреты и локальное имя пользователя удалены автоматически.',
    '', '## Что сломалось', '', text(input.issue.trim() || 'Описание не добавлено.'),
    '', '## Приложение', '',
    `- SkillCue: \`${escapeCell(app.version)}\` (${escapeCell(app.channel)})`,
    `- Система: \`${escapeCell(app.platform)}\``,
    `- Отчёт создан: ${new Date().toISOString()}`,
    '', '## Сессия', '',
    `- ID: \`${escapeCell(session.id)}\``,
    `- Название: ${escapeCell(session.title || 'Без названия')}`,
    `- Начало: ${escapeCell(session.started_at)}`,
    `- Конец: ${escapeCell(session.ended_at || 'не зафиксирован')}`,
    `- Реплик: ${session.transcripts.length}; подсказок: ${session.answers.length}`,
    `- Схема диагностики: ${diagnostics?.schemaVersion ?? 'не записана'}`,
    '', '## Полнота диагностики', '',
    retentionLine('Сохранено событий', diagnostics?.retention?.events, events.length),
    retentionLine('Сохранено screen-запросов', diagnostics?.retention?.screenAssists, screens.length),
    '', '## Модели и источники', '',
    `- STT: ${sttModel ? `\`${escapeCell(sttModel)}\`` : 'не записано'}`,
    `- LLM: ${llmModels.length ? llmModels.map((model) => `\`${escapeCell(model)}\``).join(', ') : 'не записано'}`
      + (modelSources.length ? ` (${modelSources.map((source) => `\`${escapeCell(source)}\``).join(', ')})` : ''),
    `- Аудиоисточники: ${diagnostics?.extra?.sources ? escapeCell(JSON.stringify(diagnostics.extra.sources)) : 'не записано'}`,
    '', '## Здоровье аудиоисточников', '',
  ];

  if (Object.keys(health).length === 0) {
    parts.push('Подробные признаки готовности, сигнала и речи не записаны этой версией.');
  } else {
    parts.push('| Канал | Запрошен | Готов | Сигнал | Речь | Предупреждение |', '|---|---|---|---|---|---|');
    Object.entries(health).forEach(([source, evidence]) => {
      parts.push(`| ${escapeCell(source)} | ${yesNo(evidence.requested)} | ${yesNo(evidence.ready)} | ${observed(evidence.firstSignalAtMs, diagnostics?.schemaVersion)} | ${observed(evidence.firstSpeechAtMs, diagnostics?.schemaVersion)} | ${escapeCell(evidence.warning || '—')} |`);
    });
  }

  parts.push('', '## Быстрый диагноз', '');
  if (!diagnostics) {
    parts.push('Live-тайминг не записывался этой версией SkillCue. Для старой сессии доступны модель, транскрипт и сохранённые подсказки.');
  } else {
    if (latencies.length === 0) {
      parts.push('- События live-сессии записаны, но завершённых текстовых обменов с полным таймингом нет.');
    } else if (maxStt == null && maxLlm == null) {
      parts.push('- Авторитетные STT/LLM-задержки для завершённых обменов не записаны.');
    } else {
      const slowest = maxLlm != null && (maxStt == null || maxLlm >= maxStt) ? 'LLM' : 'STT';
      parts.push(`- Самый медленный этап: ${slowest} (STT max ${ms(maxStt)}, LLM max ${ms(maxLlm)}).`);
    }
    parts.push(`- Ошибок: ${errorEvents.length}; переподключений: ${reconnectEvents.length}; low_quality: ${lowQualityEvents.length}; предупреждений источника: ${warningEvents.length}.`);
    degradedSources.forEach(([source]) => {
      parts.push(`- Запрошенный канал ${escapeCell(source)} не показал сигнал или речь; источник деградирован или не подтверждён.`);
    });
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
    parts.push('', '### Авторитетные STT/queue-метаданные', '',
      '| # | Utterance | Канал | capturedAt | Speech end→final | OpenAI inference | Queue wait | Queue depth | Final→LLM dispatch |',
      '|---:|---|---|---:|---:|---:|---:|---:|---:|');
    exchanges.forEach((exchange, index) => {
      const stt = exchange.stt;
      const queueDepth = Number.isFinite(stt?.queueDepth) ? Math.round(stt!.queueDepth!) : '—';
      parts.push(`| ${index + 1} | ${escapeCell(stt?.utteranceId || '—')} | ${escapeCell(stt?.source || '—')} | ${ms(stt?.capturedAtMs)} | ${ms(stt?.speechEndToFinalMs)} | ${ms(stt?.openaiInferenceMs)} | ${ms(stt?.queueWaitMs)} | ${queueDepth} | ${ms(exchange.latency?.breakdown?.finalToAnswerStartMs)} |`);
    });
  }

  parts.push('', '## Screen-запросы', '');
  if (screens.length === 0) {
    parts.push('Screen-запросы не записаны.');
  } else {
    parts.push('| # | От старта | Триггер | Режим | Статус | Модель | Источник модели | Capture | Первый вывод | Всего |', '|---:|---:|---|---|---|---|---|---:|---:|---:|');
    screens.forEach((screen, index) => {
      parts.push(`| ${index + 1} | ${ms(screen.startedAtMs)} | ${escapeCell(screen.trigger)} | ${escapeCell(screen.mode)} | ${escapeCell(screen.status)} | ${escapeCell(screen.model || 'не записано')} | ${escapeCell(screen.modelSource || 'не записано')} | ${ms(screen.captureMs)} | ${ms(screen.firstOutputMs)} | ${ms(screen.totalMs)} |`);
    });
  }

  parts.push('', '## События STT/LLM', '');
  if (events.length === 0) {
    parts.push('Таймлайн отсутствует.');
  } else {
    parts.push('| От старта | Событие | Канал | Детали |', '|---:|---|---|---|');
    events.forEach((event) => {
      parts.push(`| ${event.tMs} мс | ${escapeCell(event.type)} | ${escapeCell(event.source ?? event.speaker ?? '—')} | ${escapeCell(eventDetail(event) || '—')} |`);
    });
  }

  parts.push('', '## Границы и приватность', '',
    '- В отчёт входят диагностический текст запросов/ответов, модели, тайминги, статусы и размеры кодированного изображения.',
    '- Пиксели скриншотов, screenshot/base64 payload, аудиозапись, cookies, контекст авторизации и секреты в отчёт не прикладываются.',
    '- При лимите размера сохраняются все retained-события и счётчики; длинные screen-ответы, транскрипт и подсказки могут быть опущены с явным счётчиком.');

  const screenBlocks = screens.map((screen, index) => [
    `### Screen ${index + 1}: ${escapeCell(screen.status)}`, '',
    `- ID: \`${escapeCell(screen.id)}\`; generation: ${screen.generation}`,
    `- Запрос: ${escapeCell(screen.effectiveQuestion || 'не записано')}`,
    `- Изображение: ${escapeCell(screen.imageMimeType || 'тип не записан')}; encoded bytes: ${Number.isFinite(screen.encodedByteCount) ? screen.encodedByteCount : 'не записано'}`,
    `- Ответ: ${text(screen.answer || 'не записано')}`,
    `- Ошибка: ${text(screen.error || '—')}`,
  ]);
  appendOptionalSection(parts, '## Детали Screen-запросов', screenBlocks, 20_000);

  const transcriptBlocks = session.transcripts.map((line) => {
    const speaker = line.speaker === 'me' ? 'Кандидат' : 'Интервьюер';
    return [`- **${speaker} · ${escapeCell(line.ts)}:** ${text(line.text)}`];
  });
  if (transcriptBlocks.length === 0) transcriptBlocks.push(['Транскрипт пуст.']);
  appendOptionalSection(parts, '## Транскрипт', transcriptBlocks, 10_000);

  const answerBlocks = session.answers.map((answer, index) => [
    `### ${index + 1}. ${text(answer.question)}`, '',
    text(answer.spoken || answer.short || 'Пустой ответ'), '',
  ]);
  if (answerBlocks.length === 0) answerBlocks.push(['Подсказок нет.']);
  appendOptionalSection(parts, '## Подсказки SkillCue', answerBlocks, 0);

  const id = session.id.replace(/[^a-z0-9-]/gi, '-').slice(0, 9) || 'session';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return { filename: `skillcue-session-${id}-${stamp}.md`, content: parts.join('\n') };
}
