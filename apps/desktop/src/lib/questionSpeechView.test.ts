import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const viewSource = fs.readFileSync(
  path.resolve(__dirname, '../components/prepare/SmokeInterviewView.tsx'),
  'utf8',
);
const russianMessages = fs.readFileSync(path.resolve(__dirname, 'i18n/ru.ts'), 'utf8');
const englishMessages = fs.readFileSync(path.resolve(__dirname, 'i18n/en.ts'), 'utf8');
const prepareStyles = fs.readFileSync(path.resolve(__dirname, '../styles/prepare.css'), 'utf8');
const hookSource = fs.readFileSync(
  path.resolve(__dirname, '../hooks/useQuestionSpeech.ts'),
  'utf8',
);

describe('mock interview question speech UI', () => {
  it('uses managed question speech instead of speaking directly through Web Speech', () => {
    expect(viewSource).toContain("import { useQuestionSpeech } from '../../hooks/useQuestionSpeech'");
    expect(viewSource).toContain('const questionSpeech = useQuestionSpeech()');
    expect(viewSource).not.toContain('new SpeechSynthesisUtterance');
  });

  it('prefetches the next question and exposes each playback state', () => {
    expect(viewSource).toContain('questions[currentIndex + 1]?.question');
    expect(viewSource).toContain('prefetch(nextText, lang)');
    expect(viewSource).toContain("questionSpeech.state === 'loading'");
    expect(viewSource).toContain("questionSpeech.state === 'playing'");
    expect(viewSource).toContain("questionSpeech.state === 'error'");
  });

  it('labels AI and fallback speech in both languages with a compact styled control', () => {
    for (const messages of [russianMessages, englishMessages]) {
      expect(messages).toContain("'prep.smoke.aiVoice'");
      expect(messages).toContain("'prep.smoke.localVoice'");
      expect(messages).toContain("'prep.smoke.speechLoading'");
      expect(messages).toContain("'prep.smoke.speechRetry'");
    }
    expect(prepareStyles).toContain('.prep-question-speech');
    expect(prepareStyles).toContain('.prep-question-speech__source');
  });

  it('ignores a stale fallback request instead of overwriting the latest state', () => {
    const staleGuard = hookSource.indexOf('if (generation !== generationRef.current) return;');
    const unavailableState = hookSource.indexOf("setState('error')", staleGuard);
    expect(staleGuard).toBeGreaterThan(-1);
    expect(unavailableState).toBeGreaterThan(staleGuard);
  });

  it('funnels media failures through one idempotent fallback and resets its disclosure', () => {
    expect(hookSource).toContain('let fallbackStarted = false;');
    expect(hookSource).toContain('if (fallbackStarted) return;');
    expect(hookSource).toContain('setUsedFallback(false);');
  });

  it('waits for Chromium voiceschanged before choosing the local fallback voice', () => {
    expect(hookSource).toContain('waitForFallbackVoice(synth, language)');
  });
});
