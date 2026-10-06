import { createMonitorBuffer, diagnosticSnapshot } from '../shared/monitor-memory';
/**
 * Request Monitor — cc-viewer 风格的请求录制器。
 *
 * 在桥接层统一录制所有发往模型的请求/响应：
 * - 主进程维护环形缓冲区（上限 MAX_RECORDS），实时广播到所有窗口；
 * - 按项目落盘 JSONL（<projectPath>/.sage/monitor/records.jsonl）；
 * - 录制前脱敏（图片 base64 占位、工具仅存名字、大字段截断）以控制内存/磁盘。
 *
 * 一次真实 HTTP 请求对应一条记录（agentic 循环里每次迭代各一条）。
 */

import type { BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { IpcChannels } from '../shared/types';
import type {
  MonitorRecord,
  MonitorRequest,
  MonitorResponse,
  MonitorRawRequest,
  MonitorRawResponse,
  MonitorEventPayload,
  MonitorSource,
  MonitorMode,
  MonitorStatus,
  UsageStats,
} from '../shared/types';
import { redactSettingsSecrets } from './settings-redaction';
import { monitorDir } from './store';
import { applyCachedModelCost } from './model-price-cache';

const MAX_RECORDS = 800;
const MAX_FIELD = 50_000; // 单个大字符串字段截断上限（字符）
const MAX_DISK_BYTES = 10 * 1024 * 1024; // 单文件轮转阈值

// 诊断缓冲按时间淘汰；数量和估算载荷字节数同时受限。
const records = createMonitorBuffer();

// 窗口注册表提供者（由 main.ts 注入），用于广播到所有窗口。
let windowsProvider: (() => Map<number, BrowserWindow>) | null = null;

export function setMonitorWindows(getWindows: () => Map<number, BrowserWindow>): void {
  windowsProvider = getWindows;
}

function broadcast(evt: MonitorEventPayload): void {
  evt = redactSettingsSecrets(evt);
  if (!windowsProvider) return;
  for (const w of windowsProvider().values()) {
    try {
      if (!w.isDestroyed() && !w.webContents.isDestroyed()) {
        w.webContents.send(IpcChannels.MonitorEvent, evt);
      }
    } catch {
      /* 窗口在守卫与发送之间被销毁——安全忽略 */
    }
  }
}

function newId(): string {
  return randomBytes(6).toString('base64url');
}

/** 截断超长字符串并标注。 */
function capString(s: string | undefined): string | undefined {
  if (typeof s !== 'string') return s;
  if (s.length <= MAX_FIELD) return s;
  return diagnosticSnapshot(s, MAX_FIELD);
}

/** Keep recent context for diagnostics; the real request stays untouched. */
function sanitizeRequest(req: MonitorRequest): MonitorRequest {
  return diagnosticSnapshot({...req, ...(Array.isArray(req.messages) ? {messages:req.messages.slice(-100)} : {})});
}
function sanitizeResponse(resp: MonitorResponse | undefined): MonitorResponse | undefined {
  return resp ? diagnosticSnapshot(resp, 80000) : undefined;
}

// ----------------------------- 磁盘持久化 -----------------------------

// 每个项目一条串行 append 队列，避免并发写入交错。
const writeQueues = new Map<string, Promise<void>>();
let pendingWrites = 0;
const MAX_PENDING_WRITES = 32;

function recordsFile(projectPath: string): string {
  return path.join(monitorDir(projectPath), 'records.jsonl');
}

function enqueueWrite(projectPath: string, record: MonitorRecord): void {
  // Diagnostics must not become an unbounded queue when storage is slow.
  if (pendingWrites >= MAX_PENDING_WRITES) return;
  pendingWrites++;
  const prev = writeQueues.get(projectPath) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const dir = monitorDir(projectPath);
      await fs.mkdir(dir, { recursive: true });
      const file = recordsFile(projectPath);
      // 轮转：文件过大时归档为 .1.jsonl
      try {
        if (existsSync(file) && statSync(file).size > MAX_DISK_BYTES) {
          await fs.rename(file, path.join(dir, 'records.1.jsonl'));
        }
      } catch {
        /* 轮转失败不阻塞写入 */
      }
      await fs.appendFile(file, JSON.stringify(redactSettingsSecrets(record)) + '\n', 'utf-8');
    })
    .catch(() => {
      /* 落盘失败不影响内存录制 */
    });
  writeQueues.set(projectPath, next);
  void next.finally(() => { pendingWrites--; if (writeQueues.get(projectPath) === next) writeQueues.delete(projectPath); });
}

// ----------------------------- 缓冲管理 -----------------------------

export interface BeginRecordInput {
  source: MonitorSource;
  mode: MonitorMode;
  purpose?: 'ai-review';
  engineId?: string;
  engineName?: string;
  projectPath?: string;
  convId?: string;
  messageId?: string;
  specId?: string;
  label?: string;
  model?: string;
  request: MonitorRequest;
}

export interface FinishPatch {
  response?: MonitorResponse;
  usage?: UsageStats;
  status?: MonitorStatus;
  error?: string;
  /** HTTP 原始数据（仅 API 直连模式捕获，body 已在捕获层截断）。 */
  rawRequest?: MonitorRawRequest;
  rawResponse?: MonitorRawResponse;
}

export interface MonitorHandle {
  id: string;
  finish(patch: FinishPatch): void;
  fail(error: string, extra?: Omit<FinishPatch, 'error' | 'status'>): void;
  abort(): void;
}

