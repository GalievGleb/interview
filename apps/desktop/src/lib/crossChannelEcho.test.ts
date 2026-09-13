import { afterEach, expect, it, vi } from 'vitest';
import { CrossChannelEchoGate, isPlaybackEcho } from './crossChannelEcho';

afterEach(() => vi.useRealTimers());

it('removes mic playback whether system final arrives before or after mic final', () => {
  vi.useFakeTimers();
  for (const micFirst of [true, false]) {
    const gate = new CrossChannelEchoGate();
    const mic = vi.fn();
    const system = vi.fn();
    const text = 'Знаешь ли ты хорошие паттерны автоматизации?';
    if (micFirst) gate.accept('mic', text, true, mic);
    gate.accept('system', text, true, system);
    if (!micFirst) gate.accept('mic', text, false, mic);
    vi.advanceTimersByTime(6_000);
    expect(mic).not.toHaveBeenCalled();
    expect(system).toHaveBeenCalledOnce();
  }
});

it('keeps a candidate clarification and flushes it when stopping', () => {
  vi.useFakeTimers();
  const gate = new CrossChannelEchoGate();
  const own = vi.fn();
  gate.accept('system', 'Знаешь ли ты хорошие паттерны автоматизации?', false, () => {});
  gate.accept('mic', 'Получается мне нужно рассказать про последний проект правильно', false, own);
  gate.finish();
  expect(own).toHaveBeenCalledOnce();
  vi.runAllTimers();
  expect(own).toHaveBeenCalledOnce();
});

it('matches split playback but preserves short answers and different speech', () => {
  expect(isPlaybackEcho('и также расскажи про техники тест-дизайна, которые ты используешь в своей работе.',
    'Привет! Расскажи, пожалуйста, про техники тест-дизайна, которые ты знаешь, и также расскажи про техники тест-дизайна, которые ты используешь в своей работе.')).toBe(true);
  expect(isPlaybackEcho('Да, знаю', 'Да, знаю')).toBe(false);
  expect(isPlaybackEcho('Я применял Page Object в проекте магазина', 'Знаешь ли ты хорошие паттерны автоматизации?')).toBe(false);
});
