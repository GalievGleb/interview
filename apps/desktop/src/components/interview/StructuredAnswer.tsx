import type { ReactNode } from 'react';
import MarkdownText from '../MarkdownText';
import { parseAnswerSections } from '../../lib/parseAnswerSections';
import { useI18n } from '../../lib/i18n';

interface StructuredAnswerProps {
  text: string;
  className?: string;
}

function SectionBlock({
  title,
  children,
  variant = 'default',
}: {
  title?: string;
  children: ReactNode;
  variant?: 'default' | 'muted' | 'warn';
}) {
  const extra =
    variant === 'warn'
      ? 'border-amber-500/20 bg-amber-950/10'
      : variant === 'muted'
        ? ''
        : 'cockpit-bento-main';

  return (
    <section className={`cockpit-bento ${extra}`}>
      {title && (
        <h4 className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          {title}
        </h4>
      )}
      <div className="answer-prose">{children}</div>
    </section>
  );
}

export default function StructuredAnswer({ text, className = '' }: StructuredAnswerProps) {
  const { t } = useI18n();
  const sections = parseAnswerSections(text);
  const hasStructure =
    sections.keyPoints.length > 0 || sections.example || sections.avoid;

  if (!hasStructure) {
    return (
      <div className={`answer-prose ${className}`}>
        <MarkdownText text={text} />
      </div>
    );
  }

  return (
    <div className={`space-y-3 ${className}`}>
      {sections.main && (
        <SectionBlock variant="default">
          <MarkdownText text={sections.main} />
        </SectionBlock>
      )}

      {sections.keyPoints.length > 0 && (
        <SectionBlock variant="muted">
          <ul className="list-disc space-y-2 pl-4 text-[15px] leading-relaxed text-ink">
            {sections.keyPoints.map((point, i) => (
              <li key={i}>{point}</li>
            ))}
          </ul>
        </SectionBlock>
      )}

      {sections.example && (
        <SectionBlock title={t('answer.section.example')} variant="muted">
          <MarkdownText text={sections.example} />
        </SectionBlock>
      )}

      {sections.avoid && (
        <SectionBlock title={t('answer.tab.risk')} variant="warn">
          <MarkdownText text={sections.avoid} />
        </SectionBlock>
      )}
    </div>
  );
}
