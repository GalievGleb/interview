import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearErrorLog,
  getErrorLog,
  isErrorLogEnabled,
  recordError,
  setErrorLogEnabled,
} from './errorLog';

function createStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => void store.delete(k),
    setItem: (k: string, v: string) => void store.set(k, v),
  };
}

describe('errorLog', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage(),
      configurable: true,
    });
    localStorage.clear();
  });

  it('records errors newest-first with source, message, stack', () => {
    recordError('render', 'boom', 'stack-trace-here');
    recordError('window', 'kaboom');
    const log = getErrorLog();
    expect(log).toHaveLength(2);
    expect(log[0].message).toBe('kaboom'); // newest first
    expect(log[1].source).toBe('render');
    expect(log[1].stack).toBe('stack-trace-here');
  });

  it('caps the ring buffer (does not grow unbounded)', () => {
    for (let i = 0; i < 60; i++) recordError('window', `err ${i}`);
    expect(getErrorLog().length).toBeLessThanOrEqual(40);
    // newest kept
    expect(getErrorLog()[0].message).toBe('err 59');
  });

  it('opt-out disables recording AND wipes accumulated log', () => {
    recordError('window', 'before opt-out');
    expect(getErrorLog()).toHaveLength(1);
    setErrorLogEnabled(false);
    expect(isErrorLogEnabled()).toBe(false);
    expect(getErrorLog()).toHaveLength(0); // wiped
    recordError('window', 'after opt-out');
    expect(getErrorLog()).toHaveLength(0); // not recorded
  });

  it('re-enabling resumes recording', () => {
    setErrorLogEnabled(false);
    setErrorLogEnabled(true);
    expect(isErrorLogEnabled()).toBe(true);
    recordError('window', 'again');
    expect(getErrorLog()).toHaveLength(1);
  });

  it('truncates over-long stacks', () => {
    recordError('render', 'x', 'a'.repeat(5000));
    expect((getErrorLog()[0].stack ?? '').length).toBeLessThanOrEqual(2000);
  });

  it('clearErrorLog empties the buffer', () => {
    recordError('window', 'x');
    clearErrorLog();
    expect(getErrorLog()).toHaveLength(0);
  });
});
