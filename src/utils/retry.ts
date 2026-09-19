import { sleep } from './time';

export interface RetryOptions {
  attempts?: number;
  /** Base delay in ms; grows exponentially with full jitter. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  onAttemptFailed?: (error: Error, attempt: number) => void;
  /** Return false to stop retrying immediately (e.g. CAPTCHA, retrying is pointless). */
  shouldRetry?: (error: Error) => boolean;
}

/**
 * Retries a transient operation. Deliberately conservative: three attempts by
 * default, with backoff, so a flaky page load does not turn into a burst of
 * requests at the target site.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    attempts = 3,
    baseDelayMs = 1500,
    maxDelayMs = 15000,
    signal,
    onAttemptFailed,
    shouldRetry = () => true,
  } = options;

  let lastError: Error = new Error('retry: no attempts were made');

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw new Error('aborted');
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      onAttemptFailed?.(lastError, attempt);
      if (attempt === attempts || !shouldRetry(lastError)) break;
      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await sleep(Math.floor(Math.random() * exponential), signal);
    }
  }

  throw lastError;
}
