import { useEffect, useRef } from 'react';

interface TranscriptLine {
  text: string;
  isFinal: boolean;
}

interface TranscriptPanelProps {
  lines: TranscriptLine[];
}

export default function TranscriptPanel({ lines }: TranscriptPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  return (
    <div className="flex h-full flex-col rounded-xl border border-white/10 bg-black/70 p-4 backdrop-blur-md">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">
        Транскрипция
      </h3>
      <div className="flex-1 space-y-2 overflow-y-auto text-sm">
        {lines.length === 0 && <p className="text-gray-500">Ожидание речи...</p>}
        {lines.map((line, i) => (
          <p key={i} className={line.isFinal ? 'text-white' : 'text-gray-400 italic'}>
            {line.text}
          </p>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
