import path from 'node:path';
import fs from 'node:fs/promises';

export interface FileEntry {
  name: string;
  relPath: string;
  isDir: boolean;
  size?: number;
  mtime?: string;
  ctime?: string;
}

export interface FileReadResult {
  content: string;
  binary: boolean;
  size: number;
  truncated?: boolean;
  /** 文件最后修改时间（ISO 字符串），编辑器头部展示「最后更新时间」。 */
  mtime?: string;
}

// 硬忽略列表：只放"几乎不可能是源码"的目录。
// 注意：build 曾被忽略，但它是很多非 JS 项目的真实源码目录
// （如 PHP/C++ 项目），不能一刀切隐藏。
const HARD_IGNORE = new Set([
  'node_modules',
  'dist',
  'dist-electron',
  'release',
  '.git',
  '.DS_Store',
  '.next',
  '.cache',
  '__pycache__',
  '.idea',
]);

function shouldHide(name: string): boolean {
  if (HARD_IGNORE.has(name)) return true;
  // Hide other dotfiles except a small allowlist
  if (name.startsWith('.') && name !== '.sage' && name !== '.gitignore' && name !== '.env.example') {
    return true;
  }
  return false;
}

function safeJoin(projectPath: string, relPath: string): string {
  const abs = path.resolve(projectPath, relPath || '.');
  const root = path.resolve(projectPath);
  // Reject any path that escapes the project root.
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes project root: ${relPath}`);
  }
  return abs;
}

export { safeJoin };

/** 单层列目录（不做折叠），compact 链走查时复用。 */
async function listDirRaw(projectPath: string, relPath: string, hidden: string[] = []): Promise<FileEntry[]> {
  const abs = safeJoin(projectPath, relPath);
  if(relPath.split(/[\\/]/).some(part=>hidden.includes(part)))return [];
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const out: FileEntry[] = [];
  for (const e of entries) {
    if (shouldHide(e.name) || (e.isDirectory() && hidden.includes(e.name))) continue;
    const childRel = relPath ? path.join(relPath, e.name) : e.name;
    let size: number | undefined;
    let mtime: string | undefined;
    let ctime: string | undefined;
    try {
      const st = await fs.stat(path.join(abs, e.name));
      if (e.isFile()) size = st.size;
      mtime = st.mtime.toISOString();
      ctime = st.birthtime.toISOString();
    } catch {
      /* ignore */
    }
    out.push({
      name: e.name,
      relPath: childRel,
      isDir: e.isDirectory(),
      size,
      mtime,
      ctime,
    });
  }
  // dirs first, then alphabetical
  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/**
 * 单目录链折叠的最大深度（防御符号链接环 / 异常深目录导致死循环）。
 */
const MAX_COMPACT_DEPTH = 40;

/**
 * 单目录链折叠（compact folders，对齐 IntelliJ「Compact Middle Packages」/
 * VSCode「explorer.compactFolders」的行为）。
 *
 * 规则：一个目录里**可见条目只有一个且是目录**时，把这条链合并成一行，
 * 名字用 "/" 连接（如 `src/main/java`），展开时直接显示链尾目录的内容。
 *
 * 为什么需要：Java / Maven、Go、Python 包这类项目常见
 * `src/main/java/com/example/...` 一长串每层只有一个子目录，
 * 逐层点击展开非常费事；折叠后一行就能看到完整路径并直接展开到有内容的层。
 *
 * 只统计"可见"条目（已过滤 shouldHide 的 node_modules / .git 等），与 VSCode 一致：
 * 目录里除了 `src` 还有个被忽略的 `node_modules` 时，仍然折叠成 `…/src`。
 *
 * @returns 折叠后的条目；不满足折叠条件时原样返回传入的 entry
 */
async function compactSingleDirChain(
  projectPath: string,
  entry: FileEntry,
  hidden: string[],
): Promise<FileEntry> {
  if (!entry.isDir) return entry;
  let rel = entry.relPath;
  let name = entry.name;
  for (let depth = 0; depth < MAX_COMPACT_DEPTH; depth++) {
    let children: FileEntry[];
    try {
      children = await listDirRaw(projectPath, rel, hidden);
    } catch {
      break; // 读不了（权限 / 已删除）就停在当前层
    }
    if (children.length !== 1 || !children[0].isDir) break;
    const only = children[0];
    // 防御：relPath 必须真的在 rel 之下，避免符号链接环导致原地打转
    if (!only.relPath.startsWith(rel + path.sep) && only.relPath !== rel) break;
    rel = only.relPath;
    name = `${name}/${only.name}`;
  }
  return { name, relPath: rel, isDir: true, mtime: entry.mtime };
}

export async function listDir(projectPath: string, relPath = '', hidden: string[] = []): Promise<FileEntry[]> {
  const raw = await listDirRaw(projectPath, relPath, hidden);
  // 逐个目录尝试折叠单子目录链（文件原样返回）
  const out: FileEntry[] = [];
  for (const e of raw) {
    out.push(e.isDir ? await compactSingleDirChain(projectPath, e, hidden) : e);
  }
  return out;
}

const MAX_EDIT_BYTES = 10 * 1024 * 1024; // 10MB cap for the simple editor
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB cap for image preview

/** 判断是否是图片文件（通过扩展名）。 */
export function isImageFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'].includes(ext);
}

export async function readFileAsBase64(projectPath: string, relPath: string): Promise<{ ok: boolean; data?: string; mimeType?: string; size?: number; error?: string }> {
  const abs = safeJoin(projectPath, relPath);
  const st = await fs.stat(abs);
  if (!st.isFile()) {
    return { ok: false, error: 'not a file' };
  }
  if (st.size > MAX_IMAGE_BYTES) {
    return { ok: false, error: 'image too large (max 10MB)' };
  }
  const buf = await fs.readFile(abs);
  const ext = path.extname(relPath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
  };
  const mimeType = mimeMap[ext] || 'application/octet-stream';
  const data = buf.toString('base64');
  return {
    ok: true,
    data: `data:${mimeType};base64,${data}`,
    mimeType,
    size: st.size,
  };
}

export async function readFile(projectPath: string, relPath: string): Promise<FileReadResult> {
  const abs = safeJoin(projectPath, relPath);
  const st = await fs.stat(abs);
  if (!st.isFile()) throw new Error('not a file');

  if (st.size > MAX_EDIT_BYTES) {
    // Read the preview range from disk; reading the whole file before slicing
    // can exhaust memory when a user opens a multi-gigabyte log or data file.
    const handle = await fs.open(abs, 'r');
    let buf: Buffer;
    try {
      const prefix = Buffer.alloc(MAX_EDIT_BYTES);
      let read = 0;
      while (read < prefix.length) {
        const {bytesRead} = await handle.read(prefix, read, prefix.length - read, read);
        if (!bytesRead) break;
        read += bytesRead;
      }
      buf = prefix.subarray(0, read);
    } finally { await handle.close(); }
    const binary = looksBinary(buf.subarray(0, 4096));
    return {
      content: binary ? '' : buf.toString('utf-8'),
      binary,
      size: st.size,
      truncated: true,
      mtime: st.mtime.toISOString(),
    };
  }
  const buf = await fs.readFile(abs);
  const binary = looksBinary(buf.subarray(0, 4096));
  return {
    content: binary ? '' : buf.toString('utf-8'),
    binary,
    size: st.size,
    mtime: st.mtime.toISOString(),
  };
}

export async function writeFile(projectPath: string, relPath: string, content: string): Promise<void> {
  const abs = safeJoin(projectPath, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf-8');
}

/**
 * 取单个文件的元信息（大小 / 修改时间），用于保存后刷新编辑器头部的
 * 「最后更新时间」，避免为此重读整个文件内容。
 */
export async function statFile(projectPath: string, relPath: string): Promise<{ size: number; mtime: string }> {
  const abs = safeJoin(projectPath, relPath);
  const st = await fs.stat(abs);
  return { size: st.size, mtime: st.mtime.toISOString() };
}

/** 创建文件夹（支持递归创建父目录）。 */
export async function mkdir(projectPath: string, relPath: string): Promise<void> {
  const abs = safeJoin(projectPath, relPath);
  await fs.mkdir(abs, { recursive: true });
}

/** 创建新文件（如果父目录不存在会自动创建）。如果文件已存在则抛出错误。 */
export async function createFile(projectPath: string, relPath: string, content = ''): Promise<void> {
  const abs = safeJoin(projectPath, relPath);
  // 检查文件是否已存在
  try {
    await fs.access(abs);
    throw new Error('文件已存在');
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err; // 文件已存在，其他错误则抛出
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf-8');
}

export async function searchFiles(
  projectPath: string,
  query: string,
  limit = 200,
  scope?: string,
  hidden: string[] = [],
): Promise<FileEntry[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const root = path.resolve(projectPath);
  // 搜索范围：限定到某个子目录（右键「作为搜索范围」），结果 relPath 仍相对项目根，
  // 保证点击后 openFile 能正确打开。scope 必须走 safeJoin 防目录穿越。
  const walkRoot = scope && scope.trim() ? safeJoin(projectPath, scope.trim()) : root;
  const results: FileEntry[] = [];

  async function walk(dir: string): Promise<void> {
    if(path.relative(root,dir).split(path.sep).some(part=>hidden.includes(part)))return;
    if (results.length >= limit) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= limit) return;
      if (shouldHide(e.name) || (e.isDirectory() && hidden.includes(e.name))) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        // Match against either basename or path segments.
        if (e.name.toLowerCase().includes(q) || rel.toLowerCase().includes(q)) {
          let size: number | undefined;
          try {
            const st = await fs.stat(abs);
            size = st.size;
          } catch {
            /* ignore */
          }
          results.push({ name: e.name, relPath: rel, isDir: false, size });
        }
      }
    }
  }

  await walk(walkRoot);
  // Prefer matches whose basename starts with the query, then alphabetical.
  results.sort((a, b) => {
    const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
    const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    return a.relPath.localeCompare(b.relPath);
  });
  return results;
}

function looksBinary(buf: Buffer): boolean {
  if (buf.includes(0)) return true;
  let nonText = 0;
  for (const b of buf) {
    // tab, lf, cr, and printable range
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 128) continue;
    nonText++;
  }
  return nonText / Math.max(1, buf.length) > 0.3;
}

// ---------------------------------------------------------------------------
// 全局内容搜索（grep）
// ---------------------------------------------------------------------------

/** 单条内容匹配：文件内的一行。 */
export interface ContentMatch {
  /** 行号（1 起）。 */
  line: number;
  /** 该行去掉首尾空白后的片段（截断到 200 字符，UI 直接展示）。 */
  snippet: string;
}

/** 一个文件的匹配汇总。 */
export interface ContentSearchFile {
  relPath: string;
  name: string;
  matches: ContentMatch[];
  /** 该文件内的总匹配次数（展示的可能被截断）。 */
  total: number;
}

export interface ContentSearchResult {
  files: ContentSearchFile[];
  /** 全部文件的匹配总行数。 */
  totalMatches: number;
  /** 是否因上限被截断。 */
  truncated: boolean;
}

const CONTENT_SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024; // 单文件 2MB 上限，跳过更大的
const CONTENT_SEARCH_MAX_MATCHES_PER_FILE = 50;        // 单文件最多展示 50 行

/**
 * 项目全局内容搜索。大小写不敏感，复用文件树的忽略规则（node_modules 等）。
 * 限制：最多 maxFiles 个文件、maxMatches 行匹配，超出截断。
 */
export async function searchFileContents(
  projectPath: string,
  query: string,
  maxFiles = 100,
  maxMatches = 500,
  scope?: string,
  hidden: string[] = [],
): Promise<ContentSearchResult> {
  const q = query.trim();
  if (!q) return { files: [], totalMatches: 0, truncated: false };
  const ql = q.toLowerCase();
  const root = path.resolve(projectPath);
  // 搜索范围：限定到某个子目录，匹配结果的 relPath 仍相对项目根。
  const walkRoot = scope && scope.trim() ? safeJoin(projectPath, scope.trim()) : root;

  const files: ContentSearchFile[] = [];
  const fileMap = new Map<string, ContentSearchFile>(); // 按 relPath 去重，防止符号链接等导致重复
  let totalMatches = 0;
  let truncated = false;
  let stop = false;

  async function scanFile(abs: string, rel: string, name: string): Promise<void> {
    if (stop) return;
    // 已有该文件的结果则跳过（去重）
    if (fileMap.has(rel)) return;
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      return;
    }
    if (!st.isFile() || st.size === 0 || st.size > CONTENT_SEARCH_MAX_FILE_BYTES) return;

    let buf;
    try {
      buf = await fs.readFile(abs);
    } catch {
      return;
    }
    if (looksBinary(buf.subarray(0, 4096))) return;

    const text = buf.toString('utf-8');
    if (!text.toLowerCase().includes(ql)) return;

    const lines = text.split(/\r?\n/);
    const matches: ContentMatch[] = [];
    let fileTotal = 0;
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase();
      if (!lower.includes(ql)) continue;
      fileTotal++;
      totalMatches++;
      if (totalMatches >= maxMatches) {
        truncated = true;
        stop = true;
      }
      if (matches.length < CONTENT_SEARCH_MAX_MATCHES_PER_FILE) {
        const trimmed = lines[i].trim();
        matches.push({
          line: i + 1,
          snippet: trimmed.length > 200 ? trimmed.slice(0, 200) + '…' : trimmed,
        });
      }
      if (stop) break;
    }
    if (fileTotal > 0) {
      const entry: ContentSearchFile = { relPath: rel, name, matches, total: fileTotal };
      fileMap.set(rel, entry);
      files.push(entry);
      if (files.length >= maxFiles) {
        truncated = true;
        stop = true;
      }
    }
  }

  async function walk(dir: string): Promise<void> {
    if(path.relative(root,dir).split(path.sep).some(part=>hidden.includes(part)))return;
    if (stop) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (stop) return;
      if (shouldHide(e.name) || (e.isDirectory() && hidden.includes(e.name))) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        await scanFile(abs, rel, e.name);
      } else if (e.isSymbolicLink()) {
        // 符号链接：判断目标是文件还是目录，但统一按去重处理
        // （符号链接可能导致同一文件被遍历多次）
        try {
          const stat = await fs.stat(abs);
          if (stat.isDirectory()) {
            await walk(abs);
          } else if (stat.isFile()) {
            await scanFile(abs, rel, e.name);
          }
        } catch {
          /* broken symlink, skip */
        }
      }
    }
  }

  await walk(walkRoot);
  return { files, totalMatches, truncated };
}
