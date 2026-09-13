type Source = 'mic' | 'system';

/** Conservative text fallback for speaker audio leaking into the microphone. */
export function isPlaybackEcho(mic: string, system: string): boolean {
  const words = (text: string) => text.toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}]+/gu) ?? [];
  const own = words(mic);
  const playback = new Set(words(system));
  if (own.length < 5) return false;
  return own.filter((word) => playback.has(word)).length / own.length >= 0.88;
}

export class CrossChannelEchoGate {
  private recent: { text: string; at: number }[] = [];
  private pending = new Set<{ text: string; emit: () => void; timer: ReturnType<typeof setTimeout> }>();

  hasPendingMicrophone(): boolean {
    return this.pending.size > 0;
  }

  accept(source: Source, text: string, systemSpeaking: boolean, emit: () => void): void {
    const now = Date.now();
    this.recent = this.recent.filter((entry) => now - entry.at < 8_000);
    if (source === 'system') {
      this.recent.push({ text, at: now });
      for (const entry of this.pending) {
        if (!isPlaybackEcho(entry.text, text)) continue;
        clearTimeout(entry.timer);
        this.pending.delete(entry);
      }
      emit();
      return;
    }
    if (this.recent.some((entry) => isPlaybackEcho(text, entry.text))) return;
    const entry = { text, emit, timer: undefined as unknown as ReturnType<typeof setTimeout> };
    entry.timer = setTimeout(() => {
      this.pending.delete(entry);
      emit();
    }, systemSpeaking ? 5_500 : 1_800);
    this.pending.add(entry);
  }

  finish(): void {
    for (const entry of this.pending) {
      clearTimeout(entry.timer);
      entry.emit();
    }
    this.pending.clear();
    this.recent = [];
  }
}
