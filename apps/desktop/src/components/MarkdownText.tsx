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

/** Простой markdown: **bold**, абзацы, списки. */
export default function MarkdownText({ text, className = '' }: { text: string; className?: string }) {
  if (!text) return null;

  const formatted = formatLiveMarkdown(text);
  const blocks = formatted.split(/\n{2,}/);

  return (
    <div className={`space-y-4 text-sm leading-relaxed ${className}`}>
      {blocks.map((block, i) => renderBlock(block, i))}
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
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={i} className="font-semibold text-violet-300">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <span key={i}>{part}</span>;
  });
}
