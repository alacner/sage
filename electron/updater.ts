import macUpdateTargets from '../shared/mac-update-targets.json';
import { setUpdateInstalling } from './update-install-gate';
import { resolveLanguage } from '../shared/language';
import { validateUpdateChecksum, verifyUpdateFile } from './update-integrity';
import { retryUpdateNetwork } from './update-network-retry';
import { relayUpdateUrl } from '../shared/relay-url';
/**
 * 自动更新引擎（自研，零依赖）。
 *
 * 更新源：任意静态文件服务器，目录下放两个按架构区分的清单：`latest-mac.json`（arm64）、`latest-mac-intel.json`（x64）：
 *
 *   {
 *     "version": "0.6.0",
 *     "url": "https://server/sage/Sage-0.6.0-arm64.dmg",
 *     "notes": "本次更新内容…",
 *     "publishedAt": "2026-09-04T12:00:00.000Z"
 *   }
 *
 * 流程：
 *   1. check：按运行架构拉取 ${updateServerUrl}/latest-mac*.json，与当前版本比较
 *   2. download：流式下载 dmg 到 userData/updates/，实时上报进度，安装前核对 SHA-256
 *   3. install：hdiutil 挂载 dmg → ditto 覆盖安装到当前 app 所在目录 →
 *      清理 quarantine 扩展属性 → relaunch
 *
 * 状态通过 UpdateStatus 通道推送给所有窗口（UpdateStatusPayload）。
 * 开发模式（未打包）下直接禁用。
 */
import { app, BrowserWindow, net, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { IpcChannels } from '../shared/types';
import type { UpdateStatusPayload } from '../shared/types';
import { readSettings } from './main';
import { probeHttp, isHttpUrl, type ProbeResult } from './net-probe';

const execFileP = promisify(execFile);

type GetWindows = () => Map<number, BrowserWindow>;
let windowsRef: GetWindows = () => new Map();

let currentStatus: UpdateStatusPayload = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  configured: false,
};

/** 下载中的中断控制。 */
let downloading = false;
let checking = false;
let ignoredSupersededVersion: string | undefined;
let activeTransfer: Promise<void> | undefined;
let readyDownload: { path: string; sha256: string } | undefined;
let taskCount = () => 0;
let installPromptOpen = false;

async function installReadyUpdate(): Promise<void> {
  if (!readyDownload || installPromptOpen) return;
  installPromptOpen = true;
  try {
    const en = resolveLanguage((await readSettings()).language) === 'en';
    await checkForUpdates(true);
    if (currentStatus.supersededBy) {
      const {response} = await dialog.showMessageBox({type:'question',
        message: en ? `Version ${currentStatus.supersededBy} is now available. Version ${currentStatus.latestVersion} is already downloaded.` : `发现新版 ${currentStatus.supersededBy}，当前已下载 ${currentStatus.latestVersion}。`,
        buttons: en ? ['Later','Download newer version','Install downloaded version'] : ['稍后','放弃当前，下载新版','安装已下载版本'], defaultId:0,cancelId:0});
      if (response === 0) return;
      if (response === 1) { readyDownload = undefined; installPromptOpen = false; await switchToNewerVersion(); return; }
    }
    const count = taskCount();
    if (count > 0) {
      const {response} = await dialog.showMessageBox({type:'warning',
        message: en ? `${count} tasks are running or queued. Installing now will interrupt them and restart Sage.` : `还有 ${count} 项任务正在运行或排队。现在安装会中断任务并重启 Sage。`,
        buttons: en ? ['Keep working','Install and restart'] : ['继续工作，稍后安装','仍然安装并重启'], defaultId:0,cancelId:0});
      if (response !== 1) return;
    }
    setUpdateInstalling(true);
    await verifyUpdateFile(readyDownload.path, readyDownload.sha256);
    setStatus({phase:'installing'});
    await installFromDmg(readyDownload.path);
  } catch (error: any) {
    readyDownload = undefined;
    setStatus({phase:'error',errorPhase:'install',error:String(error?.message ?? error)});
  } finally {
    setUpdateInstalling(false);
    installPromptOpen = false;
  }
}


/**
 * 下载单飞控制：世代号。
 * 每次启动新下载/中止下载时递增；旧下载流的进度上报与错误兜底在
 * 世代号不匹配时全部失效，杜绝并发下载互相覆盖状态（进度跳变）。
 */
