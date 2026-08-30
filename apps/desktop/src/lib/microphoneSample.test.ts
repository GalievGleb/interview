import { describe, expect, it } from 'vitest';
import {
  createMicrophoneSampleConstraints,
  formatMicrophoneSampleDuration,
  microphoneSampleReducer,
  startMicrophoneSampleCapture,
  type MicrophoneSampleState,
} from './microphoneSample';

describe('microphone sample', () => {
  it('records the selected microphone with the same voice processing as live capture', () => {
    expect(createMicrophoneSampleConstraints('desk-mic')).toEqual({
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      deviceId: { ideal: 'desk-mic' },
    });
    expect(createMicrophoneSampleConstraints('')).toEqual({
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
  });

  it('formats elapsed recording time without rounding ahead', () => {
    expect(formatMicrophoneSampleDuration(0)).toBe('0:00');
    expect(formatMicrophoneSampleDuration(999)).toBe('0:00');
    expect(formatMicrophoneSampleDuration(1_000)).toBe('0:01');
    expect(formatMicrophoneSampleDuration(65_999)).toBe('1:05');
  });

  it('moves one local recording through record, playback and reset states', () => {
    const idle: MicrophoneSampleState = {
      status: 'idle',
      elapsedMs: 0,
      durationMs: 0,
      level: 0,
      error: '',
    };

    const recording = microphoneSampleReducer(idle, { type: 'recording-started' });
    expect(recording).toEqual({
      status: 'recording',
      elapsedMs: 0,
      durationMs: 0,
      level: 0,
      error: '',
    });

    const withSignal = microphoneSampleReducer(recording, {
      type: 'recording-progress',
      elapsedMs: 4_240,
      level: 63,
    });
    expect(withSignal.status).toBe('recording');
    expect(withSignal.elapsedMs).toBe(4_240);
    expect(withSignal.level).toBe(63);

    const ready = microphoneSampleReducer(withSignal, {
      type: 'recording-ready',
      durationMs: 4_240,
    });
    expect(ready).toEqual({
      status: 'ready',
      elapsedMs: 4_240,
      durationMs: 4_240,
      level: 0,
      error: '',
    });
    expect(microphoneSampleReducer(ready, { type: 'playback-started' }).status).toBe('playing');
    expect(
      microphoneSampleReducer(
        { ...ready, status: 'playing' },
        { type: 'playback-stopped' },
      ).status,
    ).toBe('ready');
    expect(microphoneSampleReducer(ready, { type: 'reset' })).toEqual(idle);
  });

  it('returns to an actionable idle state when microphone access fails', () => {
    const state = microphoneSampleReducer(
      {
        status: 'recording',
        elapsedMs: 500,
        durationMs: 0,
        level: 30,
        error: '',
      },
      { type: 'failed', message: 'Доступ к микрофону отклонён' },
    );

    expect(state).toEqual({
      status: 'idle',
      elapsedMs: 0,
      durationMs: 0,
      level: 0,
      error: 'Доступ к микрофону отклонён',
    });
  });

  it('returns one playable blob and releases the microphone after stop', async () => {
    let requestedConstraints: MediaStreamConstraints | undefined;
    let recorderOptions: MediaRecorderOptions | undefined;
    let trackStopped = false;
    const stream = {
      getTracks: () => [{ stop: () => { trackStopped = true; } }],
    } as unknown as MediaStream;
    const recorder = {
      state: 'inactive' as RecordingState,
      mimeType: 'audio/webm;codecs=opus',
      ondataavailable: null as ((event: { data: Blob }) => void) | null,
      onstop: null as (() => void) | null,
      onerror: null as ((event: Event) => void) | null,
      start() {
        this.state = 'recording';
      },
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) });
        this.onstop?.();
      },
    };

    const capture = await startMicrophoneSampleCapture('desk-mic', {
      getUserMedia: async (constraints) => {
        requestedConstraints = constraints;
        return stream;
      },
      createRecorder: (_stream, options) => {
        recorderOptions = options;
        return recorder;
      },
      isTypeSupported: (mimeType) => mimeType === 'audio/webm;codecs=opus',
    });
    const blob = await capture.stop();

    expect(requestedConstraints).toEqual({
      audio: createMicrophoneSampleConstraints('desk-mic'),
    });
    expect(recorderOptions).toEqual({ mimeType: 'audio/webm;codecs=opus' });
    expect(await blob.text()).toBe('voice');
    expect(blob.type).toBe('audio/webm;codecs=opus');
    expect(trackStopped).toBe(true);
  });

  it('releases the microphone when recorder construction fails', async () => {
    let trackStopped = false;
    const stream = {
      getTracks: () => [{ stop: () => { trackStopped = true; } }],
    } as unknown as MediaStream;

    await expect(
      startMicrophoneSampleCapture('', {
        getUserMedia: async () => stream,
        createRecorder: () => {
          throw new Error('recorder unavailable');
        },
        isTypeSupported: () => false,
      }),
    ).rejects.toThrow('recorder unavailable');
    expect(trackStopped).toBe(true);
  });
});
