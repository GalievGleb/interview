import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import scenariosDocument from '../../../../tests/real-interview-overlay/scenarios.json';
import { QueuedRendererSignal } from '../../electron/queuedRendererSignal';
import { closeUnmatchedFinalFence } from '../components/MarkdownText';
import {
  ActiveScreenTaskContextMemory,
  CandidateFollowUpGenerationOwner,
  dispatchOwnedCandidateFollowUp,
} from '../lib/candidateFollowUp';
import { api } from '../lib/api';
import { LatestForcedAnswerCoordinator } from '../lib/latestForcedAnswer';
import { ScreenFrameMemory } from '../lib/screenFrameMemory';
import {
  presentScreenRequestTerminal,
  ScreenRequestCoordinator,
} from '../lib/screenRequestCoordinator';

type CandidateColdStartInvariant =
  | 'single_candidate_request'
  | 'candidate_phrase_context'
  | 'merged_phrase_is_task_root'
  | 'no_cancel_before_selection'
  | 'partial_error_not_persisted';

interface ScenarioById {
  'candidate-cold-start-active-speech': {
    expectedSelectedPhrase: string;
    invariants: CandidateColdStartInvariant[];
  };
  'duplicate-screen-command': { captureDelayMs: number; streamChunks: string[] };
  'screen-first-answer-at-26000ms': {
    transportCommentAtMs: number[];
    firstChunkAtMs: number;
  };
  'truncated-code-stream': { providerText: string };
}