let downloadGeneration = 0;
/** 当前活跃下载的网络请求与目标文件（供外部中止 / 清理部分文件）。 */
let activeRequest: any = null;
let activeDest: string | null = null;

/**
 * 当前是否处于不可打断的更新流程（下载/安装）。
 * 同时检查 flag 和 phase，防止二者不同步时状态被覆盖。
 */
function isUpdateInProgress(): boolean {
  return downloading || currentStatus.phase === 'downloading' || currentStatus.phase === 'installing';
}

/** 状态变化回调列表（main.ts 注册 rebuildAppMenu）。 */
const statusChangeCallbacks: Array<(status: UpdateStatusPayload) => void> = [];

/**
 * 注册状态变化回调。
 * main.ts 用此注册 rebuildAppMenu，当更新状态变化时重建菜单。
 */
export function onStatusChange(cb: (status: UpdateStatusPayload) => void): () => void {
  statusChangeCallbacks.push(cb);
  return () => {
    const idx = statusChangeCallbacks.indexOf(cb);
    if (idx >= 0) statusChangeCallbacks.splice(idx, 1);
  };
}

function broadcast(): void {
  for (const w of windowsRef().values()) {
    if (!w.isDestroyed()) {
      w.webContents.send(IpcChannels.UpdateStatus, currentStatus);
    }
  }
  // 通知注册的回调（用于重建菜单等）
  for (const cb of statusChangeCallbacks) {
    try {
      cb(currentStatus);
    } catch (e) {
      console.error('[updater] status change callback error:', e);
    }
  }
}

function setStatus(patch: Partial<UpdateStatusPayload>): void {
  if (patch.phase && patch.phase !== 'error') patch = { ...patch, error: undefined, errorPhase: undefined };
  currentStatus = { ...currentStatus, ...patch };
  broadcast();
}

function macUpdateTarget() {
  const target = macUpdateTargets.find(item => item.arch === process.arch);
  if (!target) throw new Error(`不支持的 Mac 更新架构：${process.arch}`);
  return target;
}

/** Check, probe, download and supersession all use the same runtime architecture. */
function manifestUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, '');
  return `${trimmed}/${macUpdateTarget().manifest}`;
}

/**
 * 计算生效的更新服务器地址：
 * 1. 中继推导（`中继域名 + /updates`）—— 配置正确时更新源就固定跟着中继走，
 *    设置页此时也不再提供自定义入口（口径见 shared/relay-url 的 relayUpdateUrl）
 * 2. 中继没配 / 不可用时，才用用户自定义 updateServerUrl
 * 3. 都没有 → undefined（未配置，自动更新禁用，允许各自按需配置）
 */
async function effectiveUpdateUrl(): Promise<string | undefined> {
  const settings = await readSettings();
  return relayUpdateUrl(settings.relayHookBaseUrl, settings.relayUrl)
    || settings.updateServerUrl?.trim()
    || undefined;
}

/**
 * 更新源自检：GET 一次生效地址下当前架构的清单（200 即正常）。
 * urlOverride 为设置页输入的自定义地址（优先于已保存配置，供输入时实时检测）。
 */
export async function probeUpdateService(urlOverride?: string): Promise<ProbeResult> {
  const custom = urlOverride?.trim();
  const base = custom && isHttpUrl(custom) ? custom.replace(/\/+$/, '') : await effectiveUpdateUrl();
  if (!base) return { ok: false, url: '', error: 'not-configured' };
  // /updates 别名仅放行 Sage 客户端（服务端校验 UA）：探针必须带与 net.request 相同的
  // 标识头/UA，否则全局 fetch 的默认 UA 会被判 403 而误报「服务异常」。
  return probeHttp(manifestUrl(base), undefined, {
    'User-Agent': `Sage/${app.getVersion()} Electron/${process.versions.electron}`,
    'X-Sage-Client': `sage/${app.getVersion()}`,
  });
}

/** 简单的 semver 比较：a > b 返回 1，a < b 返回 -1，相等返回 0。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** 支持重定向的 HTTP(S) GET，返回 buffer。走 Electron net 模块（UA 自动带
 *  "Sage/<version> Electron/..." 标识），并显式加自定义头双重标识。
 *  HTTP 错误时读取响应体开头，附带进错误信息方便诊断。 */
function fetchBuffer(url: string, redirects = 5): Promise<Buffer> {
  return retryUpdateNetwork(() => fetchBufferOnce(url, redirects));
}

