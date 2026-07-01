interface SuggestionPanelProps {
  suggestion: string;
  loading: boolean;
}

export default function SuggestionPanel({ suggestion, loading }: SuggestionPanelProps) {
  return (
    <div className="flex h-full flex-col rounded-xl border border-emerald-500/30 bg-emerald-950/40 p-4 backdrop-blur-md">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-emerald-300">
        AI-подсказка
      </h3>
      <div className="flex-1 overflow-y-auto text-sm leading-relaxed text-white">
        {loading && !suggestion && (
          <p className="animate-pulse text-emerald-300">Генерация подсказки...</p>
        )}
        {!loading && !suggestion && (
          <p className="text-gray-500">Подсказки появятся здесь</p>
        )}
        {suggestion}
      </div>
    </div>
  );
}
