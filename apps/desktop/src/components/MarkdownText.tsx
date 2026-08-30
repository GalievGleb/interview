import { useState, type ReactNode } from 'react';

/** Разбивает сплошной текст LLM на абзацы (без форсирования «во-первых»). */
export function formatLiveMarkdown(text: string): string {
  let out = text.trim();
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

function isBulletLine(line: string): boolean {
  return line.startsWith('* ');
}

function isSectionLine(line: string): boolean {
  return /^(?:Во-|Ещё |Если нужно|На практике|Основные|То есть |Для меня )/iu.test(line);
}

function isDashListLine(line: string): boolean {
  return /^[A-ZА-ЯЁ][A-Za-zА-Яа-яЁё0-9(),\- ]{2,}? — /u.test(line);
}

const FENCED_CODE_REGEX = /```([a-zA-Z0-9+#_-]*)\n?([\s\S]*?)```/g;

function commentMarkerForLanguage(language: string): string | null {
  const normalized = language.trim().toLowerCase();
  if (/^(?:py|python|bash|sh|shell|yaml|yml|ruby|r)$/.test(normalized)) return '#';
  if (/^(?:sql|pgsql|postgres|mysql|lua|haskell)$/.test(normalized)) return '--';
  if (/^(?:js|javascript|jsx|ts|typescript|tsx|java|c|cpp|c\+\+|c#|cs|go|rust|swift|kotlin)$/.test(normalized)) {
    return '//';
  }
  return null;
}

function findCommentOutsideString(line: string, marker: string): number {
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;
  for (let index = 0; index <= line.length - marker.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        // SQL экранирует одинарную кавычку удвоением, строка здесь не заканчивается.
        if (quote === "'" && line[index + 1] === "'") {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (line.startsWith(marker, index)) return index;
  }
  return -1;
}

/**
 * Переносит русское пояснение под строку кода. Так длинная строка не удваивается
 * комментарием по ширине, а копируемый результат остаётся валидным кодом.
 */
export function formatCodeForCompactDisplay(language: string, code: string): string {
  const marker = commentMarkerForLanguage(language);
  const clean = code.replace(/\n+$/, '');
  if (!marker) return clean;

  return clean.split('\n').flatMap((line) => {
    const commentIndex = findCommentOutsideString(line, marker);
    if (commentIndex < 0 || !line.slice(commentIndex + marker.length).match(/[А-Яа-яЁё]/u)) {
      return [line];
    }
    const codePart = line.slice(0, commentIndex).trimEnd();
    if (!codePart.trim()) return [line];
    const indent = line.match(/^\s*/u)?.[0] ?? '';
    const commentPart = line.slice(commentIndex).trimStart();
    return [codePart, `${indent}${commentPart}`];
  }).join('\n');
}

function isStandaloneCodeComment(language: string, line: string): boolean {
  const marker = commentMarkerForLanguage(language);
  return Boolean(marker && line.trimStart().startsWith(marker));
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const clean = formatCodeForCompactDisplay(language, code);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(clean).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };
  return (
    <div className="group relative min-w-0 max-w-full overflow-hidden rounded-xl border border-surface-border bg-surface-elevated">
      <div className="flex items-center justify-between border-b border-surface-border px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
          {language || 'code'}
        </span>
        {/* Отдельная кнопка «Копировать» на самом блоке — общая кнопка ответа
            копирует markdown с ```, а из кода нужен чистый текст (SQL/Python). */}
        <button
          type="button"
          onClick={copy}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
          aria-label="Копировать код"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {copied ? (
              <path d="M20 6 9 17l-5-5" />
            ) : (
              <>
                <path d="M8 8h12v12H8z" />
                <path d="M16 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2" />
              </>
            )}
          </svg>
          {copied ? 'Скопировано' : 'Копировать'}
        </button>
      </div>
      <pre className="max-w-full overflow-x-hidden px-3.5 py-3">
        <code className="sc-mono block min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[13px] leading-relaxed">
          {clean.split('\n').map((line, index) => (
            <span
              key={`${index}-${line}`}
              className={`block ${isStandaloneCodeComment(language, line) ? 'text-ink-muted' : 'text-emerald-200'}`}
            >
              {line || '\u00a0'}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

/** Простой markdown: **bold**, `code`, ```code blocks```, абзацы, списки. */
export default function MarkdownText({
  text,
  className = '',
  size = 'sm',
}: {
  text: string;
  className?: string;
  /**
   * `inherit` — не навязывать свой размер, а взять его от контейнера. Нужно там,
   * где размер задаёт контейнер (например `.ovl-answer-body` в оверлее): иначе
   * `text-sm` на корневом div перебивал бы его по специфичности.
   */
  size?: 'sm' | 'inherit';
}) {
  if (!text) return null;

  const formatted = formatLiveMarkdown(text);

  // Сначала вырезаем fenced code blocks — их нельзя резать по пустым строкам.
  const segments: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  FENCED_CODE_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCED_CODE_REGEX.exec(formatted)) !== null) {
    const before = formatted.slice(cursor, match.index).trim();
    if (before) {
      before.split(/\n{2,}/).forEach((block) => segments.push(renderBlock(block, key++)));
    }
    segments.push(<CodeBlock key={key++} language={match[1] ?? ''} code={match[2] ?? ''} />);
    cursor = match.index + match[0].length;
  }
  const rest = formatted.slice(cursor).trim();
  if (rest) {
    rest.split(/\n{2,}/).forEach((block) => segments.push(renderBlock(block, key++)));
  }

  return (
    <div className={`space-y-4 leading-relaxed ${size === 'sm' ? 'text-sm ' : ''}${className}`}>
      {segments}
    </div>
  );
}

function renderBlock(block: string, key: number): ReactNode {
  const lines = block
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  if (lines.every(isBulletLine)) {
    return (
      <ul key={key} className="list-disc space-y-2.5 pl-5 text-ink">
        {lines.map((line, j) => (
          <li key={j} className="pl-0.5">
            {renderInline(line.replace(/^\*\s+/, ''))}
          </li>
        ))}
      </ul>
    );
  }

  if (lines.length > 1 && lines.every((l) => isDashListLine(l) || isBulletLine(l))) {
    return (
      <ul key={key} className="list-none space-y-2.5 border-l-2 border-violet-500/30 pl-4 text-ink">
        {lines.map((line, j) => (
          <li key={j}>{renderInline(line.replace(/^\*\s+/, ''))}</li>
        ))}
      </ul>
    );
  }

  if (lines.length > 1 && lines.some(isSectionLine)) {
    return (
      <div key={key} className="space-y-3">
        {lines.map((line, j) => (
          <p key={j} className="text-ink">
            {renderInline(line)}
          </p>
        ))}
      </div>
    );
  }

  if (lines.length === 1) {
    return (
      <p key={key} className="text-ink">
        {renderInline(lines[0])}
      </p>
    );
  }

  return (
    <div key={key} className="space-y-3">
      {lines.map((line, j) => (
        <p key={j} className="text-ink">
          {renderInline(line)}
        </p>
      ))}
    </div>
  );
}

function renderInline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={i} className="font-semibold text-violet-300">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={i}
          className="sc-mono rounded-md border border-surface-border bg-surface-elevated px-1.5 py-0.5 text-[12.5px] text-emerald-200"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={i}>{part}</span>;
  });
}
