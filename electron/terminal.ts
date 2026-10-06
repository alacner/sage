import * as pty from 'node-pty';
import { BrowserWindow } from 'electron';
import { existsSync, realpathSync, statSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { IpcChannels } from '../shared/types';
import { buildSandboxEnv } from './sandbox/env';

interface PtyEntry {
  pty: pty.IPty;
  senderId: number;
  pending: number;
  ready: boolean;
  paused: boolean;
  disposeListeners(): void;
}

const ptys = new Map<string, PtyEntry>();

let idCounter = 0;

/**
 * 运行时自愈：node-pty 1.1.0 的 npm prebuilds 里 spawn-helper 丢失了
 * 可执行位（-rw-r--r--），导致 macOS 上 posix_spawnp 启动终端必然失败。
 *
 * 启动时检测并补回 +x。realpathSync 把 asar 路径解析到 app.asar.unpacked
 * 的真实位置（node-pty 已在 asarUnpack），用户安装的 app 属主是当前用户，
 * chmod 可写。配合打包期 afterPack 钩子双保险：新产物权限正确，旧安装自愈。
 */
function ensureSpawnHelperExecutable(): void {
  try {
    const ptyDir = realpathSync(dirname(require.resolve('node-pty/package.json')));
    const candidates = [
      join(ptyDir, 'prebuilds', 'darwin-arm64', 'spawn-helper'),
      join(ptyDir, 'prebuilds', 'darwin-x64', 'spawn-helper'),
      join(ptyDir, 'build', 'Release', 'spawn-helper'),
    ];
    for (const helper of candidates) {
      if (!existsSync(helper)) continue;
      const mode = statSync(helper).mode;
      if (!(mode & 0o111)) {
        chmodSync(helper, mode | 0o755);
        console.log(`[terminal] restored exec bit: ${helper}`);
      }
    }
  } catch {
    /* best effort：失败走原有 spawn 报错路径 */
  }
}
ensureSpawnHelperExecutable();

/** Shell candidates in preference order. */
const SHELL_CANDIDATES = ['/bin/zsh', '/bin/bash', '/bin/sh'];

/**
 * Resolve the user's login shell with absolute path.
 * Packaged Electron apps launched from Dock don't inherit a proper
 * shell environment, so we must find the shell binary ourselves.
 */
function resolveShell(): string {
  const envShell = process.env.SHELL;
  if (envShell && existsSync(envShell)) return envShell;
  for (const c of SHELL_CANDIDATES) {
    if (existsSync(c)) return c;
  }
  return '/bin/sh';
}

/**
 * Build a sane PATH for the spawned shell.
 * Packaged Electron apps get a minimal PATH from launchd.
 */
function buildPath(): string {
  const existing = process.env.PATH || '';
  const standard = [
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
  ];
  const parts = existing.split(':');
  for (const s of standard) {
    if (!parts.includes(s)) parts.push(s);
  }
  return parts.filter(Boolean).join(':');
}

/**
 * Build a clean environment for the PTY.
 *
 * Sandbox: 复用 sandbox/env 的 buildSandboxEnv() 脱敏环境变量，剥离所有
 * 密钥变量（ANTHROPIC_API_KEY 等），防止 AI 通过终端子进程的 env 读走密钥。
 * 终端是用户主动行为，不走 OS 沙箱，但 env 仍需脱敏。
 *
 * IMPORTANT: We intentionally avoid running `shell -ilc 'env'` to capture
 * the user's login environment. Parsing `env` output is fragile (multi-line
 * values, function exports, etc.) and can produce corrupted entries that
 * cause posix_spawnp to fail. Instead we pass a sanitized env enriched with a
 * good PATH + TERM. The spawned shell reads its own rc files on startup.
 */
function buildEnv(): Record<string, string> {
  // 以 sandbox 脱敏 env 为基础（白名单 + 剥离密钥）
  const env = buildSandboxEnv(process.env.HOME || '/tmp');
  env.PATH = buildPath();
  env.TERM = 'xterm-256color';
  // Ensure HOME is always set — some shells refuse to start without it.
  if (!env.HOME) {
    env.HOME = `/Users/${process.env.USER || process.env.LOGNAME || 'unknown'}`;
  }
  return env;
}

/**
 * Create a new pseudo-terminal for the given working directory.
 * Output is sent to the renderer via the window identified by senderId.
 *
 * Includes multiple fallback strategies to handle packaged-app edge cases:
 * 1. Preferred shell + requested cwd
 * 2. Preferred shell + HOME fallback cwd
 * 3. /bin/sh + /tmp with minimal env
 */
export function createTerminal(
  cwd: string,
  senderId: number,
  getWindows: () => Map<number, BrowserWindow>,
): string {
  const id = `pty-${senderId}-${++idCounter}`;
  const shell = resolveShell();
  const env = buildEnv();
  const safeCwd = existsSync(cwd) ? cwd : (env.HOME && existsSync(env.HOME) ? env.HOME : '/tmp');

  const spawnOpts = {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
  };

  let term: pty.IPty;

  // Attempt 1: resolved shell + project cwd + enriched env
  try {
    term = pty.spawn(shell, [], { ...spawnOpts, cwd: safeCwd, env });
  } catch (err1: any) {
    console.error(`[terminal] spawn attempt 1 failed (shell=${shell}, cwd=${safeCwd}):`, err1?.message);
    // Attempt 2: /bin/sh + HOME + minimal env
    const minEnv = {
      HOME: env.HOME || '/tmp',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      TERM: 'xterm-256color',
      USER: process.env.USER || '',
      SHELL: '/bin/sh',
      LANG: process.env.LANG || 'en_US.UTF-8',
    };
    try {
      term = pty.spawn('/bin/sh', [], { ...spawnOpts, cwd: minEnv.HOME, env: minEnv });
    } catch (err2: any) {
      console.error(`[terminal] spawn attempt 2 failed (/bin/sh, cwd=${minEnv.HOME}):`, err2?.message);
      throw new Error(
        `Terminal spawn failed.\n` +
        `Primary (${shell} @ ${safeCwd}): ${err1?.message}\n` +
        `Fallback (/bin/sh @ ${minEnv.HOME}): ${err2?.message}`
      );
    }
  }

  // Wait for the renderer to mount its xterm before allowing any output.
  term.pause();
  const entry: PtyEntry = {pty:term, senderId, pending:0, ready:false, paused:true, disposeListeners() { dataListener.dispose(); exitListener.dispose(); }};
  ptys.set(id, entry);

  const sendToRenderer = (channel: string, data: any) => {
    const w = getWindows().get(senderId);
    if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return;
    try {
      w.webContents.send(channel, data);
    } catch {
      /* window torn down */
    }
  };

  const dataListener = term.onData((data) => {
    const owner = getWindows().get(senderId);
    if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()) { disposeTerminal(id); return; }
    entry.pending += data.length;
    if (entry.pending >= 64 * 1024 && !entry.paused) { entry.paused = true; term.pause(); }
    sendToRenderer(IpcChannels.TerminalOutput, { id, data });
  });

  const exitListener = term.onExit(({ exitCode }) => {
    sendToRenderer(IpcChannels.TerminalExit, { id, code: exitCode });
    ptys.delete(id); entry.disposeListeners();
  });

  return id;
}

