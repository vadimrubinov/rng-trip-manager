import { log } from "./pino-logger";

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  retryableStatuses?: number[];
  operationName?: string;
}

const DEFAULT_RETRYABLE_STATUSES = [429, 500, 502, 503];
const NON_RETRYABLE_STATUSES = [400, 401, 403, 404];

function isRetryable(error: any, retryableStatuses: number[]): boolean {
  const status = error?.status || error?.statusCode || error?.response?.status;
  if (status && NON_RETRYABLE_STATUSES.includes(status)) return false;
  if (status && retryableStatuses.includes(status)) return true;
  const code = error?.code;
  if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ENOTFOUND") return true;
  if (error?.error === "RATE_LIMIT_REACHED") return true;
  return false;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 1000, retryableStatuses = DEFAULT_RETRYABLE_STATUSES, operationName = "operation" } = options;
  let lastError: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryable(error, retryableStatuses)) throw error;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      log.warn({ operationName, attempt, maxAttempts, delay, errorMessage: error?.message }, "retry.attempt");
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}