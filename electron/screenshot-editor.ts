import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell, screen, systemPreferences, type IpcMainInvokeEvent } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { diagWindow } from './window-diagnostics';
export const screenshotLifecycle = new EventEmitter();
import { captureScreenshot } from './screenshot';
import { SCREENSHOT_MAX_BYTES, SCREENSHOT_MAX_EDGE, SCREENSHOT_MAX_PIXELS, type ScreenshotState } from '../shared/screenshot';

interface EditorSession {
  win: BrowserWindow;
  state: ScreenshotState;
  loaded: boolean;
  initialCapture?: Promise<void>;
  disposed: boolean;
  pending: boolean;
  exporting: boolean;
  closing: boolean;
  fadeTimer?: ReturnType<typeof setTimeout>;
  closeTimer?: ReturnType<typeof setImmediate>;
  awaitingRevision?: number;
  paintedRevision?: number;
  readyTimer?: ReturnType<typeof setTimeout>;
  closed: Promise<void>;
  releaseClosed: () => void;
}
let editor: EditorSession | undefined;
let opening = false;
let revision = 0;
let quitting = false;
let quitGeneration = 0;
const READY_TIMEOUT_MS = 15_000;
const DISMISS_MS = 280;

/** A running-task confirmation can cancel the application's quit sequence. */
export function cancelScreenshotEditorQuit(): void { quitting = false; }

/** Separate from the conversation registry: this window only has screenshot IPC. */
export function getScreenshotEditorWindow(): BrowserWindow | undefined {
  return editor && !editor.disposed && !editor.win.isDestroyed() ? editor.win : undefined;
}

export function decodeScreenshot(png: unknown) {
  if (typeof png !== 'string' || png.length > Math.ceil(SCREENSHOT_MAX_BYTES / 3) * 4 + 32 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(png)) throw Error('Invalid or oversized PNG');
  const buffer = Buffer.from(png.slice('data:image/png;base64,'.length), 'base64');
  if (buffer.length > SCREENSHOT_MAX_BYTES) throw Error('Screenshot exceeds the image size limit');
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || buffer.toString('ascii',12,16) !== 'IHDR') throw Error('Invalid PNG');
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (!width || !height || width > SCREENSHOT_MAX_EDGE || height > SCREENSHOT_MAX_EDGE || width * height > SCREENSHOT_MAX_PIXELS) throw Error('图片尺寸过大 / Image dimensions exceed the editing limit');
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) throw Error('Invalid PNG');
  return { buffer, image };
}

async function capture(language: 'zh' | 'en', displayId?: number): Promise<ScreenshotState> {
  const nextRevision = ++revision;
  try {
    const snapshot = await captureScreenshot(SCREENSHOT_MAX_BYTES, displayId);
    if (!snapshot) return { language, revision: nextRevision, error: '屏幕读取仍在进行，请稍后重试。 Screen capture is still running. Please retry shortly.' };
    decodeScreenshot(`data:image/png;base64,${snapshot.image.dataBase64}`);
    return { language, ...snapshot, revision: nextRevision, imageRevision: nextRevision };
  } catch (error) { return { language, revision: nextRevision, error: String((error as Error)?.message ?? error) }; }
}

function live(session: EditorSession) {
  return editor === session && !session.disposed && !session.win.isDestroyed();
}

function stopFade(session: EditorSession) {
  clearTimeout(session.fadeTimer);
  session.fadeTimer = undefined;
  clearImmediate(session.closeTimer);
  session.closeTimer = undefined;
}

function closeImmediately(session: EditorSession) {
  stopFade(session);
  if (live(session)) session.win.destroy();
}

function closeAfterAcknowledgment(session: EditorSession) {
  // Let the completed invoke reply be queued before destroying its sender.
  // This is one event-loop turn, with no animation delay for reduced motion.
  session.closeTimer = setImmediate(() => {
    session.closeTimer = undefined;
    closeImmediately(session);
  });
}

function dismiss(session: EditorSession) {
  if (!live(session) || session.closing) return;
  session.closing = true;
  clearTimeout(session.readyTimer);
  session.readyTimer = undefined;
  let animate = (process.platform === 'darwin' || process.platform === 'win32') &&
    !!session.state.image && !session.pending &&
    session.awaitingRevision === undefined && session.win.isVisible() && !quitting;
  try {
    const settings = systemPreferences.getAnimationSettings();
    animate = animate && !settings.prefersReducedMotion && settings.shouldRenderRichAnimation !== false;
  } catch { /* Older or unavailable preference APIs retain the simple fade. */ }
  if (!animate) { closeAfterAcknowledgment(session); return; }
  const started = performance.now();
  const frame = () => {
    session.fadeTimer = undefined;
    if (!live(session)) return;
    if (quitting) { closeImmediately(session); return; }
    const elapsed = Math.max(0, performance.now() - started), progress = Math.min(1, elapsed / DISMISS_MS);
    const eased = progress < .5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
    try { session.win.setOpacity(1 - eased); }
    catch { closeAfterAcknowledgment(session); return; }
    if (progress >= 1) { closeImmediately(session); return; }
    session.fadeTimer = setTimeout(frame, Math.min(16, DISMISS_MS - elapsed));
  };
  frame();
}

