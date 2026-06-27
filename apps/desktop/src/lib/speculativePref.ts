// Speculative answering: start the LLM on a stable partial transcript before the
// final arrives. Opt-in (default OFF) — it can waste a token budget when the
// partial differs from the final, so the user enables it deliberately.
const KEY = 'skillcue:speculative';

export function isSpeculativeEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setSpeculative(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}
