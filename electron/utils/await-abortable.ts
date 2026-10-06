/** Stop waiting for user input when the owning conversation is cancelled. */
export function awaitAbortable<T>(start: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let abort: () => void;
  return new Promise<T>((resolve, reject) => {
    abort = () => reject(new Error('操作已取消'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      if (signal?.aborted) throw new Error('操作已取消');
      return start();
    }).then(resolve, reject);
  }).finally(() => signal?.removeEventListener('abort', abort));
}