function fetchBufferOnce(url: string, redirects: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = net.request({
      url,
      method: 'GET',
      headers: { 'X-Sage-Client': `sage/${app.getVersion()}` },
    });
    const timer = setTimeout(() => { reject(new Error('ETIMEDOUT')); req.abort(); }, 15000);
    req.on('response', (res: any) => {
      const status = res.statusCode ?? 0;
      // 重定向
      if (status >= 300 && status < 400) {
        const location = res.headers.location;
        res.destroy();
        clearTimeout(timer);
        if (!location || redirects <= 0) { reject(new Error(`重定向次数过多（${url}）`)); return; }
        const next = new URL(Array.isArray(location) ? location[0] : location, url).toString();
        fetchBufferOnce(next, redirects - 1).then(resolve, reject);
        return;
      }
      // HTTP 错误：读取响应体开头，报错时带上便于诊断
      if (status >= 400 || status === 0) {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          clearTimeout(timer);
          const body = Buffer.concat(chunks).toString('utf-8').trim().slice(0, 300).replace(/\s+/g, ' ');
          reject(new Error(`HTTP ${status}（${url}）${body ? `：${body}` : ''}`));
        });
        res.on('error', (e: Error) => { clearTimeout(timer); reject(e); });
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
      res.on('error', (e: Error) => { clearTimeout(timer); reject(e); });
    });
    req.on('error', (e: Error) => { clearTimeout(timer); reject(new Error(`网络错误（${url}）：${e?.message ?? e}`)); });
    req.end();
  });
}

/** 下载清单。解析失败时给出完整诊断：请求地址 + HTTP 状态 + 响应开头内容，
 *  让用户能看出服务器到底返回了什么（常见坑：地址写错返回 HTML 页面）。 */
async function fetchManifest(base: string): Promise<{ version: string; url: string; notes?: string; sha256: string }> {
  const url = manifestUrl(base);
  const buf = await fetchBuffer(url);
  const text = buf.toString('utf-8');
  // 预检：HTML 页面直接给出明确报错（而不是让 JSON.parse 报难以理解的语法错）
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<')) {
    const preview = trimmed.slice(0, 300).replace(/\s+/g, ' ');
    throw new Error(
      `服务器返回的不是 JSON 清单（疑似 HTML 页面）。\n请求地址：${url}\n响应开头：${preview}`,
    );
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch (e: any) {
    const preview = trimmed.slice(0, 300).replace(/\s+/g, ' ');
    throw new Error(
      `清单 JSON 解析失败：${e?.message ?? e}\n请求地址：${url}\n响应开头：${preview}`,
    );
  }
  if (typeof json.version !== 'string' || !json.version || typeof json.url !== 'string' || !json.url) {
    throw new Error(`清单格式错误：缺少 version 或 url 字段（请求地址：${url}）`);
  }
  const target = macUpdateTarget();
  if (json.arch !== undefined && json.arch !== target.arch) {
    throw new Error(`更新清单架构不匹配：需要 ${target.arch}，收到 ${String(json.arch)}（请求地址：${url}）`);
  }
  const packageUrl = new URL(json.url);
  if (!['https:', 'http:'].includes(packageUrl.protocol)) throw new Error(`安装包下载地址无效（请求地址：${url}）`);
  // Existing custom manifests may omit arch. Reject an explicitly wrong Sage
  // artifact as well, while retaining custom hosting and custom package names.
  const artifact = /^Sage-(\d+\.\d+\.\d+)(?:-(arm64|x64))?\.dmg$/.exec(decodeURIComponent(path.basename(packageUrl.pathname)));
  if (artifact && ((artifact[2] || 'x64') !== target.arch || artifact[1] !== json.version)) {
    throw new Error(`安装包版本或架构与更新清单不匹配（请求地址：${url}）`);
  }
  validateUpdateChecksum(json.sha256);
  return json;
}

/**
 * 检查更新。
 * @param silent 静默检查（定时触发）：未配置 / 无新版本时不打扰用户
 */
