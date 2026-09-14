interface Props {
  sent: number;
  status: 'running' | 'completed' | 'attention' | 'failed' | 'stopped';
  autoReplies: boolean;
  repliesToday: number;
  onRetry: () => void;
}

export default function HhRunSummary({ sent, status, autoReplies, repliesToday, onRetry }: Props) {
  return <section id="hh-run-panel" className="panel-card flex shrink-0 scroll-mt-5 flex-wrap items-center justify-between gap-4 px-5 py-4" aria-label="Результаты откликов">
    <div>
      <p className="text-sm font-semibold text-ink">Отправлено откликов: {sent}</p>
      <p className="mt-1 text-xs text-ink-muted">{status === 'running'
        ? 'Поиск и отправка продолжаются'
        : status === 'failed' ? 'Поиск прервался. Уже отправленные отклики сохранены.'
          : status === 'stopped' ? 'Поиск остановлен' : 'За последний поиск'}</p>
      {status === 'failed' && <button type="button" className="btn-ghost btn-sm mt-2" onClick={onRetry}>Повторить поиск</button>}
    </div>
    <div>
      <p className="text-sm text-ink">{autoReplies ? 'Автоответы включены' : 'Автоответы выключены'}</p>
      <p className="mt-1 text-xs text-ink-muted">Сегодня отправлено ответов: {repliesToday}</p>
    </div>
  </section>;
}
