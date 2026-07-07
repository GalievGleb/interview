import { useState } from 'react';
import { useI18n } from '../../lib/i18n';

interface CopyAnswerButtonProps {
  text: string;
  className?: string;
}

export default function CopyAnswerButton({ text, className = '' }: CopyAnswerButtonProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const value = text.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore clipboard errors in restricted contexts
    }
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      disabled={!text.trim()}
      className={`btn-secondary btn-sm ${className}`.trim()}
      title={t('answer.copyTitle')}
    >
      {copied ? t('overlay.copied') : t('common.copy')}
    </button>
  );
}
