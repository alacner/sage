import { app, globalShortcut, ipcMain, shell, systemPreferences, type BrowserWindow, type Input, type WebContents } from 'electron';
import { effectiveAccelerator, isFnAccelerator, matchesAccelerator, matchesParsedAccelerator, parseAccelerator } from '../shared/shortcuts';
import { COMPOSER_SHORTCUTS, ComposerShortcutChannels as channels, type ComposerShortcutScope, type ComposerShortcutEvent, type ShortcutAvailability, type NativeFnInput } from '../shared/composer-shortcuts';
import { loadFnKeyMonitor, type FnKeyMonitor } from './native-fn-shortcuts';

/** Keep only our successful reservation; failed registration belongs to another app. */
export class GlobalScreenshotShortcut {
  private accelerator?: string;
  constructor(private capture:()=>void) {}
  owns(accelerator:string|null){return !!accelerator&&this.accelerator===accelerator;}
  release(){if(this.accelerator){globalShortcut.unregister(this.accelerator);this.accelerator=undefined;}}
  sync(accelerator:string|null,suspended=false){
    if(suspended||!accelerator||isFnAccelerator(accelerator)){this.release();return;}
    if(this.owns(accelerator))return;
    this.release();
    try{
      if(!globalShortcut.isRegistered(accelerator)&&globalShortcut.register(accelerator,()=>this.capture()))this.accelerator=accelerator;
    }catch{/* A system-reserved shortcut remains available to the current owner. */}
  }
}

/** One foreground window owns a press, including when its webview has keyboard focus. */
export class ComposerShortcutRouter {
  private scope?: ComposerShortcutScope;
  private held?: { code: string; key: string; conversationId: string };
  private fnPressed = false;
  private fnConsumed = false;
  constructor(private readonly send: (event: ComposerShortcutEvent) => void,
    private readonly overrides: () => Record<string, string | null> | undefined) {}
  setScope(scope?: ComposerShortcutScope) {
    if (!scope?.voice || scope.conversationId !== this.scope?.conversationId) this.release();
    this.scope = scope;
  }
  release() {
    this.fnPressed = false; this.fnConsumed = true;
    if (!this.held) return;
    const { conversationId } = this.held;
    this.held = undefined;
    this.send({ conversationId, action: 'voiceHold', phase: 'stop' });
  }
  get holdAccelerator() { return this.scope?.voice ? effectiveAccelerator('voiceHold', this.overrides()) : null; }
  fnInput(input: NativeFnInput): boolean {
    const wasPressed = this.fnPressed;
    const stopHold = () => { if (this.held?.code === 'Fn') { const pressed = this.fnPressed; this.release(); this.fnPressed = pressed; } };
    if (!input.fn || input.type === 'reset') {
      stopHold(); this.fnPressed = false; this.fnConsumed = false; return wasPressed;
    }
    if (input.type === 'keyUp') return false;
    if (!this.scope?.voice) return false;
    const hold = effectiveAccelerator('voiceHold', this.overrides());
    const toggle = effectiveAccelerator('voiceToggle', this.overrides());
    if (!isFnAccelerator(hold) && !isFnAccelerator(toggle)) return false;
    if (input.type === 'keyDown') { stopHold(); this.fnConsumed = true; return false; }
    if (!this.fnPressed) {
      if (input.keyCode !== 63) return false; // Never start from a key already held while focus changed.
      this.fnPressed = true; this.fnConsumed = false;
    }
    if (this.fnConsumed) return true;
    const event = { key: 'Fn', ctrlKey: input.ctrl, altKey: input.alt, metaKey: input.meta, shiftKey: input.shift };
    if (isFnAccelerator(toggle) && matchesAccelerator(toggle, event)) {
      stopHold(); this.fnConsumed = true;
      this.send({ conversationId: this.scope.conversationId, action: 'voiceToggle', phase: 'start' });
    } else if (isFnAccelerator(hold) && matchesAccelerator(hold, event)) {
      if (!this.held) {
        this.held = { code: 'Fn', key: 'Fn', conversationId: this.scope.conversationId };
        this.send({ conversationId: this.scope.conversationId, action: 'voiceHold', phase: 'start' });
      }
    } else if (this.held?.code === 'Fn') { stopHold(); this.fnConsumed = true; }
    return true;
  }
  input(input: Input): boolean | 'hold' {
    if (input.type === 'keyUp') {
      const held = this.held;
      if (!held) return false;
      const primary = held.code ? input.code === held.code : input.key === held.key;
      if (primary || ['Meta', 'Control', 'Alt', 'Shift'].includes(input.key)) this.release();
      return primary;
    }
    if (input.type !== 'keyDown' || input.isComposing || !this.scope) return false;
    const event = { key: input.key, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift };
    for (const action of COMPOSER_SHORTCUTS) {
      if (!(action === 'screenshot' ? this.scope.screenshot : this.scope.voice)) continue;
      const accelerator = effectiveAccelerator(action, this.overrides());
      if (isFnAccelerator(accelerator) || !matchesAccelerator(accelerator, event)) continue;
      if (!input.isAutoRepeat && !(action === 'voiceHold' && this.held)) {
        const { conversationId } = this.scope;
        if (action === 'voiceHold') this.held = { code: input.code, key: input.key, conversationId };
        this.send({ conversationId, action, phase: 'start' });
      }
      return action === 'voiceHold' ? 'hold' : true;
    }
    return false;
  }
}

