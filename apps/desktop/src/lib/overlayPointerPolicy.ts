export const OVERLAY_HIT_SELECTOR = '[data-overlay-hit="true"]';

export type FloatingPlacement = 'top' | 'bottom' | 'left' | 'right';

export function shouldCaptureOverlayPointer(
  element: Pick<Element, 'closest'> | null,
): boolean {
  return Boolean(element?.closest(OVERLAY_HIT_SELECTOR));
}

export class OverlayPointerController {
  private captures = false;
  private modalCapture = false;
  private forceClickThrough = false;
  private recoveringCapture = false;
  private point: { x: number; y: number } | null = null;

  constructor(
    private readonly setClickThrough: (enabled: boolean) => void,
    private readonly elementFromPoint: (x: number, y: number) => Pick<Element, 'closest'> | null,
  ) {}

  initialize(): void {
    this.captures = false;
    this.modalCapture = false;
    this.recoveringCapture = false;
    this.setClickThrough(true);
  }

  move(x: number, y: number): void {
    this.point = { x, y };
    this.recoveringCapture = false;
    this.refresh();
  }

  setModalCapture(enabled: boolean): void {
    if (enabled === this.modalCapture) return;
    this.modalCapture = enabled;
    this.refresh();
  }

  setForceClickThrough(enabled: boolean): void {
    if (enabled === this.forceClickThrough) return;
    this.forceClickThrough = enabled;
    if (!enabled) {
      // The escape shortcut must recover the controls even when Electron has
      // not forwarded a mouse position yet. The next real mouse move restores
      // transparent-pixel passthrough according to the hit region.
      this.recoveringCapture = true;
      if (!this.captures) {
        this.captures = true;
        this.setClickThrough(false);
      }
      return;
    }
    this.recoveringCapture = false;
    this.refresh();
  }

  refresh(): void {
    if (this.recoveringCapture) return;
    const next = !this.forceClickThrough && (this.modalCapture || Boolean(
      this.point
      && shouldCaptureOverlayPointer(this.elementFromPoint(this.point.x, this.point.y)),
    ));
    if (next === this.captures) return;
    this.captures = next;
    this.setClickThrough(!next);
  }

  dispose(): void {
    this.point = null;
    this.captures = false;
    this.modalCapture = false;
    this.recoveringCapture = false;
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
