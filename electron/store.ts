import { conversationReadState } from './conversation-read-state';
import { isProjectIconId } from '../shared/project-icons';
import {isScheduledExecution,scheduledExecutionIds} from '../shared/scheduled-execution';
import {cleanupHistory,readDataRetention} from './data-retention';
import { app } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync, renameSync } from 'node:fs';
import { chatDirectory } from './chat-directory';
import type { ProjectEntry, SpecMeta, ConversationMeta, SteeringDocs, SpecChatMessage, ScheduledTask, ScheduledRun, ChannelConfig, ProjectStats, GlobalStats, UsageStats } from '../shared/types';

/** 项目数据目录名（存放 specs / chats / steering / wiki 等）。 */
export const PROJECT_DIR = '.sage';
/** 旧版目录名，用于自动迁移历史数据（原 claude-gui 项目）。 */
const LEGACY_PROJECT_DIR = '.claude-gui';

// 已完成迁移检查的项目路径，避免重复的 fs 调用。
const migratedProjects = new Set<string>();

/**
 * 返回 <projectPath>/.sage，并在首次访问时把历史旧版目录迁移过来。
 * 迁移是幂等的：仅当旧目录存在且新目录不存在时才重命名。
 */
function projectDir(projectPath: string): string {
  const dir = path.join(projectPath, PROJECT_DIR);
  if (!migratedProjects.has(projectPath)) {
    migratedProjects.add(projectPath);
    try {
      const legacy = path.join(projectPath, LEGACY_PROJECT_DIR);
      if (existsSync(legacy) && !existsSync(dir)) {
        renameSync(legacy, dir);
      }
    } catch {
      /* 迁移失败不阻塞正常读写 */
    }
  }
  return dir;
}

function projectsFile() {
  return path.join(app.getPath('userData'), 'projects.json');
}

/** 请求监控日志目录：<projectPath>/.sage/monitor（迁移感知）。 */
export function monitorDir(projectPath: string): string {
  return path.join(projectDir(projectPath), 'monitor');
}

async function readJson<T>(p: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(p, 'utf-8');
    const parsed = JSON.parse(raw);
    if (p === projectsFile() && (!Array.isArray(parsed) || parsed.some((entry: any) => !entry || typeof entry.path !== 'string'))) throw new Error('项目配置格式损坏');
    return parsed as T;
  } catch (e: any) {
    // Missing is a first run; corruption/permission failure must not become an empty project list.
    if (p === projectsFile() && e.code !== 'ENOENT') throw new Error('项目配置不可读，已拒绝覆盖');
    return fallback;
  }
}

/**
 * 原子写入 JSON 文件：先写临时文件，验证后再重命名。
 * 避免写入过程中应用崩溃导致目标文件损坏。
 */