export async function checkForUpdates(silent = true): Promise<UpdateStatusPayload> {
  if (checking) {
    broadcast();
    return currentStatus;
  }
  // 下载/安装进行中：不打断、不覆盖状态；仅顺带探测是否出现了更新的版本，
  // 供 UI 提示「切换到新版本 / 继续当前下载」。
  if (isUpdateInProgress() || currentStatus.phase === 'ready') {
    const generation = downloadGeneration;
    const version = currentStatus.latestVersion;
    try {
      const base = await effectiveUpdateUrl();
      if (base) {
        const manifest = await fetchManifest(base);
        if (generation === downloadGeneration && version === currentStatus.latestVersion && manifest.version !== ignoredSupersededVersion && currentStatus.latestVersion && compareVersions(manifest.version, currentStatus.latestVersion) > 0) {
          setStatus({ supersededBy: manifest.version });
        }
      }
    } catch { /* 探测失败不打扰进行中的下载 */ }
    broadcast();
    return currentStatus;
  }
  if (!app.isPackaged) {
    setStatus({ phase: 'error', error: '开发模式下不支持自动更新', configured: false });
    return currentStatus;
  }

  const base = await effectiveUpdateUrl();
  if (!base) {
    setStatus({ phase: 'idle', configured: false });
    return currentStatus;
  }

  checking = true;
  setStatus({ phase: 'checking', configured: true, error: undefined });
  try {
    const manifest = await fetchManifest(base);
    // 异步窗口期内可能已有下载启动（如用户同时点了安装）：不覆盖其状态
    if (isUpdateInProgress()) {
      broadcast();
      return currentStatus;
    }
    const current = app.getVersion();
    if (compareVersions(manifest.version, current) > 0) {
      setStatus({
        phase: 'available',
        latestVersion: manifest.version,
        notes: manifest.notes,
        progress: undefined,
        received: undefined,
        total: undefined,
      });
      if ((await readSettings()).autoInstallUpdates === true) {
        // The manifest check is complete; allow newer-version probes during the download.
        checking = false;
        await downloadAndInstall();
      }
    } else {
      setStatus({
        phase: 'not-available',
        latestVersion: manifest.version,
        notes: manifest.notes,
      });
      // 静默检查时把「已是最新」状态淡掉，避免状态栏常驻
      if (silent) {
        setTimeout(() => {
          if (currentStatus.phase === 'not-available') setStatus({ phase: 'idle' });
        }, 5000);
      }
    }
  } catch (e: any) {
    setStatus({ phase: 'error', errorPhase: 'check', error: `检查更新失败：${e?.message ?? e}` });
    if (silent) {
      // 静默检查失败不长期打扰，10 秒后淡出
      setTimeout(() => {
        if (currentStatus.phase === 'error') setStatus({ phase: 'idle' });
      }, 10000);
    }
  }
  checking = false;
  return currentStatus;
}

/** 更新下载目录。 */
function updatesDir(): string {
  return path.join(app.getPath('userData'), 'updates');
}

/**
 * 下载并安装更新。下载完成后自动执行安装（挂载 → ditto → relaunch）。
 */
