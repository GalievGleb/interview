/**
 * Live-session debug recorder.
 *
 * Captures, for one live interview session, a precise timeline of everything the
 * STT/LLM pipeline did (with ms-accurate timestamps relative to "Start") plus the
 * raw microphone audio. The bundle answers "what actually happened, and when" —
 * e.g. how long after Start the first partial arrived, whether an utterance was
 * dropped as low-quality, or where a slow answer came from.
 *
 * Everything here is additive and side-effect free: recording never touches the
 * live pipeline's behaviour.
 */

export interface DebugEvent {
  /** Milliseconds since the session started (Start pressed). */
  tMs: number;
  type:
    | 'session_start'
    | 'ready'
    | 'speech_started'
    | 'partial'
    | 'final'
    | 'low_quality'
    | 'answer_started'
    | 'answer_first_token'
    | 'answer_done'
    | 'error';
  speaker?: 'me' | 'other';
  text?: string;
  reason?: string;
  meta?: Record<string, unknown>;
}

export interface DebugBundle {
  generatedAt: string;
  sampleRate: number;
  durationMs: number;
  audioFile: string | null;
  events: DebugEvent[];
  extra?: Record<string, unknown>;
}

// ~12 minutes of 16 kHz mono PCM16 — enough for any interview, bounded so a long
// session can't grow memory without limit.
const MAX_SAMPLES = 16000 * 60 * 12;

export class LiveDebugRecorder {
  private events: DebugEvent[] = [];
  private audio: Int16Array[] = [];
  private sampleRate = 16000;
  private t0 = 0;
  private samples = 0;

  /** Reset and begin a new recording. */
  start(sampleRate: number): void {
    this.events = [];
    this.audio = [];
    this.samples = 0;
    this.sampleRate = sampleRate || 16000;
    this.t0 = performance.now();
    this.event('session_start', { meta: { sampleRate: this.sampleRate } });
  }

  setSampleRate(sampleRate: number): void {
    if (sampleRate) this.sampleRate = sampleRate;
  }

  event(type: DebugEvent['type'], data: Omit<Partial<DebugEvent>, 'type' | 'tMs'> = {}): void {
    if (this.t0 === 0) return; // not started
    this.events.push({ tMs: Math.round(performance.now() - this.t0), type, ...data });
  }

  /** Tee one PCM16 frame (the exact bytes sent to the server). */
  audioFrame(buffer: ArrayBuffer): void {
    if (this.t0 === 0 || this.samples >= MAX_SAMPLES) return;
    const frame = new Int16Array(buffer.slice(0));
    this.audio.push(frame);
    this.samples += frame.length;
  }

  hasData(): boolean {
    return this.events.length > 0;
  }

  private durationMs(): number {
    return this.t0 === 0 ? 0 : Math.round(performance.now() - this.t0);
  }

  buildJson(audioFile: string | null, extra?: Record<string, unknown>): DebugBundle {
    return {
      generatedAt: new Date().toISOString(),
      sampleRate: this.sampleRate,
      durationMs: this.durationMs(),
      audioFile,
      events: this.events,
      extra,
    };
  }

  /** Encode the recorded PCM16 frames into a mono WAV blob (or null if silent). */
  buildWav(): Blob | null {
    if (this.samples === 0) return null;
    const pcm = new Int16Array(this.samples);
    let offset = 0;
    for (const frame of this.audio) {
      pcm.set(frame, offset);
      offset += frame.length;
    }
    return encodeWav(pcm, this.sampleRate);
  }
}

/** Minimal 16-bit mono PCM → WAV container. */
export function encodeWav(pcm: Int16Array, sampleRate: number): Blob {
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeStr = (pos: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(pos + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  let pos = 44;
  for (let i = 0; i < pcm.length; i += 1, pos += 2) view.setInt16(pos, pcm[i], true);
  return new Blob([buffer], { type: 'audio/wav' });
}
