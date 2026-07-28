import { describe, expect, it } from 'vitest';
import { selectForceTargetSource, selectForcedQuestion } from './forceLiveAnswer';

describe('selectForcedQuestion', () => {
  it('prefers the currently buffered utterance', () => {
    expect(
      selectForcedQuestion(
        ['Расскажи про API.', 'Что проверял кроме статуса 200?'],
        [
          {
            text: 'Старый вопрос',
            isFinal: true,
            speaker: 'other',
          },
        ],
        'other',
      ),
    ).toBe('Расскажи про API. Что проверял кроме статуса 200?');
  });

  it('falls back to the latest final interviewer phrase', () => {
    expect(
      selectForcedQuestion(
        [],
        [
          { text: 'Ответ кандидата', isFinal: true, speaker: 'me' },
          { text: 'Как ты настраивал CI/CD?', isFinal: true, speaker: 'other' },
        ],
        'other',
      ),
    ).toBe('Как ты настраивал CI/CD?');
  });

  it('does not submit another speaker or partial text', () => {
    expect(
      selectForcedQuestion(
        [],
        [
          { text: 'Незавершённая реплика', isFinal: false, speaker: 'other' },
          { text: 'Ответ кандидата', isFinal: true, speaker: 'me' },
        ],
        'other',
      ),
    ).toBe('');
  });

  it('does not resubmit the last completed question', () => {
    expect(
      selectForcedQuestion(
        [],
        [{ text: 'Как ты настраивал Docker?', isFinal: true, speaker: 'other' }],
        'other',
        'Как ты настраивал Docker?',
      ),
    ).toBe('');
  });

  it('compares completed questions without punctuation or case differences', () => {
    expect(
      selectForcedQuestion(
        [],
        [{ text: 'КАК ты настраивал Docker?!', isFinal: true, speaker: 'other' }],
        'other',
        'Как ты настраивал Docker?',
      ),
    ).toBe('');
  });

  it('does not resubmit raw text when the completed answer used a resolved follow-up', () => {
    expect(
      selectForcedQuestion(
        [],
        [{ text: 'Как ты его настраивал?', isFinal: true, speaker: 'other' }],
        'other',
        'Как ты Docker настраивал?',
        'Как ты его настраивал?',
      ),
    ).toBe('');
  });
});

describe('selectForceTargetSource', () => {
  it('targets only system audio when mic and system are active', () => {
    expect(selectForceTargetSource({ mic: true, system: true })).toBe('system');
  });

  it('uses the microphone when it is the trigger source', () => {
    expect(selectForceTargetSource({ mic: true, system: false })).toBe('mic');
  });
});
