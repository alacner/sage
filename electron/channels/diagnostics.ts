/**
 * 渠道诊断事件总线（主进程）
 *
 * 两条出口：
 * - 内存环形缓冲（最近 N 条）→ IPC 给渲染层实时展示；
 * - 落盘 JSONL → 打包后的 .app 里没人看 stderr，「测试成功但没收到」这种问题
 *   往往要事后翻日志，所以必须留痕。
 *   渠道是项目级配置，日志也跟着项目走：`<project>/.sage/channels/logs/<type>-<key>.log`，
 *   一个渠道一个文件，A 项目的飞书渠道不会和 B 项目的混在同一份里；只有认不出归属的
 *   事件（全局校验、未知渠道）才落到全局 `~/Library/Logs/Sage/channels.log`。
 *   沿用 window-diagnostics 的做法：512KB 循环裁尾，任何 IO 失败都不影响主链路。
 *
 * 埋点原则：诊断日志是**旁路**，绝不允许因为记日志失败而让发消息失败；
 * 也不允许把 appSecret / tenant_access_token / webhook URL 写进来（一律过 sanitizeDiagDetail）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { rotateIfNeeded } from '../window-diagnostics';
import {
  channelDiagKey, sanitizeDiagDetail,
  type ChannelDiagEvent, type ChannelDiagReason, type ChannelDiagStage,
} from '../../shared/channel-diagnostics';

/** 内存里保留的最近条数（面板够用即可，全量历史在日志文件里）。 */
const RING = 300;
const MAX_LOG_BYTES = 512 * 1024;
/** 没有渠道归属可解析时用的兜底文件名。 */
const UNGROUPED_FILE = 'channels.log';

const ring: ChannelDiagEvent[] = [];
const listeners = new Set<(event: ChannelDiagEvent) => void>();

/**
 * channelKey → 项目路径。出站/凭证埋点只拿得到 config（插件签名里没有项目上下文），
 * 靠这张表把日志归到对应项目；由渠道加载与长连接同步时登记，缺项时全量扫一次兜底。
 */
const channelProjects = new Map<string, string>();
let scanTimer = 0;
let scanning = false;
let lastScanAt = 0;
/** 未登记渠道的兜底扫描节流：认不出归属时不能每条事件都去全量扫一遍项目。 */
const SCAN_COOLDOWN_MS = 5000;

function globalLogFile(): string {
  return path.join(app.getPath('logs'), UNGROUPED_FILE);
}

/** 文件名安全化：channelKey 形如 `feishu-app:82f7b672`，冒号在部分工具里不好处理。 */
function logFileName(channelKey: string): string {
  return `${channelKey.replace(/[^a-zA-Z0-9._-]/g, '-')}.log`;
}

/** 扫一遍所有项目的渠道，重建 channelKey → 项目 的映射（幂等，并发或冷却期内只跑一次）。 */
async function scanChannelProjects(force = false): Promise<void> {
  if (scanning) return;
  if (!force && Date.now() - lastScanAt < SCAN_COOLDOWN_MS) return;
  scanning = true;
  lastScanAt = Date.now();
  try {
    const { listProjects, listChannels } = await import('../store');
    for (const project of await listProjects()) {
      for (const channel of await listChannels(project.path)) {
        channelProjects.set(channelDiagKey(channel.type, channel.config), project.path);
      }
    }
  } catch { /* 扫不到就落全局，不影响埋点 */ } finally {
    scanning = false;
  }
}

/** 该渠道日志该写哪个项目：显式传入 > 登记表 > 现扫一次后再查 > 空（落全局）。 */
async function resolveProject(channelKey: string | undefined, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  if (!channelKey) return '';
  if (channelProjects.has(channelKey)) return channelProjects.get(channelKey)!;
  // 首次遇到未登记的渠道（例如进程刚起来就发消息）现扫一次；
  // 本次事件仍按未解析落全局，不为了等项目信息而阻塞写日志。
  await scanChannelProjects();
  return channelProjects.get(channelKey) ?? '';
}

