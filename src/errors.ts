export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DUPLICATE_POINT'
  | 'DUPLICATE_ID'
  | 'INVALID_K'
  | 'NUMERIC_OVERFLOW'
  | 'UNSUPPORTED_DISTANCE'
  | 'ATOMIC_PUBLISH_FAILED';

export function errorResponse(error: unknown): { status: number; body: { error: { code: string; message: string; details?: unknown } } } {
  if (error instanceof AppError) {
    const statusByCode: Record<ErrorCode, number> = {
      VALIDATION_ERROR: 400,
      NOT_FOUND: 404,
      CONFLICT: 409,
      DUPLICATE_POINT: 422,
      DUPLICATE_ID: 422,
      INVALID_K: 400,
      NUMERIC_OVERFLOW: 422,
      UNSUPPORTED_DISTANCE: 400,
      ATOMIC_PUBLISH_FAILED: 500,
    };
    return {
      status: statusByCode[error.code],
      body: { error: { code: error.code, message: error.message, details: error.details } },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : '未知错误' } },
  };
}
