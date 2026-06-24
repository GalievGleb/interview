import type { ReactNode } from 'react';
import type { VoiceTestKeywordMatch, VoiceTestResult } from '../../test-lab/voice-test-types';

interface VoiceTestDetailsProps {
  result: VoiceTestResult | null;
}

function MissingKeywordList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">{title}</p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span key={item} className="rounded-md bg-surface px-2 py-0.5 text-xs text-amber-700">
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

function FoundKeywordList({ title, matches }: { title: string; matches: VoiceTestKeywordMatch[] }) {
  if (matches.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">{title}</p>
      <div className="flex flex-wrap gap-1.5">
        {matches.map((match) => (
          <span
            key={match.key}
            className="rounded-md bg-surface px-2 py-0.5 text-xs text-emerald-700"
            title={`matched: ${match.matchedAlias}`}
          >
            {match.key} ← {match.matchedAlias}
          </span>
        ))}
      </div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{title}</h3>
      <div className="rounded-lg border border-surface-border bg-surface px-3 py-2.5 text-sm leading-relaxed">
        {children}
      </div>
    </section>
  );
}

export default function VoiceTestDetails({ result }: VoiceTestDetailsProps) {
  if (!result) {
    return (
      <div className="rounded-xl border border-dashed border-surface-border bg-surface-panel p-6 text-sm text-ink-faint">
        Выберите тест в таблице, чтобы увидеть детали.
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border border-surface-border bg-surface-panel p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs text-ink-faint">{result.caseId}</p>
          <h2 className="text-lg font-semibold">{result.title}</h2>
        </div>
        <span className="rounded-md bg-surface px-2 py-1 text-xs font-medium uppercase">{result.status}</span>
      </div>

      <Block title="Expected question">{result.expectedQuestion}</Block>
      <Block title="Actual transcript">
        {result.actualTranscript || <span className="text-ink-faint">—</span>}
      </Block>
      <Block title="Generated answer">
        {result.generatedAnswer || <span className="text-ink-faint">—</span>}
      </Block>

      <div className="grid gap-3 sm:grid-cols-2">
        <FoundKeywordList title="Found transcript keywords" matches={result.metrics.transcriptKeywordsFound} />
        <MissingKeywordList title="Missing transcript keywords" items={result.metrics.missingTranscriptKeywords} />
        <FoundKeywordList title="Found answer keywords (required)" matches={result.metrics.answerKeywordsFound} />
        <MissingKeywordList title="Missing answer keywords (required)" items={result.metrics.missingAnswerKeywords} />
        <FoundKeywordList
          title="Found answer keywords (optional)"
          matches={result.metrics.optionalAnswerKeywordsFound}
        />
      </div>

      {result.metrics.forbiddenPhrasesFound.length > 0 && (
        <MissingKeywordList title="Forbidden phrases" items={result.metrics.forbiddenPhrasesFound} />
      )}

      {(result.failureReason || result.errorMessage) && (
        <Block title="Failure reason">
          <span className="text-red-700">{result.errorMessage ?? result.failureReason}</span>
        </Block>
      )}

      <div className="grid grid-cols-3 gap-2 text-xs text-ink-muted">
        <div>STT: {result.metrics.sttLatencyMs} ms</div>
        <div>LLM: {result.metrics.llmLatencyMs} ms</div>
        <div>Total: {result.metrics.totalLatencyMs} ms</div>
      </div>
    </div>
  );
}
