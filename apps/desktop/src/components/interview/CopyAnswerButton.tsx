import { useState } from 'react';

interface CopyAnswerButtonProps {
  text: string;
  className?: string;
}

export default function CopyAnswerButton({ text, className = '' }: CopyAnswerButtonProps) {
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
      title="Copy answer to clipboard"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
