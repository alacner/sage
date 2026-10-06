/**
 * Long-term memory system for Sage.
 *
 * Stores structured memories in JSON files (two layers):
 *   - Project-level: `.sage/memory.json` (project-specific knowledge)
 *   - User-level:    `~/.sage/memory.json` (cross-project user preferences)
 *
 * Each memory entry has:
 *   - id: unique identifier
 *   - content: the memory text
 *   - tags: keywords for retrieval
 *   - createdAt / updatedAt: timestamps
 *   - source: 'user' | 'agent' (who created it)
 *   - convId / convTitle: (conversation scope only) snapshot of the owning
 *     conversation's id and title, stamped at write time so entries remain
 *     attributable to their conversation
 *
 * Retrieval uses simple keyword matching (no vector DB needed for this scale).
 * Relevant memories are injected into the system prompt before each conversation.
 *
 * 同一件事只留一条：写入时按字符相似度查重，命中即融合进既有条目（正文以最新为准、
 * 标签取并集），不再追加重复条目；历史遗留的重复由 dedupeMemories() 分层清理。
 * 融合判定在 shared/memory-merge.ts（纯函数，不依赖 electron，可单独测）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { PROJECT_DIR, convRoot } from './store';
import {
  MEMORY_DUP_THRESHOLD,
  MEMORY_MERGED_FROM_CAP,
  clusterDuplicates,
  findDuplicateMatch,
  memorySimilarity,
  mergeClusterText,
  mergeTags,
  relatedMemories,
  fuseMemoryContent,
} from '../shared/memory-merge';

// ── Types ─────────────────────────────────────────────────────────────────

/** 记忆层级：当前对话 > 项目 > 全局（user），注入与冲突裁决时高优先级优先。 */
export type MemoryScope = 'conversation' | 'project' | 'user';

/** 层级优先级：数值越大越高（跨层查重、注入兜底都按它取舍）。 */
const SCOPE_RANK: Record<MemoryScope, number> = { conversation: 3, project: 2, user: 1 };

export interface MemoryEntry {
  id: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  source: 'user' | 'agent';
  /** 对话级记忆归属标识：写入时快照，便于分辨条目来自哪个对话（文件/UI/注入均可读）。 */
  convId?: string;
  convTitle?: string;
  /** 融合留痕：被这条记忆吸收掉的旧表述（同一条记忆的其他说法），不参与匹配。 */
  mergedFrom?: { content: string; updatedAt: string }[];
}

/** 列表返回值：附带条目所属层级，供 UI 展示徽章与注入按优先级取舍。 */
export type MemoryEntryWithScope = MemoryEntry & { scope: MemoryScope };

export interface MemoryStore {
  entries: MemoryEntry[];
}

/** 写入结果：merged 非空表示这次没有新增条目，而是并进了既有那一条。 */
export interface MemoryWriteResult {
  entry: MemoryEntry;
  /** 本次写入的落点层级（merged 时是既有条目所在层） */
  scope: MemoryScope;
  /** 融合信息；null = 新建了一条 */
  merged: {
    id: string;
    scope: MemoryScope;
    score: number;
    /** 同层内被合并掉的重复条目数（不含本次写入自身） */
    folded: number;
  } | null;
  /** 更低优先级层已有一条相同表述（本条在它之上生效，跨层不互删，仅提示） */
  alsoExistsIn: { id: string; scope: MemoryScope }[];
}

/** 批量清理结果：每层删掉多少条、备份文件放在哪儿。 */
export interface MemoryDedupeResult {
  removed: number;
  layers: { scope: MemoryScope; removed: number; file: string }[];
  backups: string[];
}

// ── Paths ──────────────────────────────────────────────────────────────────

function userMemoryPath(): string {
  return path.join(os.homedir(), '.sage', 'memory.json');
}

function projectMemoryPath(projectPath: string): string {
  return path.join(projectPath, PROJECT_DIR, 'memory.json');
}

/** 对话级记忆：与该对话 meta.json 同目录，仅当前对话生效。 */
function convMemoryPath(projectPath: string, convId: string): string {
  return path.join(convRoot(projectPath), convId, 'memory.json');
}

