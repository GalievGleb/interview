import { useEffect, useState } from 'react';
import { FileText, Loader2, Send } from 'lucide-react';
import Modal from '../Modal';
import { api, type SessionDetail, type SessionItem } from '../../lib/api';
import { buildSessionDebugReport } from '../../lib/sessionDebugReport';

function isDetail(session: SessionItem): session is SessionDetail {
  return 'answers' in session && 'transcripts' in session;
}

function downloadFallback(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function SessionReportModal({
  session,
  onClose,
}: {
  session: SessionItem | SessionDetail | null;
  onClose: () => void;
}) {
  const [issue, setIssue] = useState('');
  const [busyAction, setBusyAction] = useState<'open' | 'telegram' | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{
    path?: string;
    action: 'open' | 'telegram';
    telegramOpened: boolean;
    fileOpened?: boolean;
  } | null>(null);

  useEffect(() => {
    setIssue('');
    setBusyAction(null);
    setError('');
    setResult(null);
  }, [session?.id]);

  const prepareReport = async (action: 'open' | 'telegram') => {
    if (!session || (action === 'telegram' && !issue.trim())) return;
    setBusyAction(action);
    setError('');
    setResult(null);
    try {
      const detail = isDetail(session) ? session : await api.getSession(session.id);
      const [version, channel] = await Promise.all([
        window.electronAPI?.getVersion?.().catch(() => 'unknown') ?? Promise.resolve('web'),
        window.electronAPI?.getBuildChannel?.().catch(() => 'unknown') ?? Promise.resolve('unknown'),
      ]);
      const report = buildSessionDebugReport({
        session: detail,
        issue,
        app: { version, channel, platform: navigator.userAgent },
      });
      if (window.electronAPI?.shareSessionReport) {
        const shared = await window.electronAPI.shareSessionReport({
          ...report,
          message: issue.trim(),
          action,
        });
        setResult({
          path: shared.path,
          action,
          telegramOpened: shared.telegramOpened,
          fileOpened: shared.fileOpened,
        });
      } else {
        downloadFallback(report.filename, report.content);
        setResult({ action, telegramOpened: false, fileOpened: false });
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось подготовить отчёт.');
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <Modal
      open={Boolean(session)}
      onClose={onClose}
      title="Отправить отчёт по сессии"
      subtitle={session?.title || 'Интервью без названия'}
      size="lg"
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Закрыть</button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busyAction !== null}
            onClick={() => void prepareReport('open')}
          >
            {busyAction === 'open' ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <FileText size={15} aria-hidden="true" />}
            {busyAction === 'open' ? 'Открываю…' : 'Открыть файл'}
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busyAction !== null || !issue.trim()}
            onClick={() => void prepareReport('telegram')}
          >
            {busyAction === 'telegram' ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Send size={15} aria-hidden="true" />}
            {busyAction === 'telegram' ? 'Готовлю…' : 'Прикрепить в Telegram'}
          </button>
        </>
      )}
    >
      <div className="grid gap-4">
        <div className="rounded-xl border border-surface-border bg-surface/60 p-3 text-sm text-ink-muted">
          <p className="flex items-center gap-2 font-semibold text-ink"><FileText size={16} aria-hidden="true" />Что попадёт в отчёт</p>
          <p className="mt-1">Модели STT/LLM, реальные тайминги, здоровье аудиоисточников, ошибки, транскрипт, подсказки и диагностический текст screen-запросов/ответов этой сессии. Ключи и локальное имя пользователя удаляются.</p>
          <p className="mt-2">Пиксели скриншотов и screenshot/base64 payload не прикладываются — сохраняются только тип и размер изображения. Аудиозапись не отправляется. Cookies, авторизационный контекст и секреты тоже не отправляются.</p>
          <p className="mt-2 text-ink-faint">Старые сессии тоже поддерживаются: SkillCue добавит всё, что сохранилось в их версии, и честно отметит отсутствующие тайминги.</p>
        </div>

        <label className="grid gap-2 text-sm font-semibold text-ink">
          Что именно сломалось?
          <textarea
            className="prep-input min-h-28 resize-y font-normal"
            value={issue}
            onChange={(event) => setIssue(event.target.value)}
            placeholder="Например: после вопроса подсказка появилась только через 5 минут; системный звук продолжал распознаваться."
            maxLength={2000}
          />
        </label>

        {error && <p className="prep-inline-error" role="alert">{error}</p>}
        {result && (
          <div className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-ink" role="status">
            <strong>
              {result.action === 'open'
                ? (result.fileOpened ? 'Отчёт открыт.' : result.path ? 'Отчёт сохранён. Файл показан в Проводнике.' : 'Отчёт скачан.')
                : (result.telegramOpened ? 'Открыт чат поддержки SkillCue.' : 'Отчёт сохранён. Telegram не открылся.')}
            </strong>
            {result.action === 'telegram' && (
              <p className="mt-1 text-ink-muted">
                {result.telegramOpened
                  ? 'Перетащите файл отчёта в чат @SkillCue и нажмите «Отправить».'
                  : 'Откройте @SkillCue вручную и прикрепите сохранённый отчёт.'}
              </p>
            )}
            {result.path && <code className="mt-2 block break-all text-xs text-ink-faint">{result.path}</code>}
          </div>
        )}
      </div>
    </Modal>
  );
}
