import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { clampFloatingPanel, type FloatingPlacement } from '../lib/overlayPointerPolicy';

interface ActiveTooltip {
  trigger: HTMLElement;
  text: string;
  placement: FloatingPlacement;
}

export default function OverlayTooltipLayer({
  rootRef,
}: {
  rootRef: RefObject<HTMLElement | null>;
}) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<ActiveTooltip | null>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });

  const positionTooltip = useCallback(() => {
    if (!active || !tooltipRef.current || !active.trigger.isConnected) return;
    setPosition(
      clampFloatingPanel(
        active.trigger.getBoundingClientRect(),
        tooltipRef.current.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight },
        active.placement,
      ),
    );
  }, [active]);

  useLayoutEffect(positionTooltip, [positionTooltip]);

  useEffect(() => {
    if (!active) return;
    window.addEventListener('resize', positionTooltip);
    return () => window.removeEventListener('resize', positionTooltip);
  }, [active, positionTooltip]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const findTrigger = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Element)) return null;
      const trigger = target.closest<HTMLElement>('.tip[data-tip]');
      return trigger && root.contains(trigger) ? trigger : null;
    };
    const show = (target: EventTarget | null) => {
      const trigger = findTrigger(target);
      const text = trigger?.dataset.tip?.trim();
      if (!trigger || !text) return;
      setActive({
        trigger,
        text,
        placement: trigger.closest('.ovl-bar') ? 'top' : 'bottom',
      });
    };
    const hide = (target: EventTarget | null, relatedTarget: EventTarget | null) => {
      const trigger = findTrigger(target);
      if (!trigger) return;
      if (relatedTarget instanceof Node && trigger.contains(relatedTarget)) return;
      setActive((current) => (current?.trigger === trigger ? null : current));
    };
    const onPointerOver = (event: PointerEvent) => show(event.target);
    const onPointerOut = (event: PointerEvent) => hide(event.target, event.relatedTarget);
    const onFocusIn = (event: FocusEvent) => show(event.target);
    const onFocusOut = (event: FocusEvent) => hide(event.target, event.relatedTarget);

    root.addEventListener('pointerover', onPointerOver);
    root.addEventListener('pointerout', onPointerOut);
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    return () => {
      root.removeEventListener('pointerover', onPointerOver);
      root.removeEventListener('pointerout', onPointerOut);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
    };
  }, [rootRef]);

  if (!active) return null;
  return (
    <div
      ref={tooltipRef}
      role="tooltip"
      data-overlay-hit="true"
      className="ovl-tooltip-layer"
      style={{ left: position.left, top: position.top }}
    >
      {active.text}
    </div>
  );
}
