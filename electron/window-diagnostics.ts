import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { loadFnKeyMonitor, type NativeApplicationState } from './native-fn-shortcuts';

/**
 * 窗口 / Dock 可见性诊断（宠物"打开后 Dock 和主窗口一起消失"的取证通道）。
 *
 * 已用标准 Electron v31.7.7 发行包做对照实验复现：宠物窗口调用
 * setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) 的那一毫秒，
 * app.dock.isVisible() 仅代表 activation policy，不代表图标像素。
 * 原生日志记录应用图标、Dock tile 及自己的窗口遮挡/Space 状态（不含标题）。
 * app.dock.isVisible() 从 true 翻成 false（Electron 实现层顺手把 app 切成 accessory）；
 * 加 skipTransformProcessType: true 后 Dock 全程不再翻面（现行修法）。
 * 但“主窗口消失”发生在 Space / 系统隐藏层——BrowserWindow.isVisible() 全程是 true，
 * 观测不到。能观测的只有 app.isHidden() 与 win.isHiddenInMissionControl()，
 * 所以这里按时间线记录这三者 + 每个窗口的可见/最小化/聚焦标记。
 *
 * 纪律：只在状态**变化**时写一行（窗口拖拽、尺寸调整不算状态变化，故 bounds 不进指纹），
 * 正常运行时日志几乎不增长；文件 app.getPath('logs')/windows.log，超过上限保留后半。
 */

export interface WindowSnap {
  id: number;
  role: string;
  visible: boolean;
  minimized: boolean;
  focused: boolean;
  hiddenInMC: boolean;
  bounds: string;
}
export interface DiagSnap { dockVisible: boolean; appHidden: boolean; windows: WindowSnap[]; native?: NativeApplicationState; }
function nativeState(): NativeApplicationState | undefined {
  try { return loadFnKeyMonitor()?.applicationState?.(); } catch { return undefined; }
}

const FLAGS = { visible: 'V', minimized: 'M', focused: 'F', hiddenInMC: 'H' } as const;

/** 状态指纹：判断"要不要写一行"。刻意不含 bounds——宠物拖拽/展开每帧都在变，会把日志刷爆。 */
export function fingerprint(s: DiagSnap): string {
  const wins = [...s.windows]
    .sort((a, b) => a.id - b.id)
    .map((w) => `${w.role}#${w.id}:${Object.entries(FLAGS).map(([k, ch]) => (w as any)[k] ? ch : '-').join('')}`)
    .join(';');
  return `${s.dockVisible ? 'dock:V' : 'dock:HIDDEN'}|${s.appHidden ? 'appHidden:Y' : 'appHidden:N'}|${wins}${s.native ? '|native:'+JSON.stringify(s.native) : ''}`;
}

/** 一行人类可读的快照（含 bounds，方便和"当时屏幕上还有什么"对上）。 */
export function formatSnap(s: DiagSnap): string {
  return fingerprint(s) + ' [' + [...s.windows].sort((a, b) => a.id - b.id).map((w) => `${w.role}#${w.id} ${w.bounds}`).join(' | ') + ']';
}

/** 日志文件上限：超出后保留后半段（诊断日志不该无限吃磁盘）。循环裁除直到真正落到上限内。 */
export function rotateIfNeeded(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let out = text;
  while (Buffer.byteLength(out) > maxBytes) {
    const cut = Math.floor(out.length / 2);
    const nl = out.indexOf('\n', cut);
    if (nl < 0) break; // 只剩单行（不应发生）：宁可留着这一行也不清零日志
    out = out.slice(nl + 1);
  }
  return out;
}

function logFile(): string {
  return path.join(app.getPath('logs'), 'windows.log');
}

/** 追加一行诊断（带 ISO 时间戳）。任何 IO 失败都不允许影响主链路。 */
export function diagWindow(msg: string): void {
  try {
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let prev = '';
    try { prev = fs.readFileSync(file, 'utf8'); } catch { /* 首次 */ }
    const next = rotateIfNeeded(prev + `${new Date().toISOString()} ${msg}\n`, 512 * 1024);
    fs.writeFileSync(file, next, 'utf8');
  } catch { /* 日志失败不影响主链路 */ }
  console.log('[win-diag]', msg);
}

export function windowDiagnosticsPath(): string {
  return logFile();
}

const traced = new WeakSet<BrowserWindow>();
const WATCH_EVENTS = ['show', 'hide', 'minimize', 'restore', 'focus', 'blur', 'close', 'enter-full-screen', 'leave-full-screen'] as const;

