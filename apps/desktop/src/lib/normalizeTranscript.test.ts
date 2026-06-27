import { describe, it, expect } from 'vitest';
import {
  isGarbageTranscript,
  isNonQuestionFragment,
  looksLikeQuestion,
  normalizeTranscript,
} from './normalizeTranscript';

describe('quality gate — non-question fragments', () => {
  it('does NOT treat «как-то/как бы…» filler as a question', () => {
    expect(looksLikeQuestion('Как-то мы сразу убрали.')).toBe(false);
    expect(looksLikeQuestion('Как бы мы это потом делали')).toBe(false);
    expect(isNonQuestionFragment('Как-то мы сразу убрали.')).toBe(true);
  });

  it('flags short «?»-fragments with no intent as non-questions', () => {
    expect(isNonQuestionFragment('Вместе или не?')).toBe(true);
    expect(isNonQuestionFragment('Спасибо.')).toBe(true);
    expect(isNonQuestionFragment('Слышите?')).toBe(true);
  });

  it('still accepts real questions and tech-entity questions', () => {
    expect(looksLikeQuestion('Как ты настраивал Docker на проекте?')).toBe(true);
    expect(isNonQuestionFragment('Как ты настраивал Docker на проекте?')).toBe(false);
    expect(looksLikeQuestion('Какие бывают виды тестирования?')).toBe(true);
    expect(isNonQuestionFragment('Какие бывают виды тестирования?')).toBe(false);
  });
});

describe('normalizeTranscript', () => {
  it('does not duplicate the Cyrillic ending of тест-дизайна', () => {
    expect(normalizeTranscript('Какие бывают техники тест-дизайна?')).toBe(
      'Какие бывают техники тест-дизайна?',
    );
    // Must not produce the double-«а» artifact.
    expect(normalizeTranscript('тест-дизайна')).not.toContain('дизайнаа');
  });

  it('still normalizes split/loose тест дизайн forms', () => {
    expect(normalizeTranscript('тест дизайн')).toContain('тест-дизайна');
  });

  it('leaves ordinary text unchanged', () => {
    expect(normalizeTranscript('Какие бывают виды тестирования?')).toBe(
      'Какие бывают виды тестирования?',
    );
  });
});

describe('looksLikeQuestion', () => {
  it('recognizes «ли» yes/no questions even without a question mark', () => {
    expect(looksLikeQuestion('Настраивал ли ты сам pipeline.')).toBe(true);
    expect(looksLikeQuestion('Будешь ли ты закрывать баг перед релизом')).toBe(true);
    expect(looksLikeQuestion('Использовал ли ты Docker на проекте')).toBe(true);
  });

  it('still recognizes wh-questions and question marks', () => {
    expect(looksLikeQuestion('Какие бывают виды тестирования?')).toBe(true);
    expect(looksLikeQuestion('Расскажи про свой опыт работы')).toBe(true);
  });

  it('does not treat plain statements as questions', () => {
    expect(looksLikeQuestion('Я настраивал пайплайн на прошлой работе')).toBe(false);
    expect(looksLikeQuestion('Меня зовут Глеб')).toBe(false);
  });
});

describe('isGarbageTranscript', () => {
  it('flags empty / too-short input', () => {
    expect(isGarbageTranscript('')).toBe(true);
    expect(isGarbageTranscript('да')).toBe(true);
    expect(isGarbageTranscript('ну да')).toBe(true);
  });

  it('flags a single repeated word', () => {
    expect(isGarbageTranscript('буду буду буду буду')).toBe(true);
  });

  it('flags Whisper repetition-loop hallucinations on music/noise', () => {
    const loop = Array.from({ length: 40 }, () => 'я не буду но').join(' ');
    expect(isGarbageTranscript(loop)).toBe(true);
  });

  it('flags a dominant-word loop with light filler', () => {
    const loop = 'я буду буду буду буду буду буду буду буду буду буду';
    expect(isGarbageTranscript(loop)).toBe(true);
  });

  it('passes a normal interview question', () => {
    expect(
      isGarbageTranscript('Расскажи, как ты работал с CI/CD и какими инструментами пользовался'),
    ).toBe(false);
  });

  it('does not flag a question that legitimately repeats a key word twice', () => {
    expect(
      isGarbageTranscript('Что такое фикстура и для чего нужна фикстура в pytest'),
    ).toBe(false);
  });
});