/** update/delete 的查找顺序：对话级 → 项目级 → 全局。 */
function searchPaths(projectPath: string, convId?: string): string[] {
  return [
    ...(convId ? [convMemoryPath(projectPath, convId)] : []),
    projectMemoryPath(projectPath),
    userMemoryPath(),
  ];
}

/** 写入落点：conversation 缺 convId 时退回项目层，避免写进无法归属的目录。 */
function filePathFor(projectPath: string, scope: MemoryScope, convId?: string): string {
  if (scope === 'user') return userMemoryPath();
  if (scope === 'conversation' && convId) return convMemoryPath(projectPath, convId);
  return projectMemoryPath(projectPath);
}

/** 某文件属于哪一层（用于清理结果展示）。 */
function scopeOfFile(filePath: string): MemoryScope {
  if (filePath === userMemoryPath()) return 'user';
  return /chats[/\\][^/\\]+[/\\]memory\.json$/.test(filePath) ? 'conversation' : 'project';
}

// ── Read/Write ─────────────────────────────────────────────────────────────

async function readMemoryFile(filePath: string): Promise<MemoryStore> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.entries)) return data;
  } catch (error:any) {
    if(error.code!=='ENOENT')throw error;
  }
  return { entries: [] };
}

async function writeMemoryFile(filePath: string, store: MemoryStore): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp=filePath+'.'+randomBytes(6).toString('hex')+'.tmp';
  try { await fs.writeFile(temp, JSON.stringify(store, null, 2), 'utf-8');await fs.rename(temp,filePath); }
  finally { await fs.rm(temp,{force:true}); }
}

/**
 * 统计每个对话的对话级记忆条目数（对话清单「已配置记忆」icon 用）。
 * 仅返回 entries > 0 的对话；无记忆文件/空条目不入结果。
 */
export async function listConvMemoryCounts(projectPath: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const base = convRoot(projectPath);
  let names: string[] = [];
  try {
    names = await fs.readdir(base);
  } catch {
    return out;
  }
  await Promise.all(
    names.map(async (id) => {
      const store = await readMemoryFile(path.join(base, id, 'memory.json'));
      if (store.entries.length > 0) out[id] = store.entries.length;
    }),
  );
  return out;
}

/** 读取对话标题（快照进对话级记忆条目；读取失败返回 undefined）。 */
async function readConvTitle(projectPath: string, convId: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(path.dirname(convMemoryPath(projectPath, convId)), 'meta.json'), 'utf-8');
    const meta = JSON.parse(raw);
    return typeof meta?.title === 'string' && meta.title ? meta.title.slice(0, 120) : undefined;
  } catch {
    return undefined;
  }
}

// ── CRUD Operations ────────────────────────────────────────────────────────

/**
 * List all memories (layers merged, each tagged with its scope),
 * optionally filtered by tags. Pass convId to include conversation-level memories.
 */
export async function listMemories(
  projectPath: string,
  filterTags?: string[],
  convId?: string,
): Promise<MemoryEntryWithScope[]> {
  const stores = await Promise.all([
    readMemoryFile(userMemoryPath()).then((s) => ({ s, scope: 'user' as const })),
    readMemoryFile(projectMemoryPath(projectPath)).then((s) => ({ s, scope: 'project' as const })),
    convId
      ? readMemoryFile(convMemoryPath(projectPath, convId)).then((s) => ({ s, scope: 'conversation' as const }))
      : Promise.resolve({ s: { entries: [] } as MemoryStore, scope: 'conversation' as const }),
  ]);
  let all: MemoryEntryWithScope[] = stores.flatMap(({ s, scope }) =>
    s.entries.map((e) => ({ ...e, scope })),
  );
  if (filterTags && filterTags.length > 0) {
    const lower = filterTags.map((t) => t.toLowerCase());
    all = all.filter((e) =>
      e.tags.some((tag) => lower.some((f) => tag.toLowerCase().includes(f))),
    );
  }
  // Sort by updatedAt descending (most recent first)
  all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return all;
}

