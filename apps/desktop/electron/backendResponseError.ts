export interface BackendErrorEnvelope {
  detail?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

export type BackendResponseError = Error & {
  status: number;
  code?: string;
};

/** Preserve FastAPI AppError's structured envelope across the Electron bridge. */
export function createBackendResponseError(
  payload: BackendErrorEnvelope | null,
  status: number,
  fallbackPrefix: string,
): BackendResponseError {
  const structuredMessage = payload?.error?.message;
  const detail = payload?.detail;
  const message = typeof structuredMessage === 'string' && structuredMessage.trim()
    ? structuredMessage.trim()
    : typeof detail === 'string' && detail.trim()
      ? detail.trim()
      : `${fallbackPrefix}: HTTP ${status}`;
  const error = new Error(message) as BackendResponseError;
  error.status = status;
  if (typeof payload?.error?.code === 'string' && payload.error.code.trim()) {
    error.code = payload.error.code.trim();
  }
  return error;
}