export function initializeComposerShortcuts(windows: Map<number, BrowserWindow>, overrides: () => Record<string, string | null> | undefined, loadNative = loadFnKeyMonitor, captureGlobalScreenshot?:()=>void) {
  const routers = new Map<number, ComposerShortcutRouter>();
  const refreshers = new Map<number, Set<() => void>>();
  let nativeMonitor: FnKeyMonitor | undefined;
  let nativeReady = false;
  let unsupported: string[] = [];
  const globalCapture=captureGlobalScreenshot?new GlobalScreenshotShortcut(captureGlobalScreenshot):undefined;
  let appReady=false;
  const recorders = new Map<number, { active: boolean; allowFn: boolean; keys?: NativeFnInput }>();
  const focusedWindow = () => [...windows.values()].find(w => !w.isDestroyed() && w.isFocused());
  const syncPriority = () => {
    if(appReady)globalCapture?.sync(effectiveAccelerator('screenshot',overrides()),[...recorders.values()].some(recorder=>recorder.active));
    if (!nativeReady) return;
    const bindings = COMPOSER_SHORTCUTS.filter(action=>action!=='screenshot'||!globalCapture?.owns(effectiveAccelerator(action,overrides()))).map(action => parseAccelerator(effectiveAccelerator(action, overrides()) || '')).filter((binding): binding is NonNullable<typeof binding> => !!binding)
      .map(binding => binding.cmdOrCtrl ? { ...binding, meta: true, ctrl: false } : binding);
    const focused = focusedWindow();
    const recorder = focused && recorders.get(focused.webContents.id);
    // Fn recording must work even after both voice bindings were cleared/remapped.
    if (recorder?.active && recorder.allowFn && !bindings.some(binding => binding.key === 'Fn')) bindings.push(parseAccelerator('Fn')!);
    // Reserved only while a Sage window is focused. Action scope is checked again
    // by the router/renderer; disabled actions never fall through to another app.
    try { unsupported = nativeMonitor!.priority(!!focusedWindow(), bindings).unsupported; }
    catch { unsupported = bindings.map(binding => binding.key); }
  };
  app.whenReady().then(() => {
    appReady=true;
    nativeMonitor = loadNative();
    try { nativeReady = !!nativeMonitor?.start(input => {
      if (input.type === 'activate') { setImmediate(syncPriority); return false; }
      if (input.type === 'reset') { for (const router of routers.values()) router.release(); for (const recorder of recorders.values()) recorder.keys = undefined; return false; }
      const win = focusedWindow();
      if (!win) return false;
      const recorder = recorders.get(win.webContents.id);
      if (recorder?.active) {
        if (input.key) {
          if (input.type === 'keyDown' && !input.repeat) {
            const accelerator = [input.meta && 'Command', input.ctrl && 'Control', input.alt && 'Alt', input.shift && 'Shift', input.key].filter(Boolean).join('+');
            win.webContents.send(channels.recordedFn, accelerator);
          }
          return true;
        }
        if (!recorder.allowFn) return input.type === 'flagsChanged';
        if (input.type === 'keyDown') { recorder.keys = undefined; return false; }
        if (input.fn && input.type === 'flagsChanged') {
          if (!recorder.keys && input.keyCode !== 63) return false;
          const old = recorder.keys;
          recorder.keys = { ...input, ctrl: input.ctrl || !!old?.ctrl, alt: input.alt || !!old?.alt, meta: input.meta || !!old?.meta, shift: input.shift || !!old?.shift };
          return true;
        }
        if (!input.fn && recorder.keys) {
          const keys = recorder.keys; recorder.keys = undefined;
          const accelerator = [keys.meta && 'Command', keys.ctrl && 'Control', keys.alt && 'Alt', keys.shift && 'Shift', 'Fn'].filter(Boolean).join('+');
          win.webContents.send(channels.recordedFn, accelerator); return true;
        }
        return false;
      }
      const router = routers.get(win.webContents.id);
      if (input.key) {
        router?.input({ type: input.type === 'keyUp' ? 'keyUp' : 'keyDown', key: input.key, code: `native:${input.keyCode}`, control: input.ctrl, meta: input.meta, alt: input.alt, shift: input.shift, isAutoRepeat: !!input.repeat, isComposing: false, location: 0, modifiers: [] });
        return true;
      }
      const handled = router?.fnInput(input) ?? false;
      return handled || (input.type === 'flagsChanged' && (input.fn || input.keyCode === 63)
        && ['voiceHold', 'voiceToggle'].some(action => isFnAccelerator(effectiveAccelerator(action, overrides()))));
    }); } catch { nativeReady = false; }
    syncPriority();
  });
  app.on('will-quit', () => {appReady=false;globalCapture?.release();nativeMonitor?.stop();});
  const trusted = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
    windows.has(event.sender.id) && event.senderFrame === event.sender.mainFrame;
  ipcMain.handle(channels.priorityPermission, async event => {
    if (!trusted(event)) throw Error('Untrusted shortcut caller');
    if (process.platform !== 'darwin') return;
    systemPreferences.isTrustedAccessibilityClient(true);
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  });
  ipcMain.on(channels.recordFn, (event, enabled: boolean, allowFn = true) => {
    if (!trusted(event)) return;
    recorders.set(event.sender.id, { active: enabled === true, allowFn: allowFn === true });
    routers.get(event.sender.id)?.release();
    syncPriority();
  });
  ipcMain.on(channels.scope, (event, scope?: ComposerShortcutScope) => {
    if (!trusted(event)) return;
    const valid = scope && typeof scope.conversationId === 'string' && scope.conversationId.length <= 256
      && typeof scope.voice === 'boolean' && typeof scope.screenshot === 'boolean';
    routers.get(event.sender.id)?.setScope(valid ? scope : undefined);
    refreshers.get(event.sender.id)?.forEach(refresh => refresh());
  });
  ipcMain.handle(channels.probe, event => {
    if (!trusted(event)) throw Error('Untrusted shortcut caller');
    const result = {} as Record<typeof COMPOSER_SHORTCUTS[number], ShortcutAvailability>;
    // A focus notification can precede macOS's frontmost-process update. Retry a
    // failed tap on status refresh, without restarting a healthy held shortcut.
    if (nativeReady && focusedWindow() && nativeMonitor?.status() === 'unavailable') syncPriority();
    const priorityState = nativeReady ? nativeMonitor?.status() : undefined;
    for (const action of COMPOSER_SHORTCUTS) {
      const accelerator = effectiveAccelerator(action, overrides());
      if (!accelerator) { result[action] = 'unassigned'; continue; }
      if(action==='screenshot'&&globalCapture?.owns(accelerator)){result[action]='global-ready';continue;}
      if (nativeReady) {
        result[action] = priorityState === 'permission-required' ? 'permission-required'
          : priorityState !== 'ready' && priorityState !== 'limited' ? 'priority-unavailable'
          : unsupported.includes(parseAccelerator(accelerator)!.key) ? 'priority-unsupported'
          : priorityState === 'limited' ? 'priority-limited' : 'priority-ready';
        continue;
      }
      if (isFnAccelerator(accelerator)) { result[action] = nativeReady ? 'available' : 'native-unavailable'; continue; }
      // Probe only; never take shortcuts away from other apps or leave a background listener.
      let registered = false;
      try {
        if (!globalShortcut.isRegistered(accelerator)) registered = globalShortcut.register(accelerator, () => {});
        result[action] = registered ? 'available' : 'unavailable';
      } catch { result[action] = 'unavailable'; }
      finally { if (registered) globalShortcut.unregister(accelerator); }
    }
    return result;
  });
  const attach = (contents: WebContents, win: BrowserWindow, router: ComposerShortcutRouter) => {
    const ownerId = win.webContents.id;
    // Electron 31 drops keyUp after a main-process-cancelled keyDown. Cancel held
    // shortcuts in the DOM instead, retaining native keyUp for reliable release.
    // This isolated world has no Node/IPC bridge and exposes nothing to the page.
    let guardReady = false;
    let revision = 0;
    const refresh = () => {
      guardReady = false;
      const current = ++revision;
      if (contents.isDestroyed()) return;
      const parsed = isFnAccelerator(router.holdAccelerator) ? null : parseAccelerator(router.holdAccelerator || '');
      void contents.executeJavaScriptInIsolatedWorld(1007, [{ code: `(() => {
        const state = globalThis.__sageComposerHoldGuard ||= {};
        state.keys = ${JSON.stringify(parsed)};
        if (state.installed) return;
        state.installed = true;
        const matches = ${matchesParsedAccelerator.toString()};
        addEventListener('keydown', event => {
          if (!event.isComposing && state.keys && matches(state.keys, event)) {
            event.preventDefault(); event.stopImmediatePropagation();
          }
        }, true);
      })()` }]).then(() => { if (current === revision) guardReady = true; }).catch(() => {});
    };
    refreshers.get(ownerId)?.add(refresh);
    contents.on('dom-ready', refresh);
    contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) { guardReady = false; ++revision; router.release(); }
    });
    contents.on('before-input-event', (event, input) => {
      if (win.isDestroyed() || !win.isFocused()) return;
      if (!guardReady && input.type === 'keyDown' && matchesAccelerator(router.holdAccelerator,
        { key: input.key, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift })) return;
      const handled = router.input(input);
      if (handled && handled !== 'hold') event.preventDefault();
    });
    contents.once('destroyed', () => { router.release(); refreshers.get(ownerId)?.delete(refresh); });
  };
  app.on('browser-window-created', (_event, win) => {
    const senderId = win.webContents.id;
    const router = new ComposerShortcutRouter(event => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channels.event, event);
    }, overrides);
    routers.set(senderId, router);
    refreshers.set(senderId, new Set());
    attach(win.webContents, win, router);
    win.webContents.on('did-attach-webview', (_event, guest) => attach(guest, win, router));
    win.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) router.setScope(undefined);
    });
    win.webContents.on('render-process-gone', () => router.setScope(undefined));
    win.on('blur', () => { router.release(); const recorder = recorders.get(senderId); if (recorder) recorder.keys = undefined; });
    win.on('focus', syncPriority);
    // Native NSApplication deactivation is the immediate guard. Defer this refresh
    // so Electron has updated isFocused when moving between Sage windows.
    win.on('blur', () => setImmediate(syncPriority));
    win.on('closed', () => { router.setScope(undefined); routers.delete(senderId); refreshers.delete(senderId); recorders.delete(senderId); setImmediate(syncPriority); });
  });
  return { settingsChanged: () => {
    for (const router of routers.values()) router.release();
    for (const refresh of refreshers.values()) refresh.forEach(update => update());
    syncPriority();
  } };
}
