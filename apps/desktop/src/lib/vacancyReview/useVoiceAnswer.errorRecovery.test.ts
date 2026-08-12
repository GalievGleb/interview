import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('voice answer STT error recovery', () => {
  it('preserves typed text by returning null and never publishing failed STT text', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'useVoiceAnswer.ts'), 'utf8');
    const transcribe = source.match(/const transcribeBlob = useCallback\(async \(wav: Blob\) => \{([\s\S]*?)\n\s*\}, \[/);

    expect(transcribe?.[1]).toContain('catch');
    expect(transcribe?.[1]).toContain('return null');
    expect(transcribe?.[1]).toContain('onTextRef.current(transcript)');
    expect(transcribe?.[1]).not.toContain('cleanVoiceAnswerTranscriptText');
  });

  it('keeps a completed recording for preview and retry before transcription', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'useVoiceAnswer.ts'), 'utf8');

    expect(source).toContain('URL.createObjectURL(wav)');
    expect(source).toContain('previewBlobRef.current = wav');
    expect(source).toContain('transcribePreview');
    expect(source).toContain('Распознавание временно недоступно. Запись сохранена');
  });

  it('aborts an in-flight answer upload when the recording operation is cancelled', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'useVoiceAnswer.ts'), 'utf8');

    expect(source).toContain('new AbortController()');
    expect(source).toContain('transcriptionAbortRef.current?.abort()');
    expect(source).toContain('signal: controller.signal');
  });
});