export async function downloadAndInstall(restart = false): Promise<void> {
  if (restart) readyDownload = undefined;
  if (readyDownload && !restart) { await installReadyUpdate(); return; }
  if (!app.isPackaged) {
    setStatus({ phase: 'error', error: '开发模式下不支持自动更新' });
    return;
  }
  // 立即占位，防止异步间隙内 checkForUpdates 覆盖状态
  if (isUpdateInProgress()) {
    // 已有下载/安装在进行：广播当前真实状态让前端同步（而非静默无反应）
    broadcast();
    return;
  }
  downloading = true;
  // 世代号：此后旧下载流的一切上报/兜底全部失效，保证同一时刻只有一个有效下载
  const gen = ++downloadGeneration;
  ignoredSupersededVersion = undefined;

  const { latestVersion } = currentStatus;
  if (!latestVersion) {
    downloading = false;
    setStatus({ phase: 'error', error: '没有可用的新版本，请先检查更新' });
    return;
  }

  const base = await effectiveUpdateUrl();
  if (gen !== downloadGeneration) return;
  if (!base) {
    downloading = false;
    setStatus({ phase: 'error', error: '未配置更新服务器（也未配置入站中继）' });
    return;
  }

  try {
    // 1. 拉清单拿真实下载地址
    setStatus({ phase: 'downloading' });
    const manifest = await fetchManifest(base);
    if (gen !== downloadGeneration) return;

    setStatus({latestVersion:manifest.version,notes:manifest.notes,supersededBy:undefined});

    // 2. 流式下载 dmg（支持断点续传）
    const dir = updatesDir();
    await fsp.mkdir(dir, { recursive: true });
    const fileName = path.basename(new URL(manifest.url).pathname) || `Sage-${manifest.version}${macUpdateTarget().packageSuffix}.dmg`;
    const dmgPath = path.join(dir, fileName);
    if (restart) await fsp.rm(dmgPath, { force: true });
    // 清理旧的安装包（保留当前目标文件以支持续传）
    try {
      for (const f of await fsp.readdir(dir)) {
        if (f.endsWith('.dmg') && path.join(dir, f) !== dmgPath) {
          await fsp.unlink(path.join(dir, f)).catch(() => {});
        }
      }
    } catch { /* ignore */ }

    // 检查已有部分下载的文件大小
    let offset = 0;
    try {
      const stat = await fsp.stat(dmgPath);
      if (stat.isFile() && stat.size > 0) offset = stat.size;
    } catch { /* 文件不存在，从头下载 */ }

    if (gen !== downloadGeneration) return;
    activeDest = dmgPath;
    setStatus({ phase: 'downloading', supersededBy: undefined, progress: 0, received: offset, total: undefined });
    activeTransfer = retryUpdateNetwork(async () => {
      const stat = await fsp.stat(dmgPath).catch(() => null);
      await streamDownload(manifest.url, dmgPath, stat?.isFile() ? stat.size : 0, gen);
    }, () => gen === downloadGeneration);
    await activeTransfer;
    if (gen !== downloadGeneration) return;
    try {
      await verifyUpdateFile(dmgPath, manifest.sha256);
    } catch (verifyErr) {
      // 校验失败说明续传文件损坏，删除后让下次从头下载
      await fsp.unlink(dmgPath).catch(() => {});
      throw new Error(`安装包校验失败（已清除损坏文件，请重试）：${(verifyErr as any)?.message ?? verifyErr}`);
    }

    if (gen !== downloadGeneration) return;
    readyDownload = {path:dmgPath, sha256:manifest.sha256};
    setStatus({phase:'ready',progress:100});
    await installReadyUpdate();
  } catch (e: any) {
    // 被 cancelActiveDownload 中止（如切换新版本）：不报错，交由新流程接管状态
    if (gen !== downloadGeneration) return;
    setStatus({ phase: 'error', errorPhase: currentStatus.phase === 'installing' ? 'install' : 'download', error: `更新失败：${e?.message ?? e}` });
  } finally {
    if (gen === downloadGeneration) {
      downloading = false;
      activeRequest = null;
      activeDest = null;
    }
  }
}

/** 流式下载，支持重定向、断点续传与进度上报。走 Electron net 模块，
 *  UA 自动带 "Sage/<version> Electron/..."，并附加 X-Sage-Client 头。
 *  offset > 0 时发送 Range 头尝试续传；服务器不支持则回退全量下载。
 *  gen 为下载世代号：与 downloadGeneration 不一致时停止一切状态上报（已被中止/替换）。 */
