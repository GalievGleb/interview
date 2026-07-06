import { describe, expect, it } from 'vitest';
import { captureIsStale } from './liveSession';

// Захват из ws.onopen осиротеет, если за время асинхронного startCapture
// сессию остановили или ws пересоздали при реконнекте. Такой захват (микрофон/
// экран) обязан быть погашен, иначе останется включён навсегда.
const OPEN = 1; // WebSocket.OPEN
const CLOSED = 3;
const openWs = (state = OPEN) => ({ readyState: state }) as unknown as WebSocket;

describe('captureIsStale', () => {
  it('НЕ устарел: та же открытая ws, сессия жива', () => {
    const ws = openWs();
    expect(captureIsStale(false, ws, ws)).toBe(false);
  });

  it('устарел: сессию остановили за время await', () => {
    const ws = openWs();
    expect(captureIsStale(true, ws, ws)).toBe(true);
  });

  it('устарел: ws пересоздан (реконнект) — currentWs !== myWs', () => {
    const myWs = openWs();
    const newWs = openWs();
    expect(captureIsStale(false, newWs, myWs)).toBe(true);
  });

  it('устарел: моя ws уже закрылась', () => {
    const ws = openWs(CLOSED);
    expect(captureIsStale(false, ws, ws)).toBe(true);
  });

  it('устарел: currentWs стал null (cleanup)', () => {
    const myWs = openWs();
    expect(captureIsStale(false, null, myWs)).toBe(true);
  });
});
