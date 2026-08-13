export const OVERLAY_HIT_SELECTOR = '[data-overlay-hit="true"]';

export type FloatingPlacement = 'top' | 'bottom' | 'left' | 'right';

export function shouldCaptureOverlayPointer(
  element: Pick<Element, 'closest'> | null,
): boolean {
  return Boolean(element?.closest(OVERLAY_HIT_SELECTOR));
}

export class OverlayPointerController {
  private captures = false;
  private point: { x: number; y: number } | null = null;

  constructor(
    private readonly setClickThrough: (enabled: boolean) => void,
    private readonly elementFromPoint: (x: number, y: number) => Pick<Element, 'closest'> | null,
  ) {}

  initialize(): void {
    this.captures = false;
    this.setClickThrough(true);
  }

  move(x: number, y: number): void {
    this.point = { x, y };
    this.refresh();
  }

  refresh(): void {
    const next = this.point
      ? shouldCaptureOverlayPointer(this.elementFromPoint(this.point.x, this.point.y))
      : false;
    if (next === this.captures) return;
    this.captures = next;
    this.setClickThrough(!next);
  }

  dispose(): void {
    this.point = null;
    this.captures = false;
    this.setClickThrough(true);
  }
}

export function clampFloatingPanel(
  anchor: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  preferred: FloatingPlacement,
  margin = 8,
): { left: number; top: number } {
  if (preferred === 'left' || preferred === 'right') {
    const preferredLeft = preferred === 'right'
      ? anchor.right + margin
      : anchor.left - panel.width - margin;
    const oppositeLeft = preferred === 'right'
      ? anchor.left - panel.width - margin
      : anchor.right + margin;
    const preferredFits = preferredLeft >= margin
      && preferredLeft + panel.width <= viewport.width - margin;
    const left = Math.min(
      Math.max(preferredFits ? preferredLeft : oppositeLeft, margin),
      Math.max(margin, viewport.width - panel.width - margin),
    );
    const top = Math.min(
      Math.max(anchor.bottom - panel.height, margin),
      Math.max(margin, viewport.height - panel.height - margin),
    );
    return { left: Math.round(left), top: Math.round(top) };
  }

  const left = Math.min(
    Math.max(anchor.left + anchor.width / 2 - panel.width / 2, margin),
    Math.max(margin, viewport.width - panel.width - margin),
  );
  const preferredTop =
    preferred === 'top' ? anchor.top - panel.height - margin : anchor.bottom + margin;
  const oppositeTop =
    preferred === 'top' ? anchor.bottom + margin : anchor.top - panel.height - margin;
  const preferredFits =
    preferredTop >= margin && preferredTop + panel.height <= viewport.height - margin;
  const top = Math.min(
    Math.max(preferredFits ? preferredTop : oppositeTop, margin),
    Math.max(margin, viewport.height - panel.height - margin),
  );

  return { left: Math.round(left), top: Math.round(top) };
}