function streamDownload(url: string, dest: string, offset = 0, gen = downloadGeneration, redirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const alive = () => gen === downloadGeneration;
    if (!alive()) { reject(new Error('Update cancelled')); return; }
    let fail = (error: Error) => reject(error);
    const emit = (patch: Partial<UpdateStatusPayload>) => {
      if (alive()) setStatus(patch);
    };
    const headers: Record<string, string> = { 'X-Sage-Client': `sage/${app.getVersion()}` };
    if (offset > 0) headers['Range'] = `bytes=${offset}-`;
    const req = net.request({ url, method: 'GET', headers });
    if (alive()) activeRequest = req;
    const timer = setTimeout(() => { fail(new Error('ETIMEDOUT')); req.abort(); }, 30000);
    req.on('response', (res: any) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        const location = res.headers.location;
        res.destroy();
        clearTimeout(timer);
        if (!location || redirects <= 0) { reject(new Error('重定向次数过多')); return; }
        const next = new URL(Array.isArray(location) ? location[0] : location, url).toString();
        streamDownload(next, dest, offset, gen, redirects - 1).then(resolve, reject);
        return;
      }
      // 服务器不支持 Range（返回 200 而非 206）→ 回退全量下载
      if (status === 200 && offset > 0) {
        offset = 0;
        // 继续处理，以覆盖模式写入
      } else if (status === 416 && offset > 0) {
        // 已完整落盘但在响应结束前断网：直接交给后续 SHA-256 校验，避免整包重下。
        const range = String(res.headers['content-range'] ?? '');
        res.destroy();
        clearTimeout(timer);
        if (range === `bytes */${offset}`) { resolve(); return; }
        fsp.unlink(dest).catch(() => {}).then(() => {
          streamDownload(url, dest, 0, gen, redirects).then(resolve, reject);
        });
        return;
      }
      if (status >= 400 || status === 0) {
        res.destroy();
        clearTimeout(timer);
        reject(new Error(`下载失败：HTTP ${status}`));
        return;
      }
      clearTimeout(timer);
      if (status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(res.headers['content-range'] ?? ''));
        if (!range || Number(range[1]) !== offset || Number(range[2]) < offset || Number(range[2]) + 1 !== Number(range[3])) {
          res.destroy();
          reject(new Error('服务器返回了无效的续传范围，已保留下载文件，请重试'));
          return;
        }
      }
      const contentLength = Number(res.headers['content-length'] ?? 0);
      // 206 时 content-length 是剩余部分；总大小 = offset + 剩余
      const total = status === 206 ? Number(String(res.headers['content-range']).split('/')[1]) : contentLength;
      let received = status === 206 ? offset : 0;
      let lastEmit = 0;
      let lastData = Date.now();
      // 206 追加模式；200 覆盖模式
      const file = fs.createWriteStream(dest, { flags: status === 206 ? 'a' : 'w' });
      let failed = false;
      // 停滞检测：60 秒无数据则中断（保留已下载部分供下次续传）
      const stallTimer = setInterval(() => {
        if (Date.now() - lastData > 60000) {
          fail(new Error('ETIMEDOUT: update download stalled'));
          req.abort();
        }
      }, 5000);
      fail = (error: Error) => {
        if (failed) return;
        failed = true;
        clearInterval(stallTimer);
        res.unpipe(file);
        res.destroy();
        // Flush queued bytes and close before a retry measures the resume offset.
        if (file.closed) reject(error);
        else { file.once('close', () => reject(error)); file.end(); }
      };
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        lastData = Date.now();
        const now = Date.now();
        if (now - lastEmit > 200) {
          lastEmit = now;
          emit({
            progress: total > 0 ? Math.min(99, Math.round((received / total) * 100)) : undefined,
            received,
            total: total || undefined,
          });
        }
      });
      res.pipe(file);
      file.on('finish', () => {
        clearInterval(stallTimer);
        if (failed) return;
        if (total > 0 && received !== total) {
          fail(new Error('ERR_CONNECTION_CLOSED: incomplete update download'));
          return;
        }
        if (alive()) activeRequest = null;
        emit({ progress: 100, received, total: total || received });
        file.close(() => resolve());
      });
      file.on('error', (err: Error) => {
        fail(err);
      });
      res.on('error', (e: Error) => {
        fail(e);
      });
      res.on('aborted', () => fail(new Error('ERR_CONNECTION_CLOSED: update response aborted')));
      res.on('close', () => {
        if (!res.readableEnded) fail(new Error('ERR_CONNECTION_CLOSED: update response closed'));
      });
    });
    req.on('error', (e: Error) => { clearTimeout(timer); fail(e); });
    req.on('abort', () => { clearTimeout(timer); fail(new Error('Update cancelled')); });
    req.end();
  });
}

/**
 * 中止当前活跃的下载。
 * @param deletePartial 是否删除已下载的部分文件（切换新版本时删除；默认保留供续传）
 */
export async function cancelActiveDownload(deletePartial = false): Promise<void> {
  if (!downloading && !activeRequest) return;
  // 世代号前移：旧流后续的一切上报/错误兜底自动失效
  downloadGeneration++;
  downloading = false;
  const req = activeRequest;
  const dest = activeDest;
  activeRequest = null;
  activeDest = null;
  try { req?.abort(); } catch { /* ignore */ }
  await activeTransfer?.catch(() => {});
  activeTransfer = undefined;
  if (deletePartial && dest) await fsp.unlink(dest).catch(() => {});
}

/** User cancellation preserves partial bytes for a later retry. */
export async function cancelUpdateDownload(): Promise<UpdateStatusPayload> {
  if (currentStatus.phase === 'installing' || installPromptOpen || !downloading) return currentStatus;
  await cancelActiveDownload();
  setStatus({phase:'available', progress:undefined, received:undefined, total:undefined, supersededBy:undefined, error:undefined, errorPhase:undefined});
  return currentStatus;
}

