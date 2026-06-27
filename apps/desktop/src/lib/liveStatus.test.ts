import { describe, expect, it } from 'vitest';
import { deriveLiveState } from './liveStatus';

describe('deriveLiveState', () => {
  it('is idle when nothing is happening', () => {
    const s = deriveLiveState({ active: false, isGenerating: false, streaming: false, hasAnswer: false });
    expect(s).toEqual({ tone: 'idle', label: 'Idle', flowStep: -1 });
  });

  it('is listening while a live session runs and is not generating', () => {
    const s = deriveLiveState({ active: true, isGenerating: false, streaming: false, hasAnswer: false });
    expect(s.tone).toBe('listening');
    expect(s.label).toBe('Listening');
    expect(s.flowStep).toBe(0);
  });

  it('shows Transcribing when generating but no tokens yet', () => {
    const s = deriveLiveState({ active: true, isGenerating: true, streaming: false, hasAnswer: false });
    expect(s.tone).toBe('processing');
    expect(s.label).toBe('Transcribing');
    expect(s.flowStep).toBe(1);
  });

  it('shows Answering once tokens stream', () => {
    const s = deriveLiveState({ active: true, isGenerating: true, streaming: true, hasAnswer: true });
    expect(s.tone).toBe('processing');
    expect(s.label).toBe('Answering');
    expect(s.flowStep).toBe(2);
  });

  it('is answer-ready after a manual answer when not live', () => {
    const s = deriveLiveState({ active: false, isGenerating: false, streaming: false, hasAnswer: true });
    expect(s.tone).toBe('ready');
    expect(s.label).toBe('Answer ready');
    expect(s.flowStep).toBe(-1);
  });
});
