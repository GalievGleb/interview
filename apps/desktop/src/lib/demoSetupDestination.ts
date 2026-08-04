export function demoSetupDestination(hasAnyKey: boolean, hasStt: boolean): string | null {
  if (!hasAnyKey) return '/settings?tab=billing';
  if (!hasStt) return '/settings?tab=speech';
  return null;
}