/** Mobile/settings management reads one explicitly selected layer, never a fallback layer. */
export async function listScopedMemories(projectPath: string, scope: 'user' | 'project'): Promise<MemoryEntryWithScope[]> {
  const store = await readMemoryFile(filePathFor(projectPath, scope));
  return store.entries.map(entry => ({ ...entry, scope })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 三层记忆文件（按优先级从高到低），跨层查重与批量清理共用。 */
function layerFiles(projectPath: string, convId?: string): Array<{ file: string; scope: MemoryScope }> {
  return [
    ...(convId ? [{ file: convMemoryPath(projectPath, convId), scope: 'conversation' as MemoryScope }] : []),
    { file: projectMemoryPath(projectPath), scope: 'project' as MemoryScope },
    { file: userMemoryPath(), scope: 'user' as MemoryScope },
  ];
}

/**
 * 把一簇重复条目（含本次待写入的那条）压成一条。
 * 正文由 mergeClusterText 取舍（以最新为准，除非最新只是旧条目的子集）；id / 对话归属
 * 沿用簇内最早那条（保持“同一条记忆”的身份不变），createdAt 取最早、updatedAt 刷到当下。
 */
function foldCluster(cluster: MemoryEntry[], now: string): MemoryEntry {
  const merged = mergeClusterText(cluster);
  if(cluster.some(a=>cluster.some(b=>memorySimilarity(a.content,b.content)<MEMORY_DUP_THRESHOLD)))merged.content=fuseMemoryContent(cluster);
  const host = [...cluster].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  const seen = new Set<string>();
  const mergedFrom = [...(host.mergedFrom ?? []), ...merged.mergedFrom].filter((v) => {
    const key = v.content.trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(-MEMORY_MERGED_FROM_CAP);
  return {
    ...host,
    content: merged.content,
    tags: mergeTags(...cluster.map((e) => e.tags)),
    createdAt: [...cluster].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0].createdAt,
    updatedAt: now,
    // 来源看“谁说过”而不是“谁最后复述”：用户提过的偏好被助手再存一次，不配降级成助手自说
    source: cluster.some((e) => e.source === 'user') ? 'user' : merged.from.source,
    mergedFrom: mergedFrom.length ? mergedFrom : undefined,
  };
}

/** 注入/跨层提示用：同一件事只留优先级最高、更新的那条。 */
function collapseDuplicates(entries: MemoryEntryWithScope[]): MemoryEntryWithScope[] {
  const ordered = [...entries].sort(
    (a, b) => (SCOPE_RANK[b.scope] - SCOPE_RANK[a.scope]) || b.updatedAt.localeCompare(a.updatedAt),
  );
  const kept: MemoryEntryWithScope[] = [];
  for (const entry of ordered) {
    if (!kept.some((k) => memorySimilarity(k.content, entry.content) >= MEMORY_DUP_THRESHOLD)) kept.push(entry);
  }
  return kept;
}

/**
 * 新增记忆。同一件事只留一条：
 * 1. 同层已有相似表述 → 融合进既有条目（正文以最新为准、标签取并集、被吸收的旧说法
 *    记进 mergedFrom），不新增；
 * 2. 更高优先级层已有 → 只把标签并过去，同样不新增（那条本来就已经压住要写的内容）；
 * 3. 只有更低优先级层有 → 照写（层级适用范围不同），但在结果里提示，便于模型/用户知道
 *    “全局已有一条相同表述”。
 * 跨层不互删：删掉全局会波及其他项目，删掉对话级会波及其他对话。
 */
async function addMemoryImpl(
  projectPath: string,
  content: string,
  tags: string[],
  source: 'user' | 'agent' = 'agent',
  scope: MemoryScope = 'project',
  convId?: string,
  scopeOnly = false,
): Promise<MemoryWriteResult> {
  const text = String(content ?? '').trim();
  const targetScope: MemoryScope = scope === 'conversation' && !convId ? 'project' : scope;
  const filePath = filePathFor(projectPath, targetScope, convId);
  const now = new Date().toISOString();
  const store = await readMemoryFile(filePath);
  const incoming: MemoryEntry = {
    id: randomBytes(8).toString('base64url'),
    content: text,
    tags,
    createdAt: now,
    updatedAt: now,
    source,
  };
  // 对话级条目快照归属对话（名称+ID），事后查看可分辨来源对话
  if (targetScope === 'conversation' && convId) {
    incoming.convId = convId;
    incoming.convTitle = await readConvTitle(projectPath, convId);
  }

  // 1) 同层查重：命中则把整簇（含本次写入）融合成一条
  const best = findDuplicateMatch(store.entries, text) ?? (()=>{const entry=store.entries.find(e=>relatedMemories(e,incoming));return entry?{entry,score:memorySimilarity(entry.content,text)}:null;})();
  if (best) {
    const dupes = store.entries.filter((e) => relatedMemories(e,incoming));
    const survivor = foldCluster([...dupes, incoming], now);
    store.entries = [...store.entries.filter((e) => !dupes.includes(e)), survivor];
    await writeMemoryFile(filePath, store);
    return {
      entry: survivor,
      scope: targetScope,
      merged: { id: survivor.id, scope: targetScope, score: best.score, folded: dupes.length },
      alsoExistsIn: scopeOnly ? [] : await findShadowDuplicates(projectPath, targetScope, survivor.content, convId),
    };
  }

  // 2) 更高优先级层已有同一件事：不新增，只把标签并到那条上（它已压住本次内容）
  for (const { file, scope: layer } of scopeOnly ? [] : layerFiles(projectPath, convId)) {
    if (SCOPE_RANK[layer] <= SCOPE_RANK[targetScope]) continue;
    const upper = await readMemoryFile(file);
    const hit = findDuplicateMatch(upper.entries, text);
    if (!hit) continue;
    hit.entry.tags = mergeTags(hit.entry.tags, tags);
    // 同一条陈述刚又被确认一次：刷新时间，让新鲜度评分与实际一致
    hit.entry.updatedAt = now;
    await writeMemoryFile(file, upper);
    return {
      entry: hit.entry,
      scope: layer,
      merged: { id: hit.entry.id, scope: layer, score: hit.score, folded: 0 },
      alsoExistsIn: [],
    };
  }

  // 3) 正常新增
  store.entries.push(incoming);
  await writeMemoryFile(filePath, store);
  return {
    entry: incoming,
    scope: targetScope,
    merged: null,
    alsoExistsIn: scopeOnly ? [] : await findShadowDuplicates(projectPath, targetScope, text, convId),
  };
}

/** 更低优先级层里相同表述的条目（只提示，不跨层删除）。 */
async function findShadowDuplicates(
  projectPath: string,
  scope: MemoryScope,
  content: string,
  convId?: string,
): Promise<{ id: string; scope: MemoryScope }[]> {
  const out: { id: string; scope: MemoryScope }[] = [];
  for (const { file, scope: layer } of layerFiles(projectPath, convId)) {
    if (layer === scope || SCOPE_RANK[layer] >= SCOPE_RANK[scope]) continue;
    const store = await readMemoryFile(file);
    for (const e of store.entries) {
      if (memorySimilarity(e.content, content) >= MEMORY_DUP_THRESHOLD) out.push({ id: e.id, scope: layer });
    }
  }
  return out;
}

/**
 * Update an existing memory entry by ID (searches conversation → project → user).
 * 改完顺带把同层里因此变成重复的条目并进来（改后的那条做宿主）。
 */
async function updateMemoryImpl(
  projectPath: string,
  id: string,
  updates: Partial<Pick<MemoryEntry, 'content' | 'tags'>>,
  convId?: string,
  scope?: MemoryScope,
): Promise<MemoryEntry | null> {
  for (const filePath of scope ? [filePathFor(projectPath, scope, convId)] : searchPaths(projectPath, convId)) {
    const store = await readMemoryFile(filePath);
    const entry = store.entries.find((e) => e.id === id);
    if (entry) {
      if (updates.content !== undefined) entry.content = updates.content;
      if (updates.tags !== undefined) entry.tags = updates.tags;
      // 命中对话级文件：顺带刷新归属快照（对话可能已改名）
      const m = filePath.match(/chats[/\\]([^/\\]+)[/\\]memory\.json$/);
      if (m) {
        entry.convId = m[1];
        entry.convTitle = await readConvTitle(projectPath, m[1]);
      }
      const now = new Date().toISOString();
      entry.updatedAt = now;
      // 编辑后可能与同层另一条撞车：以本条为宿主合并，不让一次编辑制造重复
      const dupes = store.entries.filter((e) => e !== entry && relatedMemories(e,entry));
      if (dupes.length) {
        const merged = foldCluster([entry, ...dupes], now);
        Object.assign(entry, merged, { id: entry.id });
        store.entries = store.entries.filter((e) => !dupes.includes(e));
      }
      await writeMemoryFile(filePath, store);
      return entry;
    }
  }
  return null;
}

/**
 * Delete a memory entry by ID (searches conversation → project → user).
 */
async function deleteMemoryImpl(
  projectPath: string,
  id: string,
  convId?: string,
  scope?: MemoryScope,
): Promise<boolean> {
  for (const filePath of scope ? [filePathFor(projectPath, scope, convId)] : searchPaths(projectPath, convId)) {
    const store = await readMemoryFile(filePath);
    const idx = store.entries.findIndex((e) => e.id === id);
    if (idx >= 0) {
      store.entries.splice(idx, 1);
      await writeMemoryFile(filePath, store);
      return true;
    }
  }
  return false;
}

// ── 历史重复清理 ─────────────────────────────────────────────────────────────

/** 备份目录（点开头的子目录，不会被按 *.json 扫描的逻辑误认成记忆文件）。 */
const MERGE_BACKUP_DIR = '.merge-backups';
const MERGE_BACKUP_KEEP = 5;

/**
 * 清理前备份原文件；失败返回 null。备份拿不到就不删（宁可留着重复，也不做不可恢复的
 * 清理），每个目录最多留最近 MERGE_BACKUP_KEEP 份。
 */
async function backupMemoryFile(filePath: string): Promise<string | null> {
  const dir = path.join(path.dirname(filePath), MERGE_BACKUP_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `${path.basename(filePath, '.json')}-${stamp}.json`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(filePath, target);
    const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json')).sort();
    await Promise.all(
      names.slice(0, Math.max(0, names.length - MERGE_BACKUP_KEEP)).map((n) => fs.rm(path.join(dir, n), { force: true })),
    );
    return target;
  } catch {
    return null;
  }
}

/**
 * 分层清理历史重复：每层各自聚类，一簇只留一条（正文以最新为准、标签并集、旧说法记进
 * mergedFrom）。只在本层内合并，不跨层删——三层适用范围不同。
 */
async function dedupeMemoriesImpl(projectPath: string, convId?: string, selection?: {scope:MemoryScope;ids:string[];content:string;tags:string[]}): Promise<MemoryDedupeResult> {
  if(selection){
    if(!['user','project','conversation'].includes(selection.scope)||!Array.isArray(selection.ids)||new Set(selection.ids).size<2||selection.ids.length>100||typeof selection.content!=='string'||!selection.content.trim()||selection.content.length>100000||!Array.isArray(selection.tags)||selection.tags.some(t=>typeof t!=='string'))throw Error('Invalid memory fusion');
    if(selection.scope==='conversation'&&!convId)throw Error('Conversation required');
    const file=filePathFor(projectPath,selection.scope,convId),store=await readMemoryFile(file);
    const members=store.entries.filter(e=>selection.ids.includes(e.id));
    if(members.length!==new Set(selection.ids).size)throw Error('Memory selection changed; refresh and retry');
    const backup=await backupMemoryFile(file);if(!backup)throw Error('Cannot back up memories');
    const merged=foldCluster(members,new Date().toISOString());
    merged.content=selection.content.trim();merged.tags=mergeTags(selection.tags);merged.source='user';
    await writeMemoryFile(file,{entries:[...store.entries.filter(e=>!selection.ids.includes(e.id)),merged]});
    return {removed:members.length-1,layers:[{scope:selection.scope,removed:members.length-1,file}],backups:[backup]};
  }
  const result: MemoryDedupeResult = { removed: 0, layers: [], backups: [] };
  const now = new Date().toISOString();
  for (const { file, scope } of layerFiles(projectPath, convId)) {
    const store = await readMemoryFile(file);
    const clusters = clusterDuplicates(store.entries);
    if (!clusters.length) continue;
    const removed = clusters.reduce((n, c) => n + c.length - 1, 0);
    const backup = await backupMemoryFile(file);
    if (!backup) continue;
    const members = new Set(clusters.flat());
    const kept = [
      ...store.entries.filter((e) => !members.has(e)),
      ...clusters.map((c) => foldCluster(c, now)),
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    await writeMemoryFile(file, { entries: kept });
    result.removed += removed;
    result.layers.push({ scope, removed, file });
    result.backups.push(backup);
  }
  return result;
}

// ── Retrieval for injection ────────────────────────────────────────────────

// Serialize read-modify-write operations so fusion cannot overwrite a concurrent save.
let memoryWrites: Promise<unknown> = Promise.resolve();
function serializeMemoryWrite<A extends unknown[], R>(fn:(...args:A)=>Promise<R>):(...args:A)=>Promise<R>{
  return (...args)=>{const work=memoryWrites.then(()=>fn(...args));memoryWrites=work.catch(()=>{});return work;};
}
export const addMemory=serializeMemoryWrite(addMemoryImpl);
export const updateMemory=serializeMemoryWrite(updateMemoryImpl);
export const deleteMemory=serializeMemoryWrite(deleteMemoryImpl);
/** Explicit settings writes retain normal same-layer deduplication and the shared write queue. */
export const addScopedMemory=serializeMemoryWrite((projectPath:string,content:string,tags:string[],scope:'user'|'project')=>addMemoryImpl(projectPath,content,tags,'user',scope,undefined,true));
export const updateScopedMemory=serializeMemoryWrite((projectPath:string,id:string,updates:Partial<Pick<MemoryEntry,'content'|'tags'>>,scope:'user'|'project')=>updateMemoryImpl(projectPath,id,updates,undefined,scope));
export const deleteScopedMemory=serializeMemoryWrite((projectPath:string,id:string,scope:'user'|'project')=>deleteMemoryImpl(projectPath,id,undefined,scope));
export const dedupeMemories=serializeMemoryWrite(dedupeMemoriesImpl);

/**
 * Retrieve relevant memories for injection into the system prompt.
 * Uses keyword matching against the current user message.
 * Selection follows the scope priority: conversation > project > user(global) —
 * higher layers fill the quota first, within a layer ordered by relevance.
 * Returns a formatted string suitable for system prompt insertion.
 */
export async function retrieveRelevantMemories(
  projectPath: string,
  userMessage: string,
  maxEntries: number = 5,
  convId?: string,
): Promise<string> {
  // 写入时已去重，这里再兜一道：旧版本遗留或手工改过的文件不会把额度重复占掉
  const all = collapseDuplicates(await listMemories(projectPath, undefined, convId));
  if (all.length === 0) return '';

  // Score each memory by keyword overlap with the user message
  const msgLower = userMessage.toLowerCase();
  const msgWords = new Set(msgLower.split(/[\s,.;:!?]+/).filter((w) => w.length > 1));

  const scored = all.map((entry) => {
    let score = 0;
    // Tag matches (higher weight)
    for (const tag of entry.tags) {
      if (msgLower.includes(tag.toLowerCase())) score += 3;
    }
    // Content keyword matches (lower weight)
    const contentLower = entry.content.toLowerCase();
    for (const word of msgWords) {
      if (word.length >= 3 && contentLower.includes(word)) score += 1;
    }
    // Recency bonus (entries from last 7 days get +1)
    const age = Date.now() - new Date(entry.updatedAt).getTime();
    if (age < 7 * 24 * 60 * 60 * 1000) score += 1;
    return { entry, score };
  });

  // 优先级配额：当前对话记忆 > 项目记忆 > 全局记忆，层内按相关性排序
  const relevant: MemoryEntryWithScope[] = [];
  for (const scope of ['conversation', 'project', 'user'] as MemoryScope[]) {
    if (relevant.length >= maxEntries) break;
    const picked = scored
      .filter((s) => s.score > 0 && s.entry.scope === scope)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxEntries - relevant.length);
    relevant.push(...picked.map((p) => p.entry));
  }

  if (relevant.length === 0) return '';

  const scopeLabel = (e: MemoryEntryWithScope): string => {
    if (e.scope === 'conversation') return `当前对话${e.convTitle ? `「${e.convTitle}」` : ''}`;
    return e.scope === 'project' ? '项目' : '全局';
  };
  const lines = relevant.map(
    (e) => `- [${scopeLabel(e)}][${e.source === 'user' ? '用户' : '助手'}] ${e.content} (标签: ${e.tags.join(', ')}；更新于 ${e.updatedAt.slice(0, 10)})`,
  );
  return (
    '\n\n## 长期记忆（Long-term Memory）\n\n' +
    '以下是与当前对话相关的历史记忆，同一件事只注入最新一条。生效范围：当前对话 > 项目 > 全局；' +
    '两条记忆内容冲突时，以更新时间最新的那条为准。请参考但不要显式提及"记忆"：\n\n' +
    lines.join('\n')
  );
}

/** Strict conversation-layer access for mobile; never falls back to project/user memory. */
function assertConversationMemoryId(convId: string): void {
  if (typeof convId !== 'string' || !/^[\w-]{1,200}$/.test(convId)) throw new Error('对话记忆标识无效');
}
export async function listConversationMemories(projectPath: string, convId: string): Promise<MemoryEntryWithScope[]> {
  assertConversationMemoryId(convId);
  const store = await readMemoryFile(convMemoryPath(projectPath, convId));
  return store.entries.map(entry => ({ ...entry, scope: 'conversation' as const }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function conversationMemoryRevision(entries: MemoryEntryWithScope[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
export const addConversationMemory = serializeMemoryWrite((projectPath: string, convId: string, content: string, tags: string[]) => {
  assertConversationMemoryId(convId);
  return addMemoryImpl(projectPath, content, tags, 'user', 'conversation', convId, true);
});
export const updateConversationMemory = serializeMemoryWrite((projectPath: string, convId: string, id: string, updates: Partial<Pick<MemoryEntry, 'content' | 'tags'>>) => {
  assertConversationMemoryId(convId);
  return updateMemoryImpl(projectPath, id, updates, convId, 'conversation');
});
export const deleteConversationMemory = serializeMemoryWrite((projectPath: string, convId: string, id: string) => {
  assertConversationMemoryId(convId);
  return deleteMemoryImpl(projectPath, id, convId, 'conversation');
});
export type ConversationMemoryChange =
  | { operation: 'add'; content: string; tags: string[] }
  | { operation: 'update'; itemId: string; content: string; tags: string[] }
  | { operation: 'delete'; itemId: string; confirm: boolean };
/** Revision validation shares the global write queue with desktop/agent memory writes. */
export const changeConversationMemory = serializeMemoryWrite(async (projectPath: string, convId: string, revision: string, change: ConversationMemoryChange): Promise<{ saved: true }> => {
  assertConversationMemoryId(convId);
  const entries = await listConversationMemories(projectPath, convId);
  if (revision !== conversationMemoryRevision(entries)) throw new Error('记忆已变化，请刷新后重试');
  if (!change || !['add', 'update', 'delete'].includes(change.operation)) throw new Error('记忆操作无效');
  if (change.operation !== 'add' && !entries.some(entry => entry.id === change.itemId)) throw new Error('记忆不存在于当前对话');
  if (change.operation === 'delete') {
    if (change.confirm !== true) throw new Error('删除记忆需要确认');
    await deleteMemoryImpl(projectPath, change.itemId, convId, 'conversation');
  } else {
    if (typeof change.content !== 'string' || !change.content.trim() || change.content.length > 100000 || change.content.includes('\0')
      || !Array.isArray(change.tags) || change.tags.length > 100
      || change.tags.some(tag => typeof tag !== 'string' || tag.length > 128 || tag.includes('\0'))) throw new Error('记忆内容或标签无效');
    if (change.operation === 'add') await addMemoryImpl(projectPath, change.content.trim(), change.tags, 'user', 'conversation', convId, true);
    else await updateMemoryImpl(projectPath, change.itemId, { content: change.content.trim(), tags: change.tags }, convId, 'conversation');
  }
  return { saved: true };
});
