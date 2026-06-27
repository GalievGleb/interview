import { describe, it, expect } from 'vitest';
import { isGarbageTranscript, looksLikeQuestion } from './normalizeTranscript';

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
