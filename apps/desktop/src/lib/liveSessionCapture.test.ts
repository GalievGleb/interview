import { describe, expect, it } from 'vitest';
import {
  captureIsStale,
  recoverableSttErrorMessage,
  sendFinalizeControl,
} from './liveSession';

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

describe('recoverable STT errors', () => {
  it('keeps a transient provider 500 out of the fatal socket path', () => {
    expect(
      recoverableSttErrorMessage(
        'OpenAI Mini STT 500: {"statusCode":500,"message":"Internal server error"}',
      ),
    ).toContain('Продолжаю слушать');
  });

  it('does not hide authentication or configuration errors', () => {
    expect(recoverableSttErrorMessage('SkillCue license is unavailable')).toBeNull();
  });
});

describe('sendFinalizeControl', () => {
  it('returns true only when finalize was sent to an open socket', () => {
    const sent: string[] = [];
    const ws = {
      readyState: OPEN,
      send: (value: string) => sent.push(value),
    } as unknown as WebSocket;

    expect(sendFinalizeControl(ws, 'force-1')).toBe(true);
    expect(sent).toEqual([JSON.stringify({ type: 'finalize', request_id: 'force-1' })]);
  });

  it('returns false for a closed or missing socket', () => {
    expect(sendFinalizeControl(openWs(CLOSED), 'force-1')).toBe(false);
    expect(sendFinalizeControl(null, 'force-1')).toBe(false);
  });
});
