import { useLayoutEffect, useRef } from 'react';
import { OverlayPointerController } from '../lib/overlayPointerPolicy';

export function useOverlayPointer(clickThrough: boolean, menuOpen: boolean) {
  const controllerRef = useRef<OverlayPointerController | null>(null);
  useLayoutEffect(() => {
    const setClickThrough = window.electronAPI?.overlay.setClickThrough;
    if (!setClickThrough) return;
    const controller = new OverlayPointerController(
      enabled => void setClickThrough(enabled),
      (x, y) => document.elementFromPoint(x, y),
    );
    controllerRef.current = controller;
    controller.initialize();
    const onMove = (event: MouseEvent) => controller.move(event.clientX, event.clientY);
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      controllerRef.current = null;
      controller.dispose();
    };
  }, []);
  useLayoutEffect(() => {
    controllerRef.current?.setForceClickThrough(clickThrough);
    controllerRef.current?.setModalCapture(menuOpen);
    controllerRef.current?.refresh();
  });
  return controllerRef;
}