function snapWindow(win: BrowserWindow, role: string): WindowSnap {
  let hiddenInMC = false;
  try { hiddenInMC = typeof (win as any).isHiddenInMissionControl === 'function' && win.isHiddenInMissionControl(); } catch { /* destroyed */ }
  const [w, h] = win.getSize();
  const [x, y] = win.getPosition();
  return {
    id: win.webContents.id,
    role,
    visible: win.isVisible(),
    minimized: win.isMinimized(),
    focused: win.isFocused(),
    hiddenInMC,
    bounds: `${x},${y} ${w}x${h}`,
  };
}

/** 抓一次全局状态。dockVisible 在非 macOS 上恒为 true（没有 Dock 概念）。 */
export function takeSnapshot(getWindows: () => BrowserWindow[], roleOf: (w: BrowserWindow) => string, dockVisible: boolean, appHidden: boolean): DiagSnap {
  const windows: WindowSnap[] = [];
  for (const w of getWindows()) {
    if (w.isDestroyed()) continue;
    if (!traced.has(w)) {
      traced.add(w);
      for (const ev of WATCH_EVENTS) {
        // Electron  typings 为每个事件名写了单独的重载，循环里的联合字面量无法匹配，
        // 固定到其中一个即可（运行时就是 addEventListener 风格的名字→回调）。
        w.on(ev as 'show', () => {
          const id = w.isDestroyed() ? '?' : w.webContents.id;
          diagWindow(`event ${roleOf(w)}#${id}: ${ev} → ${formatSnap(takeSnapshotQuiet(getWindows, roleOf, isDockVisible(), isAppHidden()))}`);
        });
      }
    }
    windows.push(snapWindow(w, roleOf(w)));
  }
  return { dockVisible, appHidden, windows, native: nativeState() };
}

/**
 * Dock 当前是否可见（非 macOS 无 Dock 概念，恒为 true）。
 * 叫 isDockVisible 而不是 dockVisible：takeSnapshot() 的形参就叫 dockVisible，同名会在
 * 事件回调里被阴影成布尔值（dockVisible() → TypeError）。
 */
export function isDockVisible(): boolean {
  if (process.platform !== 'darwin' || !app.dock) return true;
  try { return app.dock.isVisible(); } catch { return true; }
}

/** app 是否被系统整体隐藏（accessory / 隐到后台）。BrowserWindow.isVisible() 对这种摘除不敏感。 */
export function isAppHidden(): boolean {
  try { return app.isHidden(); } catch { return false; }
}
/** 事件回调里取状态时避免递归重挂监听（同一批窗口已经 traced）。 */
function takeSnapshotQuiet(getWindows: () => BrowserWindow[], roleOf: (w: BrowserWindow) => string, dockVisible: boolean, appHidden: boolean): DiagSnap {
  return { dockVisible, appHidden, windows: getWindows().filter((w) => !w.isDestroyed()).map((w) => snapWindow(w, roleOf(w))), native: nativeState() };
}

let pollTimer: NodeJS.Timeout | null = null;

/**
 * 启动可见性看门狗：每 intervalMs 比对指纹，只在变化时写行。
 * 返回停止函数（应用退出时调用，避免定时器拖住进程）。
 */
export function startWindowDiagnostics(opts: { getWindows: () => BrowserWindow[]; roleOf: (w: BrowserWindow) => string; intervalMs?: number }): () => void {
  if (pollTimer) return stopWindowDiagnostics;
  let last = '';
  const tick = () => {
    try {
      const snap = takeSnapshot(opts.getWindows, opts.roleOf, isDockVisible(), isAppHidden());
      const fp = fingerprint(snap);
      const first = !last;
      if (first || fp !== last) {
        if (first) {
          // 先写一行基线：让“日志到底有没有活”可确认（每次启动只一行）
          diagWindow(`watchdog start ${formatSnap(snap)}`);
        } else {
          // dock 翻面是唯一能确定归因的信号（谁把 app 切成 accessory）：分方向高亮，
          // “消失”那行才是凶手，“恢复”那行通常是看门狗拉回。
          const wasDockVisible = last.startsWith('dock:V');
          const flipTag = snap.dockVisible === wasDockVisible ? '' : (snap.dockVisible ? '⚠ DOCK 恢复 ' : '⚠ DOCK 消失 ');
          diagWindow(`${flipTag}${formatSnap(snap)}`);
        }
        last = fp;
      }
    } catch (err) {
      diagWindow(`snapshot failed: ${(err as Error).message}`);
      stopWindowDiagnostics();
    }
  };
  pollTimer = setInterval(tick, opts.intervalMs ?? 1000);
  pollTimer.unref();
  tick();
  return stopWindowDiagnostics;
}

export function stopWindowDiagnostics(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