async function writeJson(p: string, data: unknown, beforeCommit?: () => Promise<void>) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const jsonStr = JSON.stringify(data, null, 2);
  const tmpPath = `${p}.${randomUUID()}.tmp`;
  
  try {
    // 1. 写入临时文件
    const handle = await fs.open(tmpPath, 'wx', 0o600);
    try { await handle.writeFile(jsonStr, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    
    // 2. 验证写入完整性：读回并解析 JSON
    const verifyContent = await fs.readFile(tmpPath, 'utf-8');
    JSON.parse(verifyContent); // 确保写入的是有效 JSON
    
    // 3. 验证文件大小一致（防止截断）
    const stat = await fs.stat(tmpPath);
    if (stat.size !== Buffer.byteLength(jsonStr, 'utf-8')) {
      throw new Error(`Write verification failed: size mismatch`);
    }
    
    if (p === projectsFile()) {
      try {
        const old = JSON.parse(await fs.readFile(p, 'utf8'));
        await writeJson(path.join(`${p}.history`, `${Date.now()}-${randomUUID()}.json`), old);
      } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    }
    // Optional mobile-open authorization is checked after temporary IO, at the commit boundary.
    if (beforeCommit) await beforeCommit();
    // 4. 原子重命名和目录同步
    await fs.rename(tmpPath, p);
    const dir = await fs.open(path.dirname(p), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
    if(p===projectsFile()) {
      try {const retention=readDataRetention(app.getPath('userData'));await cleanupHistory(`${p}.history`,retention.projectsHistoryDays,retention.projectsHistoryCount,value=>Array.isArray(value)&&value.every(entry=>entry&&typeof entry.path==='string'));}
      catch(error) {console.warn('[project-history] cleanup failed',error);}
    }
  } catch (err) {
    // 清理临时文件
    try {
      await fs.unlink(tmpPath);
    } catch {
      // 忽略清理错误
    }
    throw err;
  }
}

let projectWrites: Promise<unknown> = Promise.resolve();
function projectTransaction<T>(operation: () => Promise<T>): Promise<T> {
  const result = projectWrites.then(operation);
  projectWrites = result.catch(() => {});
  return result;
}

export async function listProjects(): Promise<ProjectEntry[]> {
  const arr = await readJson<ProjectEntry[]>(projectsFile(), []);
  // Drop projects whose folder no longer exists.
  return arr.filter((p) => existsSync(p.path)).sort((a, b) => (a.lastOpenedAt < b.lastOpenedAt ? 1 : -1));
}

/** Read receipt files are small; only unread entries require checking archive metadata. */
export async function projectHasUnread(projectPath: string): Promise<boolean> {
  let entries;
  try { entries = await fs.readdir(convRoot(projectPath), { withFileTypes: true }); }
  catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = convDir(projectPath, entry.name);
    if (!(await conversationReadState(directory)).unread) continue;
    const meta = await loadConv(projectPath, entry.name);
    if (meta && !meta.archived && !meta.scheduledExecution) return true;
  }
  return false;
}
export async function listProjectsWithActivity(): Promise<ProjectEntry[]> {
  return Promise.all((await listProjects()).map(async project => ({ ...project, unread: await projectHasUnread(project.path) })));
}
/** Reminder scans read small receipts first; read conversations never load their history. */
export async function listUnreadConvsForProject(projectPath: string): Promise<ConversationMeta[]> {
  let entries;
  try { entries = await fs.readdir(convRoot(projectPath), { withFileTypes: true }); }
  catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
  const legacyIds = scheduledExecutionIds(await listScheduledTasks(projectPath), await listScheduledRuns(projectPath));
  const results: ConversationMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !(await conversationReadState(convDir(projectPath, entry.name))).unread) continue;
    const meta = await loadConv(projectPath, entry.name);
    if (meta && !meta.archived && !isScheduledExecution(meta, legacyIds) && meta.unread) results.push(meta);
  }
  return results;
}
export async function setProjectIcon(projectPath: string, icon?: string): Promise<ProjectEntry> {
  if (icon !== undefined && !isProjectIconId(icon)) throw Error('Invalid project icon');
  return projectTransaction(async () => {
    const list = await readJson<ProjectEntry[]>(projectsFile(), []);
    const project = list.find(entry => entry.path === projectPath);
    if (!project) throw Error('Project not found');
    if (icon && icon !== 'folder') project.icon = icon; else delete project.icon;
    await writeJson(projectsFile(), list);
    return { ...project, unread: await projectHasUnread(projectPath) };
  });
}

export async function addProject(p: string, beforeCommit?: () => Promise<void>): Promise<ProjectEntry> {
  return projectTransaction(async () => {
  const list = await readJson<ProjectEntry[]>(projectsFile(), []);
  // Run inside the registry queue so an old authorized choice cannot survive a delayed write.
  if (beforeCommit) await beforeCommit();
  const name = path.basename(p) || p;
  const now = new Date().toISOString();
  const existing = list.find((x) => x.path === p);
  if (existing) {
    existing.lastOpenedAt = now;
    existing.name = name;
  } else {
    list.push({ path: p, name, lastOpenedAt: now });
  }
  await writeJson(projectsFile(), list, beforeCommit);
  return list.find((x) => x.path === p)!;
  });
}

/**
 * Update lastOpenedAt for an existing project without adding a new entry.
 * Called by renderer's selectProject to track the most-recently-used project
 * for Dock-activate restoration.
 */
/**
 * 设置项目级启用的插件列表（持久化到 projects.json）。
 */