/** 开始一条记录，立即广播 pending 行，返回收尾句柄。 */
export function beginRecord(input: BeginRecordInput): MonitorHandle {
  const id = newId();
  const record: MonitorRecord = {
    id,
    ts: Date.now(),
    source: input.source,
    mode: input.mode,
    purpose: input.purpose,
    engineId: input.engineId,
    engineName: input.engineName,
    projectPath: input.projectPath,
    convId: input.convId,
    messageId: input.messageId,
    specId: input.specId,
    label: input.label,
    model: input.model ?? input.request.model,
    request: sanitizeRequest(input.request),
    status: 'pending',
  };
  records.set(id, record);
  broadcast({ kind: 'add', record });

  let settled = false;
  const settle = (patch: FinishPatch, status: MonitorStatus) => {
    if (settled) return;
    settled = true;
    const rec = records.get(id);
    if (!rec) return;
    rec.endTs = Date.now();
    rec.durationMs = rec.endTs - rec.ts;
    rec.status = patch.status ?? status;
    if (patch.response) rec.response = sanitizeResponse(patch.response);
    if (patch.usage) rec.usage = patch.usage;
    if (patch.error) rec.error = capString(patch.error);
    if (patch.rawRequest) rec.rawRequest = diagnosticSnapshot(patch.rawRequest, 60000);
    if (patch.rawResponse) rec.rawResponse = diagnosticSnapshot(patch.rawResponse, 60000);
    records.set(id, rec);
    broadcast({ kind: 'update', record: rec });
    if (rec.projectPath) enqueueWrite(rec.projectPath, rec);
  };

  return {
    id,
    finish: (patch) => settle(patch, 'success'),
    fail: (error, extra) => settle({ ...(extra ?? {}), error }, 'error'),
    abort: () => settle({}, 'aborted'),
  };
}

/** 返回缓冲区所有记录，最新在前。 */
export function listRecords(): MonitorRecord[] {
  return redactSettingsSecrets(Array.from(records.values()).sort((a,b) => b.ts - a.ts));
}

/** 清空缓冲（可按项目）并广播；按项目时同时清空该项目磁盘文件。 */
export function clearRecords(projectPath?: string): void {
  if (projectPath) {
    for (const [id, rec] of records) {
      if (rec.projectPath === projectPath) records.delete(id);
    }
    const prev = writeQueues.get(projectPath) ?? Promise.resolve();
    const next = prev
        .then(async () => {
          try {
            await fs.rm(recordsFile(projectPath), { force: true });
            await fs.rm(path.join(monitorDir(projectPath), 'records.1.jsonl'), { force: true });
          } catch {
            /* ignore */
          }
        })
        .catch(() => {});
    writeQueues.set(projectPath, next);
    void next.finally(() => { if (writeQueues.get(projectPath) === next) writeQueues.delete(projectPath); });
  } else {
    records.clear();
  }
  broadcast({ kind: 'clear', projectPath });
}

/** 读取某项目落盘 JSONL 的最新若干条（用于历史回看）。 */
export async function loadProjectRecords(projectPath: string, limit = 500): Promise<MonitorRecord[]> {
  const recent = createMonitorBuffer();
  const boundedLimit = Math.max(1, Math.min(MAX_RECORDS, Number.isFinite(limit) ? Math.floor(limit) : 500));
  for (const name of ['records.1.jsonl', 'records.jsonl']) {
    let handle;
    try {
      handle = await fs.open(path.join(monitorDir(projectPath), name), 'r');
      const {size} = await handle.stat();
      const offset = Math.max(0, size - MAX_DISK_BYTES);
      const buffer = Buffer.alloc(Math.min(size, MAX_DISK_BYTES));
      const {bytesRead} = await handle.read(buffer, 0, buffer.length, offset);
      let raw = buffer.toString('utf8', 0, bytesRead);
      if (offset) raw = raw.slice(raw.indexOf('\n') + 1);
      for (const line of raw.split('\n')) {
        if (!line.trim() || line.length > 1024 * 1024) continue;
        try {
          const record = diagnosticSnapshot(JSON.parse(line)) as MonitorRecord;
          if (record.id && record.request) recent.set(record.id, record);
          while (recent.size > boundedLimit) recent.delete(recent.keys().next().value!);
        } catch { /* malformed diagnostic row */ }
      }
    } catch { /* history is optional */ }
    finally { await handle?.close(); }
  }
  return redactSettingsSecrets([...recent.values()].reverse());
}

/** Rewrite persisted monitor history after a new model-price snapshot arrives. */
export async function repriceProjectRecords(projectPath: string): Promise<void> {
  for (const name of ['records.1.jsonl', 'records.jsonl']) {
    const file = path.join(monitorDir(projectPath), name);
    let raw: string; try { if ((await fs.stat(file)).size > MAX_DISK_BYTES + 1024 * 1024) continue; raw = await fs.readFile(file, 'utf8'); } catch { continue; }
    const rows = raw.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) as MonitorRecord; } catch { return undefined; } }).filter(Boolean) as MonitorRecord[];
    let changed = false;
    for (const row of rows) if (row.usage && (row.usage.costUsd === 0 || row.usage.estimatedCost) && row.model) { applyCachedModelCost(row.model, row.usage); changed = true; }
    if (changed) await fs.writeFile(file, rows.map(row => JSON.stringify(redactSettingsSecrets(row))).join('\n') + '\n', 'utf8');
  }
  for (const row of records.values()) if (row.projectPath === projectPath && row.usage && (row.usage.costUsd === 0 || row.usage.estimatedCost) && row.model) { applyCachedModelCost(row.model, row.usage); broadcast({kind:'update', record:row}); }
}
