import { desktopCapturer, screen, systemPreferences, type DesktopCapturerSource, type Display } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureThumbnailSize } from '../shared/screenshot-selection';
import type { ScreenshotDisplay } from '../shared/screenshot';
import { loadFnKeyMonitor } from './native-fn-shortcuts';

const exec = promisify(execFile);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
let capturing = false;
let desktopRequest: Promise<DesktopCapturerSource[]> | undefined;
let desktopRequestTimedOut = false;
const permissionError = () => Error('SAGE_SCREEN_PERMISSION_REQUIRED: 请允许 Sage 录制屏幕后重试；如 macOS 提示，请重新打开 Sage。 Allow Sage in Screen Recording and restart if macOS requests it.');
const isPermissionDenied = () => !['granted', 'unknown'].includes(systemPreferences.getMediaAccessStatus('screen'));
type SourceFailure = 'missing-source' | 'missing-display-id' | 'empty-thumbnail' | 'request-failed' | 'request-timeout';
class CaptureSourceError extends Error {
  constructor(readonly kind: SourceFailure) { super(kind); }
}

function sameDisplay(first: Display, next: Display | undefined) {
  return !!next && first.id === next.id && JSON.stringify(first.bounds) === JSON.stringify(next.bounds) &&
    first.scaleFactor === next.scaleFactor && first.rotation === next.rotation;
}
function validateDisplay(target: Display) {
  if (!sameDisplay(target, screen.getAllDisplays().find(display => display.id === target.id))) {
    throw Error('显示器配置已改变，请重新截屏。 Display configuration changed. Retry capture.');
  }
}
function validatePng(data: Buffer, maxBytes: number) {
  if (data.length > maxBytes) throw Error('截图超过图片大小限制 / Screenshot exceeds the image size limit');
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) throw Error('Invalid screenshot');
}

/** Electron has no abort API. Reuse its pending request instead of starting duplicates. */
async function getSources(displays: Display[]) {
  if (desktopRequest && desktopRequestTimedOut) throw new CaptureSourceError('request-timeout');
  let request = desktopRequest;
  if (!request) {
    try {
      request = desktopCapturer.getSources({types:['screen'], thumbnailSize:captureThumbnailSize(displays), fetchWindowIcons:false});
    } catch { throw new CaptureSourceError('request-failed'); }
    desktopRequest = request;
    void request.then(() => {
      if (desktopRequest === request) { desktopRequest = undefined; desktopRequestTimedOut = false; }
    }, () => {
      if (desktopRequest === request) { desktopRequest = undefined; desktopRequestTimedOut = false; }
    });
  }
  const pending = request;
  return new Promise<DesktopCapturerSource[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (desktopRequest === pending) desktopRequestTimedOut = true;
      reject(new CaptureSourceError('request-timeout'));
    }, 30000);
    pending.then(sources => { clearTimeout(timer); resolve(sources); }, () => {
      clearTimeout(timer); reject(new CaptureSourceError('request-failed'));
    });
  });
}

/** A single connected display is unambiguous; never guess multi-display ordering. */
async function captureSingleDisplay(target: Display, maxBytes: number): Promise<Buffer> {
  const before = screen.getAllDisplays();
  if (before.length !== 1 || !sameDisplay(target, before[0])) {
    throw Error('无法匹配当前显示器的屏幕来源，请切换屏幕或重新连接显示器后重试。 Cannot match this display to a capture source. Switch displays or reconnect the display and retry.');
  }
  if (isPermissionDenied()) throw permissionError();
  const directory = await mkdtemp(join(tmpdir(), 'sage-screenshot-'));
  const file = join(directory, 'screen.png');
  try {
    // No interactive picker, clipboard mutation, upload, or output outside this temp directory.
    await exec('/usr/sbin/screencapture', ['-x', '-t', 'png', file], {timeout:10000, maxBuffer:64 * 1024});
    if (isPermissionDenied()) throw permissionError();
    const after = screen.getAllDisplays();
    if (after.length !== 1 || !sameDisplay(target, after[0])) {
      throw Error('显示器配置已改变，请重新截屏。 Display configuration changed. Retry capture.');
    }
    const info = await stat(file);
    if (!info.isFile() || info.size > maxBytes) throw Error('截图超过图片大小限制 / Screenshot exceeds the image size limit');
    const data = await readFile(file);
    validatePng(data, maxBytes);
    return data;
  } finally {
    await rm(directory, {recursive:true, force:true});
  }
}