export async function setProjectEnabledPlugins(
  projectPath: string,
  enabledPlugins: string[],
): Promise<ProjectEntry | null> {
  return projectTransaction(async () => {
  if (!projectPath || typeof projectPath !== 'string') return null;
  const list = await readJson<ProjectEntry[]>(projectsFile(), []);
  const idx = list.findIndex((p) => p.path === projectPath);
  if (idx < 0) return null;

  const entry = list[idx];
  const updated: ProjectEntry = { ...entry };
  if (enabledPlugins.length === 0) {
    delete updated.enabledPlugins;
  } else {
    updated.enabledPlugins = [...enabledPlugins];
  }

  await writeJson(projectsFile(), list.map((p, i) => (i === idx ? updated : p)));
  return updated;
  });
}

export async function touchProject(p: string): Promise<void> {
  return projectTransaction(async () => {
  const list = await readJson<ProjectEntry[]>(projectsFile(), []);
  const existing = list.find((x) => x.path === p);
  if (existing) {
    existing.lastOpenedAt = new Date().toISOString();
    await writeJson(projectsFile(), list);
  }
  });
}

export async function removeProject(p: string, purgeData = false): Promise<void> {
  return projectTransaction(async () => {
  const list = await readJson<ProjectEntry[]>(projectsFile(), []);
  await writeJson(
    projectsFile(),
    list.filter((x) => x.path !== p),
  );
  if (purgeData) {
    for (const name of [PROJECT_DIR, LEGACY_PROJECT_DIR]) {
      const dir = path.join(p, name);
      if (existsSync(dir)) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  }
  });
}

/**
 * 设置项目级主模型档案 id。传入 undefined 表示跟随全局默认。
 */
export async function setProjectModel(p: string, modelProfileId?: string): Promise<void> {
  return projectTransaction(async () => {
  const list = await readJson<ProjectEntry[]>(projectsFile(), []);
  const existing = list.find((x) => x.path === p);
  if (!existing) return;
  if (modelProfileId) existing.modelProfileId = modelProfileId;
  else delete existing.modelProfileId;
  await writeJson(projectsFile(), list);
  });
}

/**
 * 设置项目级选中的模型（新架构）。传入 null/undefined 表示跟随全局默认。
 */
export async function setProjectSelectedModel(
  p: string,
  selected: import("../shared/types").SelectedModel | null | undefined,
): Promise<void> {
  return projectTransaction(async () => {
  const list = await readJson<ProjectEntry[]>(projectsFile(), []);
  const existing = list.find((x) => x.path === p);
  if (!existing) return;
  if (selected?.followDefault || (selected?.providerId && selected?.modelId)) {
    existing.selectedModel = { providerId: selected.providerId, modelId: selected.modelId, thinkingEffort: selected.thinkingEffort, followDefault: selected.followDefault };
  } else {
    delete existing.selectedModel;
  }
  await writeJson(projectsFile(), list);
  });
}

/**
 * 设置项目级选中的视觉模型（新架构）。传入 null/undefined 表示跟随全局默认视觉模型。
 */
export async function setProjectSelectedVisionModel(
  p: string,
  selected: import("../shared/types").SelectedModel | null | undefined,
): Promise<void> {
  return projectTransaction(async () => {
  const list = await readJson<ProjectEntry[]>(projectsFile(), []);
  const existing = list.find((x) => x.path === p);
  if (!existing) return;
  if (selected?.followDefault || (selected?.providerId && selected?.modelId)) {
    existing.selectedVisionModel = { providerId: selected.providerId, modelId: selected.modelId, thinkingEffort: selected.thinkingEffort, followDefault: selected.followDefault };
  } else {
    delete existing.selectedVisionModel;
  }
  await writeJson(projectsFile(), list);
  });
}

/** 设置项目级沙箱策略覆盖项（每个项目独立配置）。 */
export async function setProjectSandboxOverrides(
  p: string,
  overrides: ProjectEntry['sandboxOverrides'],
): Promise<void> {
  return projectTransaction(async () => {
  const list = await readJson<ProjectEntry[]>(projectsFile(), []);
  const existing = list.find((x) => x.path === p);
  if (!existing) return;
  if (overrides) {
    existing.sandboxOverrides = overrides;
  } else {
    delete existing.sandboxOverrides;
  }
  await writeJson(projectsFile(), list);
  });
}

// ---------- spec storage ----------

export function specRoot(projectPath: string): string {
  return path.join(projectDir(projectPath), 'specs');
}

export function specDir(projectPath: string, specId: string): string {
  return path.join(specRoot(projectPath), specId);
}

export function specMetaFile(projectPath: string, specId: string): string {
  return path.join(specDir(projectPath, specId), 'meta.json');
}

export function specDocPath(projectPath: string, specId: string, phase: 'requirements' | 'design' | 'tasks'): string {
  return path.join(specDir(projectPath, specId), `${phase}.md`);
}

export async function saveSpecMeta(meta: SpecMeta): Promise<void> {
  const dir = specDir(meta.projectPath, meta.id);
  await fs.mkdir(dir, { recursive: true });
  await writeJson(specMetaFile(meta.projectPath, meta.id), meta);
}

export async function loadSpecMeta(projectPath: string, specId: string): Promise<SpecMeta | null> {
  try {
    const raw = await fs.readFile(specMetaFile(projectPath, specId), 'utf-8');
    return JSON.parse(raw) as SpecMeta;
  } catch {
    return null;
  }
}

export async function listSpecsForProject(projectPath: string): Promise<SpecMeta[]> {
  const root = specRoot(projectPath);
  if (!existsSync(root)) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const specs: SpecMeta[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const meta = await loadSpecMeta(projectPath, e.name);
    if (meta) specs.push(meta);
  }
  return specs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function readDoc(
  projectPath: string,
  specId: string,
  phase: 'requirements' | 'design' | 'tasks',
): Promise<string | undefined> {
  try {
    return await fs.readFile(specDocPath(projectPath, specId, phase), 'utf-8');
  } catch {
    return undefined;
  }
}

export async function writeDoc(
  projectPath: string,
  specId: string,
  phase: 'requirements' | 'design' | 'tasks',
  content: string,
): Promise<void> {
  const dir = specDir(projectPath, specId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(specDocPath(projectPath, specId, phase), content, 'utf-8');
}

/** 阶段附属对话线程文件路径：<specDir>/chat-<phase>.json。 */
export function specChatPath(
  projectPath: string,
  specId: string,
  phase: 'requirements' | 'design' | 'tasks',
): string {
  return path.join(specDir(projectPath, specId), `chat-${phase}.json`);
}

export async function readPhaseChat(
  projectPath: string,
  specId: string,
  phase: 'requirements' | 'design' | 'tasks',
): Promise<SpecChatMessage[]> {
  try {
    const raw = await fs.readFile(specChatPath(projectPath, specId, phase), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SpecChatMessage[]) : [];
  } catch {
    return [];
  }
}

export async function writePhaseChat(
  projectPath: string,
  specId: string,
  phase: 'requirements' | 'design' | 'tasks',
  messages: SpecChatMessage[],
): Promise<void> {
  const dir = specDir(projectPath, specId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(specChatPath(projectPath, specId, phase), JSON.stringify(messages, null, 2), 'utf-8');
}

// Index of all specs across projects (for global search if needed).
export async function findSpecById(specId: string): Promise<SpecMeta | null> {
  const projects = await listProjects();
  for (const proj of projects) {
    const m = await loadSpecMeta(proj.path, specId);
    if (m) return m;
  }
  return null;
}

export async function deleteSpec(meta: SpecMeta): Promise<void> {
  const dir = specDir(meta.projectPath, meta.id);
  await fs.rm(dir, { recursive: true, force: true });
}

// ---------- steering documents (SDD project-level context) ----------

export type SteeringKind = 'product' | 'tech' | 'structure';

function steeringDir(projectPath: string): string {
  return path.join(projectDir(projectPath), 'steering');
}

function steeringPath(projectPath: string, kind: SteeringKind): string {
  return path.join(steeringDir(projectPath), `${kind}.md`);
}

export async function readSteering(projectPath: string): Promise<SteeringDocs> {
  const out: SteeringDocs = {};
  for (const kind of ['product', 'tech', 'structure'] as const) {
    try {
      out[kind] = await fs.readFile(steeringPath(projectPath, kind), 'utf-8');
    } catch {
      // Missing file is fine — that steering doc just isn't set.
    }
  }
  return out;
}

export async function writeSteering(
  projectPath: string,
  kind: SteeringKind,
  content: string,
): Promise<void> {
  if (content.trim()) {
    await fs.mkdir(steeringDir(projectPath), { recursive: true });
    await fs.writeFile(steeringPath(projectPath, kind), content, 'utf-8');
  } else {
    // Empty content = delete the steering file so renderSteering skips it.
    try {
      await fs.unlink(steeringPath(projectPath, kind));
    } catch {
      // Already absent — nothing to do.
    }
  }
}

// ---------- conversation storage ----------

export function convRoot(projectPath: string): string {
  return chatDirectory(projectDir(projectPath));
}

function convDir(projectPath: string, id: string): string {
  return path.join(convRoot(projectPath), id);
}

function convFile(projectPath: string, id: string): string {
  return path.join(convDir(projectPath, id), 'meta.json');
}

/**
 * 规范化从磁盘读出的 ConversationMeta，兼容历史/损坏格式：
 * - messages 缺失或非数组 → 置为空数组
 * - 单条 message.content 为数组/对象 → 拼接为字符串
 * - ts/timestamp 为数字 → 转为 ISO 字符串
 * - 其他字段尽量保留
 */
function normalizeConv(raw: any): ConversationMeta {
  const meta: ConversationMeta = { ...raw };
  if (!Array.isArray(meta.messages)) {
    meta.messages = [];
  }
  meta.messages = meta.messages.map((m: any) => {
    const msg = { ...m };
    // content 必须归一化为字符串
    if (typeof msg.content !== 'string') {
      if (Array.isArray(msg.content)) {
        msg.content = msg.content
          .map((part: any) => {
            if (typeof part === 'string') return part;
            if (part && typeof part.text === 'string') return part.text;
            if (part && typeof part.content === 'string') return part.content;
            return '';
          })
          .join('');
      } else if (msg.content && typeof msg.content === 'object') {
        msg.content = typeof msg.content.text === 'string'
          ? msg.content.text
          : JSON.stringify(msg.content);
      } else {
        msg.content = String(msg.content ?? '');
      }
    }
    // ts 必须是 ISO 字符串
    if (typeof msg.ts === 'number') {
      msg.ts = new Date(msg.ts).toISOString();
    } else if (typeof msg.ts !== 'string') {
      msg.ts = new Date().toISOString();
    }
    // 兼容旧字段 timestamp → ts
    if (msg.timestamp && !msg.ts) {
      const tsNum = typeof msg.timestamp === 'string' ? Date.parse(msg.timestamp) : Number(msg.timestamp);
      msg.ts = Number.isFinite(tsNum) ? new Date(tsNum).toISOString() : new Date().toISOString();
      delete msg.timestamp;
    }
    // 清理旧 status 字段
    delete msg.status;
    // 运行不跨进程重启：加载时统一清除因中断持久化下来的 pending/retryInfo，
    // 避免「既不在执行、又因 pending 隐藏删除按钮」的僵尸消息
    if (msg.pending) {
      msg.pending = false;
      delete msg.retryInfo;
    }
    return msg;
  });
  // Context compaction audits were added after conversations already existed.
  // Keep malformed/oversized legacy values from breaking the conversation
  // view, while preserving the newest 100 valid records.
  if (Array.isArray(meta.contextCompactionAudits)) {
    meta.contextCompactionAudits = meta.contextCompactionAudits
      .filter((audit: any) => audit && typeof audit.id === 'string' && typeof audit.at === 'string')
      .slice(-100);
  } else {
    delete meta.contextCompactionAudits;
  }
  // 确保顶层时间字段为字符串
  if (typeof meta.createdAt === 'number') meta.createdAt = new Date(meta.createdAt).toISOString();
  if (typeof meta.updatedAt === 'number') meta.updatedAt = new Date(meta.updatedAt).toISOString();
  if (!meta.createdAt) meta.createdAt = new Date().toISOString();
  if (!meta.updatedAt) meta.updatedAt = meta.createdAt;
  // 确保 projectPath 是字符串（兜底历史数据）
  if (typeof meta.projectPath !== 'string') {
    console.warn('[normalizeConv] meta.projectPath is not a string, got:', typeof meta.projectPath, meta.projectPath);
  }
  return meta;
}

export async function saveConv(meta: ConversationMeta): Promise<void> {
  await fs.mkdir(convDir(meta.projectPath, meta.id), { recursive: true });
  const { unread, activityRevision, readRevision, lastReplyId, ...history } = meta;
  await writeJson(convFile(meta.projectPath, meta.id), history);
}

export async function loadConv(projectPath: string, id: string): Promise<ConversationMeta | null> {
  const file = convFile(projectPath, id);
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw);
    // The file location owns this record; persisted absolute paths become stale
    // after the registered project directory is moved. Never infer by basename.
    const meta = normalizeConv({ ...parsed, projectPath, id });
    try { return { ...meta, ...await conversationReadState(convDir(projectPath, id)) }; }
    catch (error) { console.error('[read-receipt] Cannot load conversation receipt', error); return meta; }
  } catch {
    return null;
  }
}

export async function listConvsForProject(projectPath: string): Promise<ConversationMeta[]> {
  const root = convRoot(projectPath);
  if (!existsSync(root)) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const legacyIds=scheduledExecutionIds(await listScheduledTasks(projectPath),await listScheduledRuns(projectPath));
  const out: ConversationMeta[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = await loadConv(projectPath, e.name);
    if (m&&!isScheduledExecution(m,legacyIds)) out.push(m);
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** 设置对话归档态：归档对话不在左栏清单显示，可在设置页恢复 */
export async function setConvArchived(
  projectPath: string,
  id: string,
  archived: boolean,
): Promise<boolean> {
  const meta = await loadConv(projectPath, id);
  if (!meta) return false;
  meta.archived = archived;
  await saveConv(meta);
  return true;
}

/** 对话搜索命中：标记关键词命中的层（标题/内容/记忆） */
export interface ConvSearchHit {
  id: string;
  inTitle: boolean;
  inContent: boolean;
  inMemory: boolean;
}

/** 项目内对话全文搜索（标题 / 消息内容 / 对话记忆），大小写不敏感 */
export async function searchConvs(
  projectPath: string,
  query: string,
): Promise<ConvSearchHit[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const convs = await listConvsForProject(projectPath);
  const hits: ConvSearchHit[] = [];
  for (const c of convs) {
    const inTitle = (c.title || '').toLowerCase().includes(q);
    const inContent = (c.messages ?? []).some(
      (m) => typeof m.content === 'string' && m.content.toLowerCase().includes(q),
    );
    let inMemory = false;
    try {
      const raw = await fs.readFile(path.join(convDir(projectPath, c.id), 'memory.json'), 'utf-8');
      const store = JSON.parse(raw) as { entries?: Array<{ content?: string; tags?: string[] }> };
      inMemory = (store.entries ?? []).some((e) =>
        `${e.content ?? ''} ${(e.tags ?? []).join(' ')}`.toLowerCase().includes(q),
      );
    } catch {
      /* 无记忆文件：跳过记忆层 */
    }
    if (inTitle || inContent || inMemory) hits.push({ id: c.id, inTitle, inContent, inMemory });
  }
  return hits;
}

export async function findConvById(id: string): Promise<ConversationMeta | null> {
  const projects = await listProjects();
  for (const p of projects) {
    const m = await loadConv(p.path, id);
    if (m) return m;
  }
  return null;
}

export async function deleteConv(meta: ConversationMeta): Promise<void> {
  const dir = convDir(meta.projectPath, meta.id);
  console.log('[deleteConv] deleting directory:', dir);
  try {
    await fs.rm(dir, { recursive: true, force: true });
    console.log('[deleteConv] success');
  } catch (err) {
    console.error('[deleteConv] error:', err);
    throw err;
  }
}

// ---------- project wiki (AI-generated documentation) ----------

function wikiPath(projectPath: string): string {
  return path.join(projectDir(projectPath), 'wiki.md');
}

// ---------- project stats (persistent accumulated statistics) ----------

function statsFile(projectPath: string): string {
  return path.join(projectDir(projectPath), 'stats.json');
}

const EMPTY_STATS: ProjectStats = {
  historicalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
  totalConversationsCreated: 0,
  totalSpecsCreated: 0,
};

export async function readProjectStats(projectPath: string): Promise<ProjectStats> {
  const raw = await readJson<ProjectStats>(statsFile(projectPath), EMPTY_STATS);
  // Defensive: ensure all fields exist (backward-compat with older files)
  return {
    historicalUsage: {
      inputTokens: raw.historicalUsage?.inputTokens ?? 0,
      outputTokens: raw.historicalUsage?.outputTokens ?? 0,
      cacheReadTokens: raw.historicalUsage?.cacheReadTokens ?? 0,
      cacheCreationTokens: raw.historicalUsage?.cacheCreationTokens ?? 0,
      costUsd: raw.historicalUsage?.costUsd ?? 0,
    },
    totalConversationsCreated: raw.totalConversationsCreated ?? 0,
    totalSpecsCreated: raw.totalSpecsCreated ?? 0,
  };
}

export async function writeProjectStats(projectPath: string, stats: ProjectStats): Promise<void> {
  await writeJson(statsFile(projectPath), stats);
}

/**
 * 把一段 usage 累加到项目历史统计（删除对话时调用）。
 */
export async function addUsageToProjectStats(projectPath: string, usage: UsageStats): Promise<ProjectStats> {
  const stats = await readProjectStats(projectPath);
  stats.historicalUsage.inputTokens += usage.inputTokens;
  stats.historicalUsage.outputTokens += usage.outputTokens;
  stats.historicalUsage.cacheReadTokens += usage.cacheReadTokens;
  stats.historicalUsage.cacheCreationTokens += usage.cacheCreationTokens;
  stats.historicalUsage.costUsd += usage.costUsd;
  await writeProjectStats(projectPath, stats);
  return stats;
}

/**
 * 增加对话/Spec 创建计数。
 */
export async function incrProjectStatsCounter(
  projectPath: string,
  kind: 'conversations' | 'specs',
): Promise<ProjectStats> {
  const stats = await readProjectStats(projectPath);
  if (kind === 'conversations') stats.totalConversationsCreated += 1;
  else stats.totalSpecsCreated += 1;
  await writeProjectStats(projectPath, stats);
  return stats;
}

// ---------- global stats (aggregated across all projects) ----------

function globalStatsFile(): string {
  return path.join(app.getPath('userData'), 'global-stats.json');
}

const EMPTY_GLOBAL_STATS: GlobalStats = {
  historicalUsage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  },
  totalConversationsCreated: 0,
  totalSpecsCreated: 0,
};

export async function readGlobalStats(): Promise<GlobalStats> {
  const raw = await readJson<GlobalStats>(globalStatsFile(), EMPTY_GLOBAL_STATS);
  return {
    historicalUsage: {
      inputTokens: raw.historicalUsage?.inputTokens ?? 0,
      outputTokens: raw.historicalUsage?.outputTokens ?? 0,
      cacheReadTokens: raw.historicalUsage?.cacheReadTokens ?? 0,
      cacheCreationTokens: raw.historicalUsage?.cacheCreationTokens ?? 0,
      costUsd: raw.historicalUsage?.costUsd ?? 0,
    },
    totalConversationsCreated: raw.totalConversationsCreated ?? 0,
    totalSpecsCreated: raw.totalSpecsCreated ?? 0,
  };
}

export async function writeGlobalStats(stats: GlobalStats): Promise<void> {
  await writeJson(globalStatsFile(), stats);
}

/**
 * 把一段 usage 累加到全局历史统计（删除对话时调用）。
 */
export async function addUsageToGlobalStats(usage: UsageStats): Promise<GlobalStats> {
  const stats = await readGlobalStats();
  stats.historicalUsage.inputTokens += usage.inputTokens;
  stats.historicalUsage.outputTokens += usage.outputTokens;
  stats.historicalUsage.cacheReadTokens += usage.cacheReadTokens;
  stats.historicalUsage.cacheCreationTokens += usage.cacheCreationTokens;
  stats.historicalUsage.costUsd += usage.costUsd;
  await writeGlobalStats(stats);
  return stats;
}

export async function readWiki(projectPath: string): Promise<string | null> {
  try {
    return await fs.readFile(wikiPath(projectPath), 'utf-8');
  } catch {
    return null;
  }
}

export async function writeWiki(projectPath: string, content: string): Promise<void> {
  await fs.mkdir(projectDir(projectPath), { recursive: true });
  await fs.writeFile(wikiPath(projectPath), content, 'utf-8');
}

export async function deleteWiki(projectPath: string): Promise<void> {
  try {
    await fs.unlink(wikiPath(projectPath));
  } catch {
    // Already absent
  }
}

// ---------- scheduled tasks storage ----------

function scheduledDir(projectPath: string): string {
  return path.join(projectDir(projectPath), 'scheduled');
}

function scheduledTasksFile(projectPath: string): string {
  return path.join(scheduledDir(projectPath), 'tasks.json');
}

function scheduledRunsDir(projectPath: string): string {
  return path.join(scheduledDir(projectPath), 'runs');
}

function scheduledRunsFile(projectPath: string, runId: string): string {
  return path.join(scheduledRunsDir(projectPath), `${runId}.json`);
}

export async function listScheduledTasks(projectPath: string): Promise<ScheduledTask[]> {
  try {
    const raw = await fs.readFile(scheduledTasksFile(projectPath), 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as ScheduledTask[]).map(task => ({
      ...task,
      projectPath,
      // Preserve the original ceiling when relocating a legacy inherited grant.
      // Re-saving the task is the explicit action that can capture a new root.
      ...(task.authorization && !task.authorization.projectPath && task.projectPath !== projectPath
        ? { authorization: { ...task.authorization, projectPath: task.projectPath } } : {}),
    })) : [];
  } catch {
    return [];
  }
}

export async function saveScheduledTasks(projectPath: string, tasks: ScheduledTask[]): Promise<void> {
  await fs.mkdir(scheduledDir(projectPath), { recursive: true });
  const target = scheduledTasksFile(projectPath);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temp, JSON.stringify(tasks, null, 2), 'utf-8');
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function saveScheduledRun(run: ScheduledRun): Promise<void> {
  await fs.mkdir(scheduledRunsDir(run.projectPath), { recursive: true });
  const destination=scheduledRunsFile(run.projectPath,run.id);
  const temp=destination+'.'+randomUUID()+'.tmp';
  try{
    await fs.writeFile(temp,JSON.stringify(run,null,2),'utf-8');
    await fs.rename(temp,destination);
  }catch(error){await fs.rm(temp,{force:true}).catch(()=>undefined);throw error;}
}

export async function listScheduledRuns(projectPath: string, taskId?: string): Promise<ScheduledRun[]> {
  const dir = scheduledRunsDir(projectPath);
  if (!existsSync(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: ScheduledRun[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    try {
      const r = JSON.parse(await fs.readFile(path.join(dir, e.name), 'utf-8')) as ScheduledRun;
      if (taskId && r.taskId !== taskId) continue;
      out.push({ ...r, projectPath });
    } catch {
      /* skip bad file */
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

// ---------- channels storage (项目级) ----------
// 渠道配置是项目维度的：每个项目有自己独立的渠道列表，
// 存储于 <project>/.sage/channels/channels.json。
// 注意：全局的入站中继（relay）配置不在此处，而在 AppSettings（settings.json）。

function channelsDir(projectPath: string): string {
  return path.join(projectDir(projectPath), 'channels');
}

function channelsFile(projectPath: string): string {
  return path.join(channelsDir(projectPath), 'channels.json');
}

export async function listChannels(projectPath: string): Promise<ChannelConfig[]> {
  try {
    const raw = await fs.readFile(channelsFile(projectPath), 'utf-8');
    const arr = JSON.parse(raw);
    let list = Array.isArray(arr) ? (arr as ChannelConfig[]) : [];
    // 向后兼容：旧的 feishu 类型迁移到 feishu-webhook（单向群机器人）
    let changed = false;
    for (const c of list) {
      if (c.type === 'feishu') {
        c.type = 'feishu-webhook';
        changed = true;
      }
      // 运行时注入 projectPath（不持久化到磁盘，但 inbound-server 需要它定位项目）
      c.projectPath = projectPath;
    }
    if (changed) {
      // 静默持久化迁移结果（不 await，避免阻塞调用方）
      void saveChannels(projectPath, list);
    }
    return list;
  } catch {
    return [];
  }
}

export async function saveChannels(projectPath: string, channels: ChannelConfig[]): Promise<void> {
  await fs.mkdir(channelsDir(projectPath), { recursive: true });
  // projectPath 是运行时注入的，不持久化
  const clean = channels.map(({ projectPath: _, ...rest }) => rest);
  await fs.writeFile(channelsFile(projectPath), JSON.stringify(clean, null, 2), 'utf-8');
}

/**
 * 跨所有项目查找指定 webhookPath 的启用渠道（入站 webhook 不知道消息属于哪个项目）。
 */
export async function findChannelByWebhookPathGlobal(webhookPath: string): Promise<ChannelConfig | null> {
  const projects = await listProjects();
  for (const proj of projects) {
    const channels = await listChannels(proj.path);
    const found = channels.find((c) => c.inboundWebhookPath === webhookPath && c.enabled);
    if (found) return found; // 已注入 projectPath
  }
  return null;
}