function scenario<T extends keyof ScenarioById>(id: T): ScenarioById[T] {
  const selected = scenariosDocument.scenarios.find((item) => item.id === id);
  if (!selected) throw new Error(`Missing shared scenario: ${id}`);
  return selected as unknown as ScenarioById[T];
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('sanitized real-interview overlay sequences', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { electronAPI: { getApiToken: async () => '' } });
    vi.stubGlobal('localStorage', { getItem: () => null });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('replays the cold-start candidate signal and merges the owned final once', () => {
    const contract = scenario('candidate-cold-start-active-speech');
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const signal = new QueuedRendererSignal({
      on: (channel, listener) => listeners.set(channel, listener),
    }, 'overlay:candidate-follow-up');
    listeners.get('overlay:candidate-follow-up')?.();
    let presses = 0;
    signal.subscribe(() => { presses += 1; });

    const coordinator = new LatestForcedAnswerCoordinator(
      () => 'candidate-finalize-1',
      () => 1_000,
    );
    const owner = new CandidateFollowUpGenerationOwner();
    const existing = [{
      sequence: 1,
      text: 'Нужно добавить проверки',
      source: 'mic' as const,
      capturedAtMs: 900,
    }];
    const pressed = coordinator.press(existing, 'mic', true);
    expect(pressed).toMatchObject({ action: 'flush', generation: 1 });
    if (pressed.action !== 'flush') throw new Error('Expected candidate finalization');
    owner.begin(pressed.generation, null);
    const boundary = { cancellations: 0, providerRequests: 0 };
    expect(dispatchOwnedCandidateFollowUp({
      owner,
      generation: pressed.generation + 1,
      candidatePhrase: 'stale final',
      cancelActiveScreen: () => { boundary.cancellations += 1; },
      requestProvider: () => { boundary.providerRequests += 1; },
    })).toBeNull();
    expect(boundary).toEqual({ cancellations: 0, providerRequests: 0 });
    const selected = coordinator.acceptFinal({
      sequence: 2,
      text: 'граничных значений и пустого списка.',
      source: 'mic',
      capturedAtMs: 950,
    }, pressed.requestId);
    expect(selected).toMatchObject({
      action: 'submit',
      question: contract.expectedSelectedPhrase,
    });
    if (selected.action !== 'submit') throw new Error('Expected owned final');
    const followUp = dispatchOwnedCandidateFollowUp({
      owner,
      generation: selected.generation,
      candidatePhrase: selected.question,
      cancelActiveScreen: () => { boundary.cancellations += 1; },
      requestProvider: () => { boundary.providerRequests += 1; },
    });
    expect(dispatchOwnedCandidateFollowUp({
      owner,
      generation: selected.generation,
      candidatePhrase: selected.question,
      cancelActiveScreen: () => { boundary.cancellations += 1; },
      requestProvider: () => { boundary.providerRequests += 1; },
    })).toBeNull();
    const taskMemory = new ActiveScreenTaskContextMemory(() => 1_000);
    taskMemory.publishCandidateResult({
      rootQuestion: followUp!.taskRootQuestion,
      currentQuestion: followUp!.taskCurrentQuestion,
      answer: 'Полный ответ.',
    });
    const beforeError = taskMemory.snapshot();
    const failed = taskMemory.settleCandidateStream({
      completed: false,
      rootQuestion: followUp!.taskRootQuestion,
      currentQuestion: 'частичный ответ',
      answer: 'обрезано',
    });

    const observed: Record<CandidateColdStartInvariant, boolean> = {
      single_candidate_request: presses === 1 && boundary.providerRequests === 1,
      candidate_phrase_context: followUp?.contextSource === 'candidate_phrase',
      merged_phrase_is_task_root:
        followUp?.taskRootQuestion === contract.expectedSelectedPhrase
        && followUp?.taskCurrentQuestion === contract.expectedSelectedPhrase,
      no_cancel_before_selection: boundary.cancellations === 1,
      partial_error_not_persisted:
        failed.persistHistory === false
        && JSON.stringify(taskMemory.snapshot()) === JSON.stringify(beforeError),
    };
    expect(new Set(contract.invariants)).toEqual(new Set(Object.keys(observed)));
    for (const invariant of contract.invariants) expect(observed[invariant]).toBe(true);
  });

  it('coalesces a duplicate screen press but permits a new request after done', async () => {
    vi.useFakeTimers();
    const contract = scenario('duplicate-screen-command');
    const coordinator = new ScreenRequestCoordinator({ captureTimeoutMs: 10_000 });
    const counters = { captures: 0, streams: 0, cancellations: 0, terminals: 0 };
    let terminalAnswer = '';
    const operation = () => ({
      capture: () => new Promise<string>((resolve) => {
        counters.captures += 1;
        setTimeout(() => resolve('data:image/jpeg;base64,current'), contract.captureDelayMs);
      }),
      startStream: (_image: string, handlers: {
        onChunk: (text: string) => void;
        onDone: () => void;
      }) => {
        counters.streams += 1;
        setTimeout(() => {
          for (const chunk of contract.streamChunks) handlers.onChunk(chunk);
          handlers.onDone();
        }, 0);
        return () => { counters.cancellations += 1; };
      },
      onTerminal: (result: { answer: string }) => {
        counters.terminals += 1;
        terminalAnswer += result.answer;
      },
    });

    expect(coordinator.start(operation())).not.toBeNull();
    expect(coordinator.start(operation())).toBeNull();
    await vi.advanceTimersByTimeAsync(contract.captureDelayMs);
    await vi.advanceTimersByTimeAsync(1);
    expect(counters).toEqual({ captures: 1, streams: 1, cancellations: 0, terminals: 1 });
    expect(terminalAnswer).toBe(contract.streamChunks.join(''));

    expect(coordinator.start(operation())).not.toBeNull();
    await vi.advanceTimersByTimeAsync(contract.captureDelayMs);
    await vi.advanceTimersByTimeAsync(1);
    expect(counters.captures).toBe(2);
    expect(counters.streams).toBe(2);
    expect(counters.terminals).toBe(2);
  });

  it('survives the exact 26-second first-answer edge because comments rearm byte idle', async () => {
    vi.useFakeTimers();
    const contract = scenario('screen-first-answer-at-26000ms');
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream({
      start(value) { controller = value; },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const chunks: string[] = [];
    const done = vi.fn();
    const error = vi.fn();

    api.streamScreenAssist('data:image/jpeg;base64,current', 'question', {
      onChunk: (text) => chunks.push(text),
      onDone: done,
      onError: error,
    });
    await flushAsync();
    await vi.advanceTimersByTimeAsync(contract.transportCommentAtMs[0]);
    controller.enqueue(encoder.encode(': keepalive\n\n'));
    await flushAsync();
    await vi.advanceTimersByTimeAsync(
      contract.transportCommentAtMs[1] - contract.transportCommentAtMs[0],
    );
    controller.enqueue(encoder.encode(': keepalive\n\n'));
    await flushAsync();
    await vi.advanceTimersByTimeAsync(
      contract.firstChunkAtMs - contract.transportCommentAtMs[1],
    );
    controller.enqueue(encoder.encode('data: {"type":"chunk","text":"ответ"}\n\n'));
    controller.enqueue(encoder.encode('data: {"type":"done"}\n\n'));
    controller.close();
    await flushAsync();

    expect(chunks).toEqual(['ответ']);
    expect(done).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('keeps previous/current frame order, bounds summaries and clears all pixels', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const memory = new ScreenFrameMemory(() => Date.now());
    const frame1 = 'data:image/jpeg;base64,previous-1';
    const frame2 = 'data:image/jpeg;base64,previous-2';
    const current = 'data:image/jpeg;base64,current';
    memory.remember(frame1);
    memory.remember(frame2);
    memory.setPriorSolutionSummary(`START\n${'x'.repeat(20_000)}\nLATEST_TAIL`);

    expect(memory.previousFramesFor(current)).toEqual([frame1, frame2]);
    expect(memory.priorSolutionSummary()!.length).toBeLessThanOrEqual(5_200);
    expect(memory.priorSolutionSummary()).toContain('LATEST_TAIL');
    memory.clear();
    expect(memory.previousFramesFor(current)).toEqual([]);
    expect(memory.priorSolutionSummary()).toBeUndefined();
  });

  it('keeps partial truncation visible but never marks or persists it as complete', async () => {
    const contract = scenario('truncated-code-stream');
    const encoder = new TextEncoder();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ type: 'chunk', text: contract.providerText })}\n\n`,
        ));
        controller.enqueue(encoder.encode(
          'data: {"type":"error","message":"Ответ оборвался из-за лимита модели."}\n\n',
        ));
        controller.close();
      },
    }), { status: 200 })));
    let partial = '';
    let terminal: ReturnType<typeof presentScreenRequestTerminal> | null = null;
    const memory = new ActiveScreenTaskContextMemory(() => 1_000);

    api.streamScreenAssist('data:image/jpeg;base64,current', 'question', {
      onChunk: (text) => { partial += text; },
      onDone: () => {
        terminal = presentScreenRequestTerminal({ status: 'done', answer: partial });
      },
      onError: (message) => {
        terminal = presentScreenRequestTerminal({ status: 'error', answer: partial, message });
      },
    });
    await vi.waitFor(() => expect(terminal).not.toBeNull());
    const original = partial;
    const repaired = closeUnmatchedFinalFence(partial);

    expect(terminal).toMatchObject({ complete: false, text: contract.providerText });
    expect(memory.snapshot()).toBeNull();
    expect(original).toBe(contract.providerText);
    expect(repaired).toBe(`${contract.providerText}\n\`\`\``);
    expect(closeUnmatchedFinalFence(repaired)).toBe(repaired);
  });
});
