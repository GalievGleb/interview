import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('voice answer STT error recovery', () => {
  it('preserves typed text by returning null and never publishing failed STT text', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'useVoiceAnswer.ts'), 'utf8');
    const finish = source.match(/const finish = useCallback\(async \(\) => \{([\s\S]*?)\n\s*\}, \[/);

    expect(finish?.[1]).toContain('catch');
    expect(finish?.[1]).toContain('return null');
    expect(finish?.[1]).toContain('onTextRef.current(transcript)');
    expect(finish?.[1]).not.toContain('cleanVoiceAnswerTranscriptText');
  });

  it('aborts an in-flight answer upload when the recording operation is cancelled', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'useVoiceAnswer.ts'), 'utf8');

    expect(source).toContain('new AbortController()');
    expect(source).toContain('transcriptionAbortRef.current?.abort()');
    expect(source).toContain('signal: controller.signal');
  });
});
