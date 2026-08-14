import { describe, expect, it } from 'vitest';
import { createBackendResponseError } from './backendResponseError';

describe('createBackendResponseError', () => {
  it('preserves the structured quota code, status and user-facing message', () => {
    const error = createBackendResponseError(
      {
        error: {
          code: 'token_quota_exceeded',
          message: 'Месячный лимит токенов исчерпан.',
        },
      },
      402,
      'Не удалось подготовить ответы',
    );

    expect(error.message).toBe('Месячный лимит токенов исчерпан.');
    expect(error.code).toBe('token_quota_exceeded');
    expect(error.status).toBe(402);
  });

  it('keeps compatibility with FastAPI HTTPException detail', () => {
    const error = createBackendResponseError(
      { detail: 'Некорректный запрос' },
      400,
      'Не удалось подготовить ответы',
    );

    expect(error.message).toBe('Некорректный запрос');
    expect(error.code).toBeUndefined();
    expect(error.status).toBe(400);
  });
});
