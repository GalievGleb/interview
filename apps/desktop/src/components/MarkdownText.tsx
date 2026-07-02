import type { ReactNode } from 'react';

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

function CodeBlock({ language, code }: { language: string; code: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-surface-border bg-surface-elevated">
      {language && (
        <div className="border-b border-surface-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
          {language}
        </div>
      )}
      <pre className="overflow-x-auto px-3.5 py-3">
        <code className="sc-mono block whitespace-pre text-[13px] leading-relaxed text-emerald-200">
          {code.replace(/\n+$/, '')}
        </code>
      </pre>
    </div>
  );
}

/** Простой markdown: **bold**, `code`, ```code blocks```, абзацы, списки. */
export default function MarkdownText({ text, className = '' }: { text: string; className?: string }) {
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

  return <div className={`space-y-4 text-sm leading-relaxed ${className}`}>{segments}</div>;
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