/** 诊断日志文件路径（渲染层展示 / 复制用）。 */
export function channelDiagLogPath(scope?: { projectPath?: string; channelKey?: string }): string {
  if (!scope?.projectPath) return globalLogFile();
  const dir = path.join(scope.projectPath, '.sage', 'channels', 'logs');
  return path.join(dir, scope.channelKey ? logFileName(scope.channelKey) : 'all.log');
}

/** 登记渠道归属（渠道列表加载 / 长连接同步时调用），让出站埋点能落到正确项目。 */
export function registerChannelProjects(entries: Array<{ type: string; config: Record<string, string>; projectPath?: string }>): void {
  for (const e of entries) {
    if (!e.projectPath) continue;
    channelProjects.set(channelDiagKey(e.type, e.config), e.projectPath);
  }
  // 项目可能中途被删：定期重扫一次，映射表自己不会长歪
  if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = 0; void scanChannelProjects(true); }, 60000) as unknown as number;
}

/** 追加一条诊断事件。返回入缓冲的事件（含 ts），方便调用方直接回传。 */
export function recordChannelDiag(input: {
  stage: ChannelDiagStage;
  ok: boolean;
  reason: ChannelDiagReason;
  channelType?: string;
  /** 已知渠道配置时传进来，内部换算成 channelKey（不把原文写进日志） */
  config?: Record<string, string>;
  channelName?: string;
  /** 已知所属项目时传进来（长连接 / 入站链路都有），出站埋点缺省时靠映射表解析 */
  projectPath?: string;
  detail?: Record<string, unknown>;
  ts?: number;
}): ChannelDiagEvent {
  const event: ChannelDiagEvent = {
    ts: input.ts ?? Date.now(),
    stage: input.stage,
    ok: input.ok,
    reason: input.reason,
    channelType: input.channelType,
    channelKey: input.channelType ? (input.config ? channelDiagKey(input.channelType, input.config) : undefined) : undefined,
    channelName: input.channelName,
    projectPath: input.projectPath,
    detail: sanitizeDiagDetail(input.detail),
  };
  ring.push(event);
  if (ring.length > RING) ring.splice(0, ring.length - RING);
  void appendToFile(event);
  for (const l of listeners) {
    try { l(event); } catch { /* 订阅者异常不能影响主链路 */ }
  }
  return event;
}

/**
 * 落盘。项目归属要先查映射表（可能触发一次全量扫），所以是异步的；
 * 所有写入串成一条队列，避免两条事件同时读改写同一个文件互相覆盖。
 */
let appendQueue: Promise<void> = Promise.resolve();

function appendToFile(event: ChannelDiagEvent): Promise<void> {
  appendQueue = appendQueue.then(async () => {
    try {
      const projectPath = await resolveProject(event.channelKey, event.projectPath);
      const file = channelDiagLogPath({ projectPath, channelKey: event.channelKey });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let prev = '';
      try { prev = fs.readFileSync(file, 'utf8'); } catch { /* 首次 */ }
      const next = rotateIfNeeded(`${prev}${JSON.stringify(event)}\n`, MAX_LOG_BYTES);
      fs.writeFileSync(file, next, 'utf8');
    } catch { /* 日志失败不影响主链路 */ }
  });
  return appendQueue;
}

/** 等排队的落盘全部写完（测试断言与进程退出前用；埋点本身不阻塞）。 */
export function flushChannelDiagDisk(): Promise<void> {
  return appendQueue;
}

export function listChannelDiag(filter?: { channelKey?: string; projectPath?: string; since?: number }): ChannelDiagEvent[] {
  return ring.filter((e) => (!filter?.channelKey || e.channelKey === filter.channelKey)
    && (!filter?.projectPath || e.projectPath === filter.projectPath)
    && (!filter?.since || e.ts >= filter.since));
}

export function clearChannelDiag(): void {
  ring.length = 0;
}

/** 订阅新事件（ipc.ts 用来推给渲染层）。返回取消订阅函数。 */
export function subscribeChannelDiag(listener: (event: ChannelDiagEvent) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
