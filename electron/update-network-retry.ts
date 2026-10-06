/** Only transient transport failures are safe to retry; never retry integrity or filesystem errors. */
export function isTransientUpdateError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:ERR_NETWORK_IO_SUSPENDED|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_(?:RESET|CLOSED|TIMED_OUT|ABORTED|REFUSED)|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b/.test(message)
    || /\bHTTP (?:408|429|502|503|504)\b/.test(message);
}

export async function retryUpdateNetwork<T>(
  operation: () => Promise<T>,
  active: () => boolean = () => true,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<T> {
  const delays = [1000, 3000, 10000, 30000];
  for (let attempt = 0; ; attempt++) {
    if (!active()) throw new Error('Update cancelled');
    try { return await operation(); } catch (error) {
      if (!active() || attempt >= delays.length || !isTransientUpdateError(error)) throw error;
      await wait(delays[attempt]);
    }
  }
}
