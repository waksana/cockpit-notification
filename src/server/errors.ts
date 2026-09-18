export class BackendError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'NotificationBackendError';
    this.code = code;
    this.status = status;
  }
}

export function safeError(error: unknown): BackendError {
  return error instanceof BackendError ? error :
    new BackendError('INTERNAL_ERROR', 'Notification operation failed', 500);
}