function fail(session: EditorSession, message: string) {
  if (!live(session)) return;
  const { language } = session.state;
  // Only this utility window closes; never hide, transform or relaunch the app.
  session.win.hide();
  closeImmediately(session);
  dialog.showErrorBox(language === 'en' ? 'Screenshot unavailable' : '无法打开截屏', message);
}

function waitForPaint(session: EditorSession) {
  clearTimeout(session.readyTimer);
  session.awaitingRevision = session.state.revision;
  session.paintedRevision = undefined;
  session.readyTimer = setTimeout(() => fail(session, session.state.language === 'en'
    ? 'The screenshot editor did not finish preparing. Capture again.'
    : '截屏画面未能准备完成，请重新截屏。'), READY_TIMEOUT_MS);
}

function showPainted(session: EditorSession) {
  if (!live(session) || session.closing || quitting || !session.loaded || session.pending || session.awaitingRevision === undefined || session.paintedRevision !== session.awaitingRevision) return;
  clearTimeout(session.readyTimer);
  session.readyTimer = undefined;
  session.awaitingRevision = undefined;
  session.win.show();
  session.win.focus();
  diagWindow(`screenshot painted revision=${session.state.revision}`);
  screenshotLifecycle.emit('presented');
}

function placeOverlay(session: EditorSession) {
  const { win, state } = session;
  diagWindow(`screenshot workspace flags before revision=${state.revision}`);
  win.setAlwaysOnTop(!!state.image, 'screen-saver');
  // Electron otherwise transforms Sage into an accessory app on macOS, hiding
  // its Dock and other windows while this utility is shown across Spaces.
  win.setVisibleOnAllWorkspaces(!!state.image, { visibleOnFullScreen: true, skipTransformProcessType: true });
  if (state.image && state.display) win.setBounds(state.display.bounds);
  diagWindow(`screenshot workspace flags after revision=${state.revision}`);
  screenshotLifecycle.emit('workspace');
}