/** Credit is returned only after xterm has parsed the data, not merely received IPC. */
export function acknowledgeTerminal(id: string, count: number, senderId: number, ready = false): void {
  const entry = ptys.get(id);
  if (!entry || entry.senderId !== senderId || !Number.isSafeInteger(count) || count < 0 || count > entry.pending) return;
  if (ready && count !== 0) return;
  // A remounted xterm cannot acknowledge chunks sent to its disposed predecessor.
  // Start a fresh credit window so reopening the view never leaves the PTY paused.
  entry.pending = ready ? 0 : entry.pending - count;
  if (ready) entry.ready = true;
  if (entry.ready && entry.paused && entry.pending <= 16 * 1024) { entry.paused = false; entry.pty.resume(); }
}

export function writeTerminal(id: string, data: string): void {
  const entry = ptys.get(id);
  if (entry) entry.pty.write(data);
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const entry = ptys.get(id);
  if (entry) entry.pty.resize(cols, rows);
}

export function disposeTerminal(id: string): void {
  const entry = ptys.get(id);
  if (!entry) return;
  ptys.delete(id); entry.disposeListeners();
  try { entry.pty.kill(); } catch { /* already exited */ }
}

/**
 * Kill all PTYs owned by a specific window (called on window close).
 */
export function disposeAllForWindow(senderId: number): void {
  for (const [id, entry] of ptys) {
    if (entry.senderId === senderId) {
      disposeTerminal(id);
    }
  }
}
