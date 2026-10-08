import { type ErrorCode, isErrorCode } from '@slush/core';

/** An error from our API or database functions, in the shape of docs/PHASE-7-API.md §1.5. */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get fields(): Record<string, string> {
    return (this.details.fields as Record<string, string> | undefined) ?? {};
  }

  get needsStepUp(): boolean {
    return this.code === 'FORBIDDEN' && this.details.reason === 'step_up_required';
  }
}

const FALLBACK = 'Something went wrong. Please try again.';

/** Database functions raise MESSAGE = code, DETAIL = human text, HINT = JSON details. */
export function fromPostgrest(err: { code?: string; message: string; details?: string | null; hint?: string | null }): ApiError {
  if (isErrorCode(err.message)) {
    let details: Record<string, unknown> = {};
    try {
      details = err.hint ? (JSON.parse(err.hint) as Record<string, unknown>) : {};
    } catch {
      /* not JSON */
    }
    return new ApiError(err.message, err.details || FALLBACK, details);
  }
  if (err.code === '42501') return new ApiError('FORBIDDEN', 'You don’t have permission to do that.');
  if (err.code === 'PGRST301' || err.code === 'PGRST303') return new ApiError('UNAUTHENTICATED', 'Please sign in again.');
  return new ApiError('INTERNAL', FALLBACK, { cause: err.message });
}

export function messageOf(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    return 'The server is taking too long to answer. Check the internet connection and try again.';
  }
  if (e instanceof TypeError) return 'Can’t reach the server. Check the internet connection.';
  return FALLBACK;
}
