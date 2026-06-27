// Ring buffer of recently-skipped/low-quality STT utterances, surfaced on the
// Diagnostics screen (honest failure reporting). Stored in localStorage so the
// Diagnostics route — which has no live session of its own — can read them.
export interface SkippedEntry {
  at: number;
  reason: string;
  detail: string;
}

const KEY = 'skillcue:skipped';
const MAX = 12;

export function recordSkipped(reason: string, detail: string): void {
  try {
    const raw = localStorage.getItem(KEY);
    const list: SkippedEntry[] = raw ? JSON.parse(raw) : [];
    list.unshift({ at: Date.now(), reason: reason || 'skipped', detail: (detail || '').slice(0, 140) });
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* storage unavailable */
  }
}

export function readSkipped(): SkippedEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SkippedEntry[]) : [];
  } catch {
    return [];
  }
}