/**
 * 下载中发现了更新版本 → 用户选择切换：
 * 中止旧下载并删除其部分文件，重新拉取清单后开始下载新版本。
 */
export async function switchToNewerVersion(): Promise<UpdateStatusPayload> {
  if (installPromptOpen || currentStatus.phase === 'installing') return currentStatus;
  readyDownload = undefined;
  await cancelActiveDownload(true);
  const base = await effectiveUpdateUrl();
  if (!base) {
    setStatus({ phase: 'error', error: '未配置更新服务器（也未配置入站中继）' });
    return currentStatus;
  }
  try {
    const manifest = await fetchManifest(base);
    setStatus({
      phase: 'available',
      configured: true,
      latestVersion: manifest.version,
      notes: manifest.notes,
      supersededBy: undefined,
      progress: undefined,
      received: undefined,
      total: undefined,
      error: undefined,
    });
    await downloadAndInstall();
  } catch (e: any) {
    setStatus({ phase: 'error', error: `切换到新版本失败：${e?.message ?? e}` });
  }
  return currentStatus;
}

/** 忽略「发现更新版本」提示：继续当前下载。 */
export function dismissSuperseded(): UpdateStatusPayload {
  if (currentStatus.supersededBy) { ignoredSupersededVersion = currentStatus.supersededBy; setStatus({ supersededBy: undefined }); }
  else broadcast();
  return currentStatus;
}

/**
 * 尽力删除目录：带重试与退避，失败不抛错。
 *
 * 为什么需要：删除 app bundle 时常见瞬时失败——
 *  - ENOTEMPTY：递归删除期间 Spotlight/mds 或 .DS_Store 又写入新文件
 *  - EBUSY：bundle 内文件仍被运行中的进程持有句柄
 * Node 的 fs.rm 内建 maxRetries 只覆盖部分场景，这里再套一层退避重试。
 *
 * @returns 是否删除成功（false = 仍残留，调用方需自行兜底）
 */
async function rmBest(target: string, attempts = 4): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      await fsp.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      if (!fs.existsSync(target)) return true;
    } catch { /* 退避后重试 */ }
    await new Promise((r) => setTimeout(r, 300 * (i + 1)));
  }
  return !fs.existsSync(target);
}

/**
 * 清理上次更新残留的备份 bundle（Sage.app.backup*）。
 *
 * 更新时旧 app 被改名成 .backup，但当时正在运行的进程仍持有其内部文件句柄，
 * 当场删除必然 ENOTEMPTY。下次启动时旧进程已退出、句柄释放，删除即可成功。
 * 用 detached 子进程延迟执行，不阻塞启动；并加护栏绝不动当前运行的 bundle。
 */
export function cleanupStaleBackups(): void {
  if (!app.isPackaged) return;
  try {
    const appBundle = path.resolve(process.execPath, '../../..');
    const dir = path.dirname(appBundle);
    const prefix = `${path.basename(appBundle)}.backup`;
    const stale = fs.readdirSync(dir).filter((n) => n.startsWith(prefix));
    if (stale.length === 0) return;
    const targets = stale
      .map((n) => path.join(dir, n))
      // 护栏：绝不删除包含当前可执行文件的 bundle
      .filter((p) => p !== appBundle && !process.execPath.startsWith(p + path.sep));
    if (targets.length === 0) return;
    setTimeout(() => {
      try {
        const child = spawn('/bin/rm', ['-rf', ...targets], { detached: true, stdio: 'ignore' });
        child.unref();
      } catch { /* ignore */ }
    }, 3000);
  } catch { /* ignore */ }
}

/**
 * 从 dmg 安装：挂载 → ditto 覆盖 → 卸载 → 清理隔离属性 → 重启。
 *
 * 安装位置 = 当前正在运行的 Sage.app 所在目录（通常是 /Applications，
 * 也可能是用户手动放的任意位置）。覆盖前先把旧版本改名备份，
 * 失败时回滚，成功时删除备份。
 */
