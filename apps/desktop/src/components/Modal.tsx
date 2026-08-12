import { ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../lib/i18n';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  size?: 'md' | 'lg' | 'xl';
  children?: ReactNode;
  footer?: ReactNode;
}

const WIDTH_BY_SIZE = {
  md: 'max-w-md',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
} as const;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Modal({ open, onClose, title, subtitle, size = 'md', children, footer }: ModalProps) {
  const { t } = useI18n();
  const titleId = useId();
  const subtitleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  // Колбэк читаем через ref: иначе новая стрелка на каждый рендер вызывающего
  // компонента перезапускала бы эффект и заново перехватывала фокус.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Диалог удерживает фокус внутри себя и возвращает его инициатору при
  // закрытии. Без этого Tab уводит на элементы под подложкой, а после закрытия
  // фокус остаётся в <body> — навигация с клавиатуры начинается заново.
  useEffect(() => {
    if (!open) return;
    const restoreTo = document.activeElement as HTMLElement | null;
    const appRoot = document.getElementById('root') as (HTMLElement & { inert: boolean }) | null;
    const rootWasInert = appRoot?.inert ?? false;
    if (appRoot) appRoot.inert = true;
    const focusables = () =>
      Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);

    const first = focusables()[0];
    if (first) first.focus();
    else dialogRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const edge = e.shiftKey ? items[0] : items[items.length - 1];
      const wrapTo = e.shiftKey ? items[items.length - 1] : items[0];
      const active = document.activeElement;
      if (active === edge || !dialogRef.current?.contains(active)) {
        e.preventDefault();
        wrapTo.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (appRoot) appRoot.inert = rootWasInert;
      restoreTo?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overscroll-contain bg-black/60 p-4 backdrop-blur-sm motion-safe:animate-fade-in"
      onMouseDown={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        className={`flex max-h-[92vh] w-full ${WIDTH_BY_SIZE[size]} motion-safe:animate-scale-in flex-col overflow-hidden rounded-2xl border border-surface-border bg-surface-light shadow-pop`}
      >
        <div className="flex items-start justify-between border-b border-surface-border px-5 py-4">
          <div>
            <h3 id={titleId} className="text-base font-semibold tracking-tight text-ink">{title}</h3>
            {subtitle && <p id={subtitleId} className="mt-0.5 text-sm text-ink-muted">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {children && <div className="min-h-0 overflow-y-auto px-5 py-4">{children}</div>}

        {footer && (
          <div className="flex justify-end gap-2 border-t border-surface-border bg-surface/40 px-5 py-3.5">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