/** Freeze the target display before showing the overlay. No persistent file or clipboard changes. */
export async function captureScreenshot(maxBytes = 24 * 1024 * 1024, displayId?: number) {
  if (process.platform !== 'darwin') throw Error('Interactive screenshots currently require macOS. Paste an image instead.');
  if (capturing) return null;
  capturing = true;
  try {
    let permission = systemPreferences.getMediaAccessStatus('screen');
    if (permission !== 'granted' && permission !== 'unknown') {
      if (permission !== 'restricted') loadFnKeyMonitor()?.requestScreenCaptureAccess?.();
      permission = systemPreferences.getMediaAccessStatus('screen');
      if (permission !== 'granted') throw permissionError();
    }
    const displays = screen.getAllDisplays();
    const target = displayId === undefined ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) : displays.find(display => display.id === displayId);
    if (!target) throw Error('显示器已断开，请重新截屏。 Display disconnected. Retry capture.');
    const metadata = (display: Display): ScreenshotDisplay => ({id:display.id, bounds:display.bounds, label:display.label || `Display ${displays.findIndex(value=>value.id===display.id)+1}`, scaleFactor:display.scaleFactor});
    let data: Buffer;
    try {
      const sources = await getSources(displays);
      validateDisplay(target);
      let source = sources.find(value => value.display_id === String(target.id));
      // Electron documents that display_id can be empty. One display and one
      // screen source form a safe match; list order is never used for multiple screens.
      if (!source && displays.length === 1 && sources.length === 1 && !sources[0].display_id) source = sources[0];
      if (!source) throw new CaptureSourceError(sources.some(value => !value.display_id) ? 'missing-display-id' : 'missing-source');
      if (source.thumbnail.isEmpty()) throw new CaptureSourceError('empty-thumbnail');
      data = source.thumbnail.toPNG();
    } catch (error) {
      if (!(error instanceof CaptureSourceError)) throw error;
      if (isPermissionDenied()) throw permissionError();
      console.warn('[screenshot] Screen source unavailable', {reason:error.kind, displayId:target.id, displays:displays.length});
      if (displays.length !== 1) {
        const detail = error.kind === 'empty-thumbnail'
          ? '当前显示器返回了空画面。 This display returned an empty image.'
          : error.kind === 'request-timeout'
            ? '系统屏幕读取超时。 The system screen request timed out.'
            : error.kind === 'request-failed'
              ? '系统屏幕读取失败。 The system screen request failed.'
              : error.kind === 'missing-display-id'
                ? '系统屏幕来源缺少显示器编号，无法确定当前屏幕。 Capture sources have no display identifier, so this display cannot be identified.'
                : '系统未返回匹配当前显示器的画面。 No capture source matched this display.';
        throw Error(`${detail} 请切换屏幕或重新连接显示器后重试。 Switch displays or reconnect the display and retry.`);
      }
      try { data = await captureSingleDisplay(target, maxBytes); }
      catch (fallbackError) {
        if (isPermissionDenied()) throw permissionError();
        const message = String((fallbackError as Error)?.message ?? fallbackError);
        if (/^(SAGE_SCREEN_PERMISSION_REQUIRED|Invalid screenshot|截图超过|显示器配置已改变|无法匹配)/.test(message)) throw fallbackError;
        throw Error('系统截图也未成功，请重新打开 Sage 后重试。 System screenshot capture also failed. Reopen Sage and retry.');
      }
    }
    validateDisplay(target);
    validatePng(data, maxBytes);
    return {image:{name:`Screenshot-${new Date().toISOString().replace(/[:.]/g,'-')}.png`, mimeType:'image/png', dataBase64:data.toString('base64')}, display:metadata(target), displays:displays.map(metadata)};
  } catch (error) {
    if (isPermissionDenied()) throw permissionError();
    throw error;
  } finally {
    // The separate desktopRequest singleton still prevents duplicate Electron calls.
    capturing = false;
  }
}
