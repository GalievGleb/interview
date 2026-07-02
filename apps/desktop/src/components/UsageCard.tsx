import { useEffect, useState } from 'react';
import { api, type UsageRow } from '../lib/api';

// Оценочные тарифы (USD за 1M токенов) — средний mid-tier класс моделей.
// Точный биллинг знает только провайдер, это ориентир порядка величины.
const APPROX_USD_PER_1M_IN = 0.5;
const APPROX_USD_PER_1M_OUT = 1.5;

function estimateCostUsd(tokensIn: number, tokensOut: number): number {
  return (tokensIn / 1e6) * APPROX_USD_PER_1M_IN + (tokensOut / 1e6) * APPROX_USD_PER_1M_OUT;
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

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
  const [rows30, setRows30] = useState<UsageRow[]>([]);

  useEffect(() => {
    api
      .usage()
      .then((r) => {
        setRows(r.usage);
        setRows30(r.last_30_days ?? []);
      })
      .catch(() => setRows([]));
  }, []);

  if (!rows) return null;

  const sum = (
    source: UsageRow[],
    pred: (r: UsageRow) => boolean,
    pick: (r: UsageRow) => number,
  ) => source.filter(pred).reduce((s, r) => s + pick(r), 0);
  const total = sum(rows, () => true, (r) => r.requests);
  const tokensIn = sum(rows, () => true, (r) => r.tokens_in);
  const tokensOut = sum(rows, () => true, (r) => r.tokens_out);
  const sttSeconds = sum(rows, () => true, (r) => r.stt_seconds);
  const tokensIn30 = sum(rows30, () => true, (r) => r.tokens_in);
  const tokensOut30 = sum(rows30, () => true, (r) => r.tokens_out);
  const costAll = estimateCostUsd(tokensIn, tokensOut);
  const cost30 = estimateCostUsd(tokensIn30, tokensOut30);

  return (
    <div className="sc-card mb-5 p-5">
      <h3 className="mb-3 text-sm font-semibold text-ink">Активность и расходы</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Всего запросов" value={total} />
        <Tile label="LLM (chat)" value={sum(rows, (r) => r.kind === 'chat', (r) => r.requests)} />
        <Tile label="≈ за 30 дней" value={formatCost(cost30)} />
        <Tile label="≈ за всё время" value={formatCost(costAll)} />
      </div>
      {(tokensIn > 0 || tokensOut > 0 || sttSeconds > 0) && (
        <div className="sc-mono mt-3 flex flex-wrap gap-4 text-xs text-ink-muted">
          {tokensIn > 0 && <span>токенов на входе: {tokensIn.toLocaleString('ru')}</span>}
          {tokensOut > 0 && <span>токенов на выходе: {tokensOut.toLocaleString('ru')}</span>}
          {sttSeconds > 0 && <span>STT: {sttSeconds}с (локально, бесплатно)</span>}
        </div>
      )}
      <p className="mt-3 text-xs text-ink-faint">
        Стоимость — грубая оценка по средним тарифам (${APPROX_USD_PER_1M_IN}/M вход, $
        {APPROX_USD_PER_1M_OUT}/M выход), не биллинг провайдера. Точную сумму смотрите в кабинете
        OpenAI/OpenRouter.
      </p>
    </div>
  );
}
