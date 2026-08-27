export function subscribeToSessionHistoryRefresh(
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  refresh: () => void,
): () => void {
  const handler = () => refresh();
  target.addEventListener('skillcue:live-stop', handler);
  target.addEventListener('focus', handler);
  return () => {
    target.removeEventListener('skillcue:live-stop', handler);
    target.removeEventListener('focus', handler);
  };
}