async function installFromDmg(dmgPath: string): Promise<void> {
  // 当前 app bundle：execPath = .../Sage.app/Contents/MacOS/Sage
  const appBundle = path.resolve(process.execPath, '../../..');
  const installDir = path.dirname(appBundle);
  const appName = path.basename(appBundle); // Sage.app
  // 备份路径：默认 .backup；若该路径已被上次失败的更新残留占用且删不掉，
  // 改用带时间戳的唯一路径绕开（详见下方备份逻辑注释）。
  let backupPath = appBundle + '.backup';

  // 挂载（-nobrowse：不在 Finder 显示；-noautoopen：不自动打开）
  const { stdout } = await execFileP('hdiutil', ['attach', dmgPath, '-nobrowse', '-noautoopen'], {
    timeout: 60000,
  });
  // 输出最后一行形如 "/dev/disk4s1  Apple_APFS  /Volumes/Sage 0.5.99"
  const lines = stdout.trim().split('\n');
  let mountPoint = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const parts = lines[i].split('\t').filter(Boolean);
    const cand = parts[parts.length - 1];
    if (cand && cand.startsWith('/Volumes/')) { mountPoint = cand; break; }
  }
  if (!mountPoint) {
    throw new Error('无法解析 dmg 挂载点');
  }

  try {
    const srcApp = path.join(mountPoint, appName);
    if (!fs.existsSync(srcApp)) {
      throw new Error(`dmg 中未找到 ${appName}`);
    }

    // 备份旧版本。
    //
    // 关键：残留的 .backup 极可能删不掉——上一次更新把「正在运行的 app」改名成
    // .backup 后中途失败，那个进程仍持有 bundle 内文件句柄（ENOTEMPTY / EBUSY）。
    // 清理失败绝不能阻断本次更新，否则用户会永久卡在「更新失败」死循环里。
    // 兜底策略：换用唯一时间戳备份路径，把新 app 装到干净的 Sage.app 上。
    if (fs.existsSync(appBundle)) {
      if (fs.existsSync(backupPath)) {
        const cleaned = await rmBest(backupPath);
        if (!cleaned) {
          backupPath = `${appBundle}.backup-${Date.now()}`;
          console.warn(`[updater] 残留备份删除失败，改用临时备份路径：${backupPath}`);
        }
      }
      await fsp.rename(appBundle, backupPath);
    }

    try {
      // ditto 保留签名 / 资源分支，比 cp -R 更适合 app bundle
      await execFileP('ditto', [srcApp, appBundle], { timeout: 300000 });
    } catch (e: any) {
      // 覆盖失败 → 回滚
      await rmBest(appBundle);
      if (fs.existsSync(backupPath)) {
        await fsp.rename(backupPath, appBundle).catch(() => {});
      }
      throw new Error(
        `写入 ${installDir} 失败：${e?.message ?? e}\n` +
        `若提示权限不足，请确认对 ${installDir} 有写权限（或把 Sage.app 移到用户目录后重试）。`,
      );
    }

    // 成功 → 删除备份（删不掉也不影响：新版本已就位，残留留给下次启动清理）
    // + 清除下载引入的 quarantine 属性
    await rmBest(backupPath);
    await execFileP('xattr', ['-cr', appBundle], { timeout: 30000 }).catch(() => {});

    // 卸载
    await execFileP('hdiutil', ['detach', mountPoint, '-force'], { timeout: 30000 }).catch(() => {});

    // 重启进入新版本
    app.relaunch();
    app.exit(0);
  } catch (e) {
    // 任何失败都尽量卸载
    await execFileP('hdiutil', ['detach', mountPoint, '-force'], { timeout: 30000 }).catch(() => {});
    throw e;
  }
}

/**
 * 启动自动更新调度：启动 8 秒后静默检查一次，之后每 6 小时检查一次。
 * 仅当配置了 updateServerUrl 且开启 autoCheckUpdates 时才真正请求。
 */
export function startUpdater(getWindows: GetWindows, getTaskCount: () => number): void {
  taskCount = getTaskCount;
  windowsRef = getWindows;

  if (!app.isPackaged) return;

  const tick = async () => {
    try {
      const settings = await readSettings();
      const base = await effectiveUpdateUrl();
      if (base && (settings.autoCheckUpdates ?? true)) {
        void checkForUpdates(true);
      }
    } catch { /* ignore */ }
  };

  setTimeout(() => void tick(), 8000);
  setInterval(() => void tick(), 6 * 60 * 60 * 1000);
  setInterval(() => { if (downloading || currentStatus.phase === 'ready') void checkForUpdates(true); }, 60 * 1000);
}

/** 当前状态快照（IPC 初始化时渲染层拉取用）。 */
export function getUpdateStatus(): UpdateStatusPayload {
  return currentStatus;
}
