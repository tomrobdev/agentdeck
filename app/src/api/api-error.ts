// What a failed call throws, and which failures are worth asking again.
export class ApiError extends Error {
  status: number | null;
  code: string | undefined;
  constructor(message: string, status: number | null = null, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class OfflineError extends ApiError {
  constructor() {
    super('offline');
  }
}

export const isOffline = (e: unknown) => e instanceof OfflineError;

const isClientError = (e: unknown) => e instanceof ApiError && e.status !== null && e.status >= 400 && e.status < 500;

export const retryQuery = (failures: number, e: unknown) => !isOffline(e) && !isClientError(e) && failures < 2;
