/**
 * macOS 原生语音输入：主进程维护 sage-voice 助手进程（系统 Speech 框架听写）生命周期。
 * 助手以 JSON 行协议写 stdout（partial/segment/status/error/end），主进程原样转发给
 * 发起渲染窗口的 VoiceEvent 通道；stdin 写 "stop" 或 SIGTERM 优雅停止。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';
import { app, type WebContents } from 'electron';
import { IpcChannels } from '../shared/types';

/**
 * 语音链路诊断日志：落盘到 ~/Library/Logs/Sage/voice.log（打包态无终端可看）。
 * 渲染层经 voice:diag 通道汇入，覆盖 getUserMedia / 权限 / spawn 全链路。
 */
export function diagVoice(msg: string): void {
  try {
    const file = path.join(app.getPath('logs'), 'voice.log');
    fs.appendFileSync(file, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* 日志失败不影响主链路 */ }
}

export interface VoiceEvent {
  t: 'partial' | 'segment' | 'status' | 'error' | 'end' | string;
  text?: string;
  message?: string;
  auth?: string;
  which?: 'mic' | 'speech' | string;
}

let child: ChildProcessWithoutNullStreams | null = null;
let owner: WebContents | null = null;
let ownerId = -1;
let stdoutBuf = '';
let endedSeen = false;

/**
 * 语音/权限探针助手路径。打包态优先用 Contents/MacOS/ 下的副本（afterSign 拷入）：
 * 只有那个位置能让子进程的 Bundle.main 解析出 sage.app，语音识别/通知的授权探测
 * 才是在问「Sage 自己有没有被授权」；放 Contents/Resources/ 下问的是匿名进程，永远 not-determined。
 * 开发态（仓库 resources/voice-helper）没有 bundle 身份，助手会返回 unknown，界面如实显示无法检测。
 */
export function helperPath(): string {
  const candidates = [
    path.join(path.dirname(process.execPath), 'sage-voice'),
    path.join(process.resourcesPath || '', 'voice-helper', 'sage-voice'),
    path.join(app.getAppPath(), 'resources', 'voice-helper', 'sage-voice'),
  ];
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* 尝试下一个候选路径 */ }
  }
  return candidates[0];
}

function sendToOwner(ev: VoiceEvent) {
  if (owner && !owner.isDestroyed()) owner.send(IpcChannels.VoiceEvent, ev);
}

export function startVoice(locale: string, sender: WebContents): { ok: boolean; error?: string } {
  if (child) { diagVoice(`startVoice rejected: busy`); return { ok: false, error: 'busy' }; }
  const bin = helperPath();
  if (!fs.existsSync(bin)) { diagVoice(`startVoice rejected: missing bin=${bin}`); return { ok: false, error: 'missing' }; }
  diagVoice(`startVoice: spawning bin=${bin} locale=${locale}`);
  // 麦克风采集在渲染进程 getUserMedia 进行（记在 Sage.app 名下），本进程只转发 PCM 与识别事件
  let proc: ChildProcessWithoutNullStreams;
  try {
    proc = spawn(bin, [locale], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    console.error('[voice] spawn threw:', err);
    return { ok: false, error: `spawn: ${(err as Error)?.message ?? err}` };
  }
  child = proc;
  owner = sender;
  ownerId = sender.id;
  stdoutBuf = '';
  endedSeen = false;
  // 助手退出后对 stdin 的写入会以异步 'error'（write EPIPE）上报，write() 的同步
  // try/catch 拦不住；流上没有 'error' 监听就会变成主进程未捕获异常直接崩。
  // 这里吞掉即可，退出清理由下方 'exit' 处理器负责。
  proc.stdin.on('error', () => { /* 管道已关闭 */ });
  // spawn 异步失败（EPERM/ENOENT 等）：必须清 child 并通知渲染层，
  // 否则 child 残留导致后续 voiceStart 永远 'busy'、界面静默无反应。
  proc.on('error', (err) => {
    console.error('[voice] helper spawn error:', err);
    diagVoice(`helper spawn error: ${err.message}`);
    if (child === proc) child = null;
    sendToOwner({ t: 'error', message: `helper spawn failed: ${err.message}` });
    sendToOwner({ t: 'end' });
    owner = null;
    ownerId = -1;
    stdoutBuf = '';
  });
  proc.stdout.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    if (stdoutBuf.length > 1024 * 1024) { failVoice('语音助手返回异常数据，请重试 / Voice helper output exceeded its limit'); return; }
    let idx = stdoutBuf.indexOf('\n');
    while (idx >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line) {
        try {
          const ev = JSON.parse(line) as VoiceEvent;
          if (ev.t === 'end') endedSeen = true;
          sendToOwner(ev);
        } catch { /* 非 JSON 行忽略 */ }
      }
      idx = stdoutBuf.indexOf('\n');
    }
  });
  // 助手 stderr 承载诊断日志（权限/音频引擎状态）与系统框架噪音，输出到主进程控制台便于排查
  proc.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trimEnd();
    if (text) console.error('[voice]', text);
  });
  proc.on('exit', (code) => {
    diagVoice(`helper exit code=${code ?? 'signal'} endedSeen=${endedSeen}`);
    if (child === proc) child = null;
    // 未发 end 就退出（崩溃/被杀）：补一条 error 让渲染层脱离录音态并提示
    if (!endedSeen) sendToOwner({ t: 'error', message: `voice helper exited (${code ?? 'signal'})` });
    sendToOwner({ t: 'end' });
    owner = null;
    ownerId = -1;
    stdoutBuf = '';
  });
  return { ok: true };
}

export function stopVoice(senderId?: number): { ok: boolean } {
  if (!child || (senderId !== undefined && senderId !== ownerId)) return { ok: false };
  try {
    if (!child.stdin.destroyed) child.stdin.write('stop\n');
  } catch { /* 进程已退出 */ }
  return { ok: true };
}

function failVoice(message:string) {
  if (!child) return;
  endedSeen = true; stdoutBuf = '';
  sendToOwner({t:'error', message});
  // A stalled recognizer must not retain an ever-growing stdin audio queue.
  child.stdin.destroy();
  try { child.kill('SIGKILL'); } catch { /* already exited */ }
}

/** 渲染进程采到的 PCM（base64）转发给助手 stdin。 */
export function feedVoiceAudio(b64: string, senderId?: number) {
  if (!child || (senderId !== undefined && senderId !== ownerId)) return;
  if (typeof b64 !== 'string' || b64.length > 128 * 1024 || child.stdin.writableLength > 512 * 1024) {
    failVoice('语音处理跟不上输入，已停止录音，请重试 / Voice input stalled; recording stopped. Please retry'); return;
  }
  try {
    if (!child.stdin.destroyed) child.stdin.write('a:' + b64 + '\n');
  } catch { /* 进程已退出 */ }
}

/** 窗口关闭时强停助手，避免麦克风被占用。 */
export function killVoiceForSender(senderId: number) {
  if (child && ownerId === senderId) {
    try {
      child.kill('SIGTERM');
    } catch { /* 已退出 */ }
  }
}

app.on('before-quit', () => {
  if (child) {
    try {
      child.kill('SIGTERM');
    } catch { /* 已退出 */ }
  }
});
