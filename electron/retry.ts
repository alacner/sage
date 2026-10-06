/**
 * Retry wrapper for Claude bridge calls (runClaude / runChat).
 *
 * Network blips, transient rate limits and 5xx are retried with exponential
 * backoff + jitter. User-initiated abort and permanent errors (auth, 400,
 * 404) are NOT retried.
 *
 * Both runners flatten errors to a single `error: string`, so the policy
 * here is regex-based on the message body. False negatives just fall back
 * to fail-fast — acceptable, since the user still sees the error and can
 * resend manually.
 */

export interface RetryOptions {
  /** Total attempts, including the first one. Default 3. */
  maxAttempts?: number;
  /** Base wait before attempt 2. Default 1000ms. */
  baseDelayMs?: number;
  /** Hard cap on a single wait. Default 15000ms. */
  maxDelayMs?: number;
  /** When this fires we stop retrying and return the last result. */
  signal?: AbortSignal;
  /** Called once per retry (i.e. NOT for the first attempt). */
  onRetry?: (info: { attempt: number; waitMs: number; reason: string }) => void;
}

/**
 * Classify an error string as transient (retry) vs permanent (fail-fast).
 *
 * Returns false for:
 *   - 'aborted' (user cancelled)
 *   - 401 / 403 / 400 / 404 / explicit "unauthorized" / "invalid api key"
 *
 * Returns true for:
 *   - network-layer messages (ECONNRESET, ETIMEDOUT, ENOTFOUND, EAI_AGAIN,
 *     "fetch failed", "socket hang up", "stream closed", "connection reset")
 *   - 429 / 503 / 504 / 529 / "overloaded" / "rate limit"
 *   - generic "timeout" / "certificate"
 *
 * Everything else is treated as permanent.
 */
export function isRetryableError(msg: string | undefined): boolean {
  if (!msg) return false;
  if (msg === 'aborted') return false;
  const lower = msg.toLowerCase();
  if (/\b(unauthorized|forbidden|invalid[_ ]?api[_ ]?key|401|403|400|404)\b/.test(lower)) {
    return false;
  }
  return /(network|fetch failed|socket hang up|econnreset|etimedout|enotfound|eai_again|certificate|timeout|rate.?limit|429|503|504|529|overloaded|connection (reset|closed)|stream closed)/.test(
    lower,
  );
}

/**
 * Run `fn` up to `maxAttempts` times, retrying only when its returned error
 * is classified retryable.
 *
 * `fn` receives the 1-indexed attempt number so the caller can vary call
 * options per attempt (e.g. pass `resumeSessionId` on retries to preserve
 * prompt cache warmth).
 */
export async function withRetry<T extends { error?: string }>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const max = opts.maxAttempts ?? 3;
  const base = opts.baseDelayMs ?? 1000;
  const cap = opts.maxDelayMs ?? 15000;
  let last: T | undefined;

  for (let attempt = 1; attempt <= max; attempt++) {
    if (opts.signal?.aborted) {
      return (last ?? ({ error: 'aborted' } as unknown as T)) as T;
    }

    const result = await fn(attempt);
    last = result;

    if (!result.error) return result;
    if (!isRetryableError(result.error)) return result;
    if (attempt >= max) return result;

    // Exponential backoff (×2.5) with ±20% jitter; capped at maxDelayMs.
    const raw = Math.min(cap, base * Math.pow(2.5, attempt - 1));
    const jitter = raw * (0.8 + Math.random() * 0.4);
    const waitMs = Math.round(jitter);

    opts.onRetry?.({ attempt, waitMs, reason: result.error });
    await sleepAbortable(waitMs, opts.signal);
  }

  return last as T;
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