/** Capture is an independent utility: neither images nor errors are returned to a chat. */
export async function openScreenshotEditor(language: 'zh' | 'en' = 'zh'): Promise<void> {
  if (quitting) return;
  if (editor && live(editor)) {
    // A repeated shortcut cannot reveal an undecoded or stale frame.
    if (!editor.closing && !editor.pending && editor.awaitingRevision === undefined) { editor.win.show(); editor.win.focus(); }
    return;
  }
  if (opening) return;
  opening = true;
  const generation = quitGeneration;
  try {
    // Start capture and renderer creation together; neither waits for the other.
    const captureRequest = capture(language);
    const state: ScreenshotState = { language };
    // Canceling quit permits new captures, but never revives a capture which
    // began before that quit sequence invalidated its generation.
    if (quitting || generation !== quitGeneration) return;
    const win = new BrowserWindow({ title: language === 'en' ? 'Screenshot · Sage' : '截屏 · Sage',
      ...(state.display?.bounds ?? {width:620,height:360}), frame:false, resizable:false, movable:false,
      fullscreenable:false, enableLargerThanScreen:true, hasShadow:false, roundedCorners:false, skipTaskbar:true,
      show:false, backgroundColor:'#ffffff', acceptFirstMouse:true,
      webPreferences: { preload: path.join(__dirname, 'screenshot-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    let releaseClosed!: () => void;
    const closed = new Promise<void>(resolve => { releaseClosed = resolve; });
    const session: EditorSession = { win, state, loaded:false, disposed:false, pending:false, exporting:false, closing:false, closed, releaseClosed };
    editor = session;
    win.excludedFromShownWindowsMenu = true;
    const displayChanged = (_event: unknown, display: Electron.Display, changed: string[]) => {
      if (display.id === session.state.display?.id && changed.some(key => ['bounds','scaleFactor','rotation'].includes(key)) && !win.isDestroyed()) win.close();
    };
    const displayRemoved = (_event: unknown, display: Electron.Display) => { if (display.id === session.state.display?.id && !win.isDestroyed()) win.close(); };
    const renderGone = () => fail(session, session.state.language === 'en'
      ? 'The screenshot editor stopped. Capture again.' : '截屏编辑器已停止，请重新截屏。');
    const denyNavigation = (event: { preventDefault(): void }) => event.preventDefault();
    screen.on('display-removed', displayRemoved);
    screen.on('display-metrics-changed', displayChanged);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', denyNavigation);
    win.webContents.on('render-process-gone', renderGone);
    win.once('closed', () => {
      session.disposed = true;
      stopFade(session);
      diagWindow(`screenshot closed revision=${session.state.revision}`);
      screenshotLifecycle.emit('closed');
      clearTimeout(session.readyTimer);
      session.readyTimer = undefined;
      session.awaitingRevision = undefined;
      screen.removeListener('display-removed', displayRemoved);
      screen.removeListener('display-metrics-changed', displayChanged);
      // The destroyed WebContents clears its own listeners; accessing the
      // BrowserWindow.webContents getter from 'closed' can throw in Electron.
      session.releaseClosed();
      if (editor === session) editor = undefined;
    });
    try {
      session.initialCapture = captureRequest.then(result => {
        if (!live(session) || quitting || generation !== quitGeneration) return;
        session.state = result;
        placeOverlay(session);
        waitForPaint(session);
      }).finally(()=>{session.initialCapture=undefined;});
      const loading = process.env.NODE_ENV === 'development' || process.env.VITE_DEV_SERVER_URL
        ? win.loadURL('http://localhost:5173/?view=screenshot')
        : win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'), { query: { view: 'screenshot' } });
      // Closing or timing out also releases an unresolved load, so another
      // screenshot can start without accumulating hidden utility windows.
      await Promise.race([Promise.all([session.initialCapture, loading]).then(() => { if (live(session)) { session.loaded = true; showPainted(session); } }), closed]);
    } catch (error) { fail(session, String((error as Error)?.message ?? error)); }
  } catch (error) {
    dialog.showErrorBox(language === 'en' ? 'Screenshot unavailable' : '无法打开截屏', String((error as Error)?.message ?? error));
  } finally { opening = false; }
}

export function registerScreenshotEditor() {
  app.on('before-quit', () => {
    quitting = true;
    ++quitGeneration;
    if (editor) closeImmediately(editor);
  });
  const own = (event: IpcMainInvokeEvent) => {
    if (!editor || !live(editor) || event.sender !== editor.win.webContents || event.senderFrame !== editor.win.webContents.mainFrame) throw Error('Screenshot editor unavailable');
    return editor;
  };
  ipcMain.handle('screenshot-editor:state', event => { const session = own(event); return session.initialCapture ? session.initialCapture.then(()=>{if(!live(session))throw Error('Screenshot editor closed');return session.state;}) : session.state; });
  ipcMain.handle('screenshot-editor:ready', (event, paintedRevision: unknown) => {
    const session = own(event);
    if (session.closing) return;
    if (typeof paintedRevision !== 'number' || !Number.isSafeInteger(paintedRevision) || paintedRevision < 1) throw Error('Invalid screenshot revision');
    if (paintedRevision !== session.awaitingRevision) return;
    session.paintedRevision = paintedRevision;
    showPainted(session);
  });
  ipcMain.handle('screenshot-editor:retry', async (event, displayId?: unknown) => {
    const session = own(event), { win } = session;
    if (displayId !== undefined && (typeof displayId !== 'number' || !Number.isFinite(displayId))) throw Error('Invalid display');
    if (session.closing || session.pending || session.exporting || session.awaitingRevision !== undefined) return session.state;
    session.pending = true;
    win.hide();
    try {
      // Give WindowServer time to remove the overlay before freezing the desktop.
      await new Promise(resolve => setTimeout(resolve, 160));
      if (!live(session)) return { language: session.state.language };
      const result = await capture(session.state.language, typeof displayId === 'number' ? displayId : session.state.display?.id);
      if (live(session)) {
        // A failed retake advances the presentation token while retaining the
        // original image token and all renderer edits.
        session.state = result.error && session.state.image ? { ...session.state, error: result.error, revision: result.revision } : result;
        placeOverlay(session);
        waitForPaint(session);
      }
      return session.state;
    } catch (error) {
      fail(session, String((error as Error)?.message ?? error));
      throw error;
    } finally { session.pending = false; showPainted(session); }
  });
  ipcMain.handle('screenshot-editor:export', async (event, kind: unknown, png: unknown) => {
    const session = own(event), { win } = session;
    if (session.closing || session.exporting || session.pending || session.awaitingRevision !== undefined) throw Error('截屏正在处理 / Screenshot is busy');
    if (kind !== 'copy' && kind !== 'save') throw Error('Invalid export action');
    session.exporting = true;
    try {
      const { buffer, image } = decodeScreenshot(png);
      if (kind === 'copy') clipboard.writeImage(image);
      else {
        const result = await dialog.showSaveDialog(win, { title: session.state.language === 'en' ? 'Save screenshot' : '保存截图',
          defaultPath: path.join(app.getPath('pictures'), session.state.image?.name ?? 'Screenshot.png'), filters: [{ name: 'PNG', extensions: ['png'] }] });
        if (result.canceled || !result.filePath || !live(session)) return { canceled: true };
        await writeFile(result.filePath, buffer);
      }
      // The image has been committed before dismissal begins. A canceled save
      // or write/clipboard failure leaves the window and edited image intact.
      dismiss(session);
      return {};
    } finally { session.exporting = false; }
  });
  ipcMain.handle('screenshot-editor:close', event => {
    if (!editor || !live(editor)) return; // A duplicate after completion is harmless.
    dismiss(own(event));
  });
  ipcMain.handle('screenshot-editor:privacy', async event => {
    const session = own(event), { win } = session;
    if (session.closing) return;
    // A screen-saver-level overlay must not cover the System Settings window.
    win.hide();
    try { await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'); }
    catch(error) { if(live(session) && session.awaitingRevision === undefined) { win.show(); win.focus(); } throw error; }
  });
}
