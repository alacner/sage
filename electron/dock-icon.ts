import type { NativeImage } from 'electron';
import type { NativeApplicationState } from './native-fn-shortcuts';

interface DockDependencies {
  platform: string;
  dock: { isVisible(): boolean; show(): Promise<void>; setIcon(image: NativeImage): void };
  candidates(): string[];
  image(file: string): NativeImage | undefined;
  native: { applicationState?(): NativeApplicationState; setDockTileIcon?(file: string): NativeApplicationState };
  log(message: string): void;
  schedule(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  cancel(timer: ReturnType<typeof setTimeout>): void;
}
/** Electron's isVisible checks activation policy, not whether Dock painted an icon. */
export function createDockIconGuard(deps: DockDependencies) {
  let applied = false, pending: Promise<void> | undefined, stopped = false, lastDockPid: number | undefined;
  let lastState = '', failed = false;
  const scheduled = new Set<ReturnType<typeof setTimeout>>();
  const state = () => {
    try { return deps.native.applicationState?.(); }
    catch (error) { deps.log(`dock native state failed: ${String(error)}`); return undefined; }
  };
  const logState = (reason: string, force = false) => {
    const native = state();
    const value = JSON.stringify({ electronPolicyVisible: deps.dock.isVisible(), native: native ?? 'unavailable' });
    if (force || value !== lastState) { lastState = value; deps.log(`dock state ${reason}: ${value}`); }
    return native;
  };
  const ensureIcon = (reason = 'watchdog', force = false) => {
    if (deps.platform !== 'darwin' || stopped || (applied && !force) || pending) return;
    const tried: string[] = [];
    for (const file of deps.candidates()) {
      try {
        const image = deps.image(file);
        if (!image || image.isEmpty()) { tried.push(`${file}:missing-or-undecodable`); continue; }
        // Native preflight checks real pixels before installing its view; a decoded image can still be entirely transparent.
        const result = deps.native.setDockTileIcon?.(file);
        if (deps.native.setDockTileIcon && (!result?.available || !(result.tileRenderVisiblePixels! > 0))) {
          throw new Error('Native Dock raster has no visible pixels');
        }
        // setApplicationIconImage resets custom contentView. The native path
        // sets the image first, then installs and draws its validated view.
        // Electron's setter is only a fallback when the native API is absent.
        if (!deps.native.setDockTileIcon) deps.dock.setIcon(image);
        applied = !deps.native.setDockTileIcon || !!(result && result.tileDrawCount! > 0 && result.tileDrawContextValid);
        failed = false;
        deps.log(`dock icon repaint submitted ${reason}: ${file} ${image.getSize().width}px native=${JSON.stringify(result ?? 'unavailable')}`);
        if (!applied) deps.log(`dock icon awaiting drawRect ${reason}: ${JSON.stringify(result)}`);
        logState('after repaint', true);
        return;
      } catch (error) { tried.push(`${file}:${String(error)}`); }
    }
    if (!failed) { failed = true; deps.log(`dock icon NOT pushed ${reason}: ${tried.join(' | ')}`); }
  };
  const ensureVisible = () => {
    if (deps.platform !== 'darwin' || stopped || pending) return pending;
    const native = state();
    if (deps.dock.isVisible() && (!native?.available || native.policy === 'regular')) return;
    applied = false;
    logState('before show', true);
    // Set the image only after show completes: setting it in the same tick can
    // be discarded while Cocoa registers the application with Dock.
    pending = Promise.resolve().then(() => deps.dock.show()).then(() => {
      pending = undefined;
      if (stopped) return;
      logState('show resolved', true); ensureIcon('show resolved', true);
    }).catch(error => { pending = undefined; deps.log(`dock restore FAILED: ${String(error)}`); });
    return pending;
  };
  const refresh = (reason: string) => {
    if (deps.platform !== 'darwin' || stopped) return;
    // Coalesce lifecycle bursts; three bounded paints survive launch/Space
    // transitions without repeatedly replacing the icon every watchdog tick.
    for (const timer of scheduled) deps.cancel(timer); scheduled.clear();
    logState(reason, true);
    void ensureVisible(); ensureIcon(reason, true);
    for (const delay of [250, 1500, 5000]) {
      const timer = deps.schedule(() => { scheduled.delete(timer); void ensureVisible(); ensureIcon(`${reason}+${delay}ms`, true); }, delay);
      timer.unref?.(); scheduled.add(timer);
    }
  };
  const tick = () => {
    if (deps.platform !== 'darwin' || stopped) return;
    const native = logState('watchdog');
    if (native?.dockPid && lastDockPid !== undefined && native.dockPid !== lastDockPid) refresh('Dock restarted');
    if (native?.dockPid) lastDockPid = native.dockPid;
    // A custom view/image lost after a Space transition is observable even
    // while Electron reports policy-visible. Repaint without hiding the app.
    if (applied && native?.available && deps.native.setDockTileIcon && (!(native.tileViewWidth! > 0) || !(native.tileViewHeight! > 0) || !native.tileImageWidth || !native.tileImageHeight || !(native.tileRenderVisiblePixels! > 0) || !(native.tileDrawCount! > 0) || !native.tileDrawContextValid)) applied = false;
    void ensureVisible(); ensureIcon();
  };
  return { ensureIcon, ensureVisible, refresh, tick,
    stop() { stopped = true; for (const timer of scheduled) deps.cancel(timer); scheduled.clear(); },
  };
}
