import type { BrowserWindow, IpcMainInvokeEvent, SaveDialogOptions, SaveDialogReturnValue } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseHttpLink, type LinkDownloadResult } from '../shared/link-download';

export const MAX_LINK_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const LINK_DOWNLOAD_TIMEOUT_MS = 60_000;
type Language = 'zh' | 'en';
type Failure = 'sender' | 'url' | 'busy' | 'path' | 'size' | 'timeout' | 'download';
const messages: Record<Failure, Record<Language, string>> = {
  sender: { zh: '此窗口不能保存链接。', en: 'This window cannot save links.' },
  url: { zh: '只能保存有效的 HTTP 或 HTTPS 链接。', en: 'Only valid HTTP or HTTPS links can be saved.' },
  busy: { zh: '已有链接正在保存，请稍后再试。', en: 'A link is already being saved. Please wait.' },
  path: { zh: '请选择有效的保存位置。', en: 'Choose a valid save location.' },
  size: { zh: '链接文件超过 100 MB，未保存。', en: 'The linked file exceeds 100 MB and was not saved.' },
  timeout: { zh: '下载超时，请重试。', en: 'The download timed out. Please try again.' },
  download: { zh: '链接保存失败，原有文件已保留，请重试。', en: 'Unable to save the link. Any existing file was preserved. Please try again.' },
};
class DownloadFailure extends Error { constructor(readonly code: Failure) { super(code); } }
export interface LinkDownloadDependencies {
  getWindows: () => Map<number, BrowserWindow>;
  language: () => Promise<Language>;
  chooseFile: (window: BrowserWindow, options: SaveDialogOptions) => Promise<SaveDialogReturnValue>;
  /** Inject a local fake in tests; the production fetch carries no browser cookies. */
  fetch?: typeof globalThis.fetch;
  maxBytes?: number;
  timeoutMs?: number;
}

export function suggestedLinkFilename(url: URL): string {
  let name = url.pathname.split('/').pop() || 'download.html';
  try { name = decodeURIComponent(name); } catch { /* Keep malformed percent escapes literal. */ }
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-').replace(/^[. ]+|[. ]+$/g, '').slice(0, 160);
  if (!name) name = 'download.html';
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = 'link-' + name;
  return name;
}

/** Race waiting I/O against caller closure without retaining abort listeners. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
function stopResponse(response: Response): void { void response.body?.cancel().catch(() => {}); }

/** No request starts before the caller has confirmed the native save dialog. */
export function createLinkDownloadHandler(deps: LinkDownloadDependencies) {
  const active = new Set<number>();
  return async (event: IpcMainInvokeEvent, value: unknown): Promise<LinkDownloadResult> => {
    let language: Language = 'zh';
    const fail = (code: Failure): LinkDownloadResult => ({ ok: false, error: messages[code][language] });
    const window = deps.getWindows().get(event.sender.id);
    if (!window || window.isDestroyed() || event.sender.isDestroyed() || window.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) return fail('sender');
    try { if (new URL(event.sender.getURL()).searchParams.get('view') === 'pet') return fail('sender'); } catch { return fail('sender'); }
    const initialUrl = parseHttpLink(value);
    if (!initialUrl) return fail('url');
    if (active.has(event.sender.id)) return fail('busy');
    active.add(event.sender.id);
    const controller = new AbortController();
    let closed = false, timedOut = false, timer: ReturnType<typeof setTimeout> | undefined;
    let temporary: string | undefined;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let reader: import('node:stream/web').ReadableStreamDefaultReader<Uint8Array> | undefined;
    let response: Response | undefined;
    const cancel = () => { closed = true; controller.abort(new Error('Caller closed')); };
    window.once('closed', cancel);
    event.sender.once('destroyed', cancel);
    const signal = controller.signal;
    try {
      language = await abortable(deps.language(), signal);
      const selected = await abortable(deps.chooseFile(window, {
        title: language === 'en' ? 'Save link as…' : '链接另存为…',
        buttonLabel: language === 'en' ? 'Save' : '保存',
        defaultPath: suggestedLinkFilename(initialUrl),
      }), signal);
      if (selected.canceled || !selected.filePath) return { ok: false, canceled: true };
      if (!path.isAbsolute(selected.filePath)) throw new DownloadFailure('path');
      signal.throwIfAborted();
      timer = setTimeout(() => { timedOut = true; controller.abort(new DownloadFailure('timeout')); }, deps.timeoutMs ?? LINK_DOWNLOAD_TIMEOUT_MS);
      const download = deps.fetch ?? globalThis.fetch;
      const maxBytes = deps.maxBytes ?? MAX_LINK_DOWNLOAD_BYTES;
      let url = initialUrl;
      // Validate every redirect; never let a redirect select another protocol or credentials.
      for (let redirects = 0; redirects <= 5; redirects++) {
        const fetched: Response = await abortable(download(url.href, { signal, redirect: 'manual', credentials: 'omit' }).then(value => {
          if (signal.aborted) { stopResponse(value); throw signal.reason; }
          return value;
        }), signal);
        response = fetched;
        if (![301, 302, 303, 307, 308].includes(fetched.status)) break;
        const location = fetched.headers.get('location');
        stopResponse(fetched);
        const next = location ? parseHttpLink(new URL(location, url).href) : null;
        if (!next || redirects === 5) throw new DownloadFailure('download');
        url = next;
      }
      if (!response?.ok || !response.body) { if (response) stopResponse(response); throw new DownloadFailure('download'); }
      const length = response.headers.get('content-length');
      if (length && Number(length) > maxBytes) { stopResponse(response); throw new DownloadFailure('size'); }
      temporary = path.join(path.dirname(selected.filePath), `.sage-link-${randomUUID()}.tmp`);
      // Acquiring the file handle must finish before cleanup, even if the caller closes.
      handle = await fs.open(temporary, 'wx', 0o600);
      signal.throwIfAborted();
      reader = response.body.getReader();
      let bytes = 0;
      while (true) {
        const chunk = await abortable(reader.read(), signal);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) throw new DownloadFailure('size');
        let offset = 0;
        while (offset < chunk.value.byteLength) {
          signal.throwIfAborted();
          const written = await handle.write(chunk.value, offset, chunk.value.byteLength - offset);
          if (!written.bytesWritten) throw new DownloadFailure('download');
          offset += written.bytesWritten;
        }
      }
      await handle.sync();
      await handle.close(); handle = undefined;
      signal.throwIfAborted();
      // Rename within the selected directory is the only operation that replaces the target.
      await fs.rename(temporary, selected.filePath);
      temporary = undefined;
      return { ok: true };
    } catch (error) {
      if (closed) return { ok: false, canceled: true };
      if (timedOut) return fail('timeout');
      return fail(error instanceof DownloadFailure ? error.code : 'download');
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch {} }
      else if (response) stopResponse(response);
      if (handle) await handle.close().catch(() => {});
      if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
      window.removeListener('closed', cancel);
      event.sender.removeListener('destroyed', cancel);
      active.delete(event.sender.id);
    }
  };
}
