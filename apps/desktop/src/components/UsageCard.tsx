import { useEffect, useState } from 'react';
import { api, type UsageRow } from '../lib/api';

function Tile({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="sc-mono mt-1 text-2xl font-semibold text-ink">{value}</p>
    </div>
  );
}

/** Local API activity (request counts by kind) — not provider billing. */
export default function UsageCard() {
  const [rows, setRows] = useState<UsageRow[] | null>(null);

  useEffect(() => {
    api
      .usage()
      .then((r) => setRows(r.usage))
      .catch(() => setRows([]));
  }, []);

  if (!rows) return null;

  const sum = (pred: (r: UsageRow) => boolean, pick: (r: UsageRow) => number) =>
    rows.filter(pred).reduce((s, r) => s + pick(r), 0);
  const total = sum(() => true, (r) => r.requests);
  const tokensIn = sum(() => true, (r) => r.tokens_in);
  const tokensOut = sum(() => true, (r) => r.tokens_out);
  const sttSeconds = sum(() => true, (r) => r.stt_seconds);

  return (
    <div className="sc-card mb-5 p-5">
      <h3 className="mb-3 text-sm font-semibold text-ink">Usage — локальная активность</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Всего запросов" value={total} />
        <Tile label="LLM (chat)" value={sum((r) => r.kind === 'chat', (r) => r.requests)} />
        <Tile label="STT" value={sum((r) => r.kind === 'stt', (r) => r.requests)} />
        <Tile label="Embeddings" value={sum((r) => r.kind === 'embed', (r) => r.requests)} />
      </div>
      {(tokensIn > 0 || tokensOut > 0 || sttSeconds > 0) && (
        <div className="sc-mono mt-3 flex flex-wrap gap-4 text-xs text-ink-muted">
          {tokensIn > 0 && <span>tokens in {tokensIn}</span>}
          {tokensOut > 0 && <span>tokens out {tokensOut}</span>}
          {sttSeconds > 0 && <span>stt {sttSeconds}s</span>}
        </div>
      )}
      <p className="mt-3 text-xs text-ink-faint">
        Счётчик локальной активности приложения, не биллинг провайдера.
      </p>
    </div>
  );
}
