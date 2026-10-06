import {snapshotToolFiles,finishToolFiles} from './tool-file-changes';
import {changedLines, type FileChange} from '../shared/file-changes';
import { consumeWebApproval } from './sandbox/tool-decision';
import { prepareRuntime } from './sandbox/runtime';
import { consumeCommand, commandPolicy } from './sandbox/command-decision';
/**
 * Local tool executor for API mode.
 *
 * Implements the tools declared in api-tool-defs.ts using Node built-ins.
 * All filesystem operations are constrained to the project directory via
 * safeJoin() from files.ts. Shell commands are executed via /bin/sh -c.
 *
 * Each executor returns a { result: string; isError?: boolean } — the
 * `result` string is what gets sent back to the model as tool_result content.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { safeJoin } from './files';
import { readSkill } from './skills';
import { normalizeToolName } from './api-tool-defs';
import { buildSandboxEnv } from './sandbox/env';
import { enforceInsideProject, isDeniedRead, isDeniedWrite, isPathInsideProject, SandboxError } from './sandbox/fs-policy';
import { checkUrl, getAllowedHosts } from './sandbox/net-policy';
import { auditAllow, auditDeny } from './sandbox/audit-log';
import { readSettings } from './main';
import { addMemory, listMemories, type MemoryScope } from './memory';
import { runtimeConfig } from '../shared/runtime-config';

const DEFAULT_BASH_TIMEOUT = 120_000; // 120s
const MAX_BASH_TIMEOUT = 600_000; // 10min
const MAX_GREP_RESULTS = 100;

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  'build',
  'release',
  '.next',
  '.cache',
  '__pycache__',
  '.idea',
]);

export interface ToolExecResult {
  images?: import('../shared/types').ImageAttachment[];
  fileChanges?: FileChange[];
  result: string;
  isError?: boolean;
}

/**
 * 获取网络白名单（含用户配置的 modelProvider baseUrl 域名）。
 * 异步因为需读取 settings。
 */
async function resolveAllowedHosts(): Promise<string[]> {
  try {
    const settings = await readSettings();
    const providerUrls = (settings.modelProviders ?? [])
      .filter((p) => p.enabled && p.baseUrl)
      .map((p) => p.baseUrl);
    if (settings.anthropicBaseUrl) providerUrls.push(settings.anthropicBaseUrl);
    return getAllowedHosts(providerUrls);
  } catch {
    return getAllowedHosts();
  }
}

export async function executeTool(
  name: string,
  input: any,
  cwd: string,
  signal?: AbortSignal,
  convId?: string,
): Promise<ToolExecResult> {
  try {
    // 归一化工具名（如 AskUserQuestion → AskUser），覆盖所有调用方
    const canonical = normalizeToolName(name);
    switch (canonical) {
      case 'Desktop': { const { runDesktopTool } = await import('./desktop-tool'); return await runDesktopTool(cwd, convId, input, signal); }
      case 'Browser': { const {runBrowserAgent}=await import('./browser-agent'); return {result:JSON.stringify(await runBrowserAgent(cwd,convId,input,signal))}; }
      case 'Plugin': { const {pluginTool}=await import('./plugins'); return {result:JSON.stringify(await pluginTool(cwd,input))}; }
      case 'Read':
        return await execRead(input, cwd);
      case 'Write':
        return await execWrite(input, cwd);
      case 'Edit':
        return await execEdit(input, cwd);
      case 'Glob':
        return await execGlob(input, cwd);
      case 'Grep':
        return await execGrep(input, cwd);
      case 'Bash': {
        const before=await snapshotToolFiles(cwd);
        const result=await execBash(input,cwd,signal);
        result.fileChanges=await finishToolFiles(before);
        return result;
      }
      case 'WebFetch':
        return await execWebFetch(input, cwd);
      case 'Skill':
        return await execSkill(input, cwd);
      case 'SaveMemory':
        return await execSaveMemory(input, cwd, convId);
      case 'RecallMemory':
        return await execRecallMemory(input, cwd, convId);
      default:
        return { result: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err: any) {
    auditDeny(name==='WebFetch'?'net':name==='Bash'?'bash':'tool',name,{reason:err?.message??String(err),url:input?.url,command:input?.command,path:input?.file_path},{projectPath:cwd,convId});
    return { result: `Tool execution error: ${err?.message ?? String(err)}`, isError: true };
  }
}

// ─── Read ────────────────────────────────────────────────────────────────
async function execRead(input: any, cwd: string): Promise<ToolExecResult> {
  const limits = runtimeConfig((await readSettings()).runtimeConfig);
  const maxReadBytes = limits.maxFileReadBytes;
  const filePath = String(input?.file_path ?? '').trim();
  if (!filePath) return { result: 'file_path is required', isError: true };

  // Sandbox: deny 敏感路径 + 强制在项目内
  if (isDeniedRead(filePath)) {
    auditDeny('fs', 'Read', { path: filePath, reason: '敏感路径拒绝读取' }, { projectPath: cwd });
    return { result: `Sandbox: 禁止读取敏感路径: ${filePath}`, isError: true };
  }
  let abs: string;
  try {
    abs = enforceInsideProject(filePath, cwd, true);
  } catch (e: any) {
    auditDeny('fs', 'Read', { path: filePath, reason: e?.message }, { projectPath: cwd });
    return { result: `Sandbox: ${e?.message ?? 'path not allowed'}`, isError: true };
  }
  auditAllow('fs', 'Read', { path: filePath }, { projectPath: cwd });

  const rel = toRelative(filePath, cwd);

  const st = await fs.stat(abs);
  if (!st.isFile()) return { result: `Not a file: ${filePath}`, isError: true };

  const buf = await fs.readFile(abs);
  const truncatedBytes = buf.length > maxReadBytes;
  const text = (truncatedBytes ? buf.subarray(0, maxReadBytes) : buf).toString('utf-8');

  const lines = text.split('\n');
  const offset = Math.max(1, Number(input?.offset) || 1);
  const limit = Math.max(1, Number(input?.limit) || lines.length);
  const start = offset - 1;
  const end = Math.min(lines.length, start + limit);

  const numbered: string[] = [];
  for (let i = start; i < end; i++) {
    numbered.push(`${String(i + 1).padStart(6, ' ')}\t${lines[i]}`);
  }
  let out = numbered.join('\n');
  if (truncatedBytes) out += `\n\n[file truncated at ${maxReadBytes} bytes]`;
  return { result: out };
}

// ─── Write ───────────────────────────────────────────────────────────────
async function execWrite(input: any, cwd: string): Promise<ToolExecResult> {
  const filePath = String(input?.file_path ?? '').trim();
  const content = String(input?.content ?? '');
  if (!filePath) return { result: 'file_path is required', isError: true };

  // Sandbox: deny 后门路径 + 强制在项目内
  if (isDeniedWrite(filePath)) {
    auditDeny('fs', 'Write', { path: filePath, reason: '后门路径拒绝写入' }, { projectPath: cwd });
    return { result: `Sandbox: 禁止写入后门路径: ${filePath}`, isError: true };
  }
  let abs: string;
  try {
    abs = enforceInsideProject(filePath, cwd);
  } catch (e: any) {
    auditDeny('fs', 'Write', { path: filePath, reason: e?.message }, { projectPath: cwd });
    return { result: `Sandbox: ${e?.message ?? 'path not allowed'}`, isError: true };
  }
  auditAllow('fs', 'Write', { path: filePath }, { projectPath: cwd });

  const rel = toRelative(filePath, cwd);

  const before=await fs.readFile(abs,'utf-8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf-8');
  return { result: `File written: ${rel} (${content.length} chars)`,fileChanges:[{path:rel,...changedLines(before,content)}] };
}

// ─── Edit ────────────────────────────────────────────────────────────────
async function execEdit(input: any, cwd: string): Promise<ToolExecResult> {
  const filePath = String(input?.file_path ?? '').trim();
  const oldString = String(input?.old_string ?? '');
  const newString = String(input?.new_string ?? '');
  const replaceAll = Boolean(input?.replace_all);

  if (!filePath) return { result: 'file_path is required', isError: true };
  if (!oldString) return { result: 'old_string is required and must be non-empty', isError: true };

  // Sandbox: deny 后门路径 + 强制在项目内
  if (isDeniedWrite(filePath)) {
    auditDeny('fs', 'Edit', { path: filePath, reason: '后门路径拒绝写入' }, { projectPath: cwd });
    return { result: `Sandbox: 禁止写入后门路径: ${filePath}`, isError: true };
  }
  let abs: string;
  try {
    abs = enforceInsideProject(filePath, cwd);
  } catch (e: any) {
    auditDeny('fs', 'Edit', { path: filePath, reason: e?.message }, { projectPath: cwd });
    return { result: `Sandbox: ${e?.message ?? 'path not allowed'}`, isError: true };
  }
  auditAllow('fs', 'Edit', { path: filePath }, { projectPath: cwd });

  const rel = toRelative(filePath, cwd);

  const content = await fs.readFile(abs, 'utf-8');
  const occurrences = countOccurrences(content, oldString);

  if (occurrences === 0) {
    return { result: `old_string not found in ${rel}`, isError: true };
  }
  if (!replaceAll && occurrences > 1) {
    return {
      result: `old_string appears ${occurrences} times in ${rel}. Use replace_all=true or provide more context to make it unique.`,
      isError: true,
    };
  }

  const updated = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString);

  await fs.writeFile(abs, updated, 'utf-8');
  return { result: `Edited ${rel} (${occurrences} replacement${occurrences > 1 ? 's' : ''})`,fileChanges:[{path:rel,...changedLines(content,updated)}] };
}

// ─── Glob ────────────────────────────────────────────────────────────────
async function execGlob(input: any, cwd: string): Promise<ToolExecResult> {
  const pattern = String(input?.pattern ?? '').trim();
  if (!pattern) return { result: 'pattern is required', isError: true };

  const subPath = String(input?.path ?? '').trim();
  const root = subPath ? safeJoin(cwd, toRelative(subPath, cwd)) : path.resolve(cwd);

  const regex = globToRegex(pattern);
  const matches: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (matches.length >= 500) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (matches.length >= 500) return;
      if (IGNORE_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(cwd, abs);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        if (regex.test(rel)) matches.push(rel);
      }
    }
  }
  await walk(root);
  matches.sort();

  if (matches.length === 0) return { result: `No files matching: ${pattern}` };
  return { result: matches.join('\n') };
}

// ─── Grep ────────────────────────────────────────────────────────────────
async function execGrep(input: any, cwd: string): Promise<ToolExecResult> {
  const pattern = String(input?.pattern ?? '');
  if (!pattern) return { result: 'pattern is required', isError: true };

  const subPath = String(input?.path ?? '').trim();
  const searchRoot = subPath ? safeJoin(cwd, toRelative(subPath, cwd)) : path.resolve(cwd);
  const include = String(input?.include ?? '').trim();

  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (err: any) {
    return { result: `Invalid regex: ${err?.message ?? err}`, isError: true };
  }
  const includeRegex = include ? globToRegex(include) : null;

  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (results.length >= MAX_GREP_RESULTS) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= MAX_GREP_RESULTS) return;
      if (IGNORE_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        const rel = path.relative(cwd, abs);
        if (includeRegex && !includeRegex.test(rel)) continue;
        try {
          const st = await fs.stat(abs);
          if (st.size > 5 * 1024 * 1024) continue; // skip >5MB files
          const buf = await fs.readFile(abs);
          if (looksBinaryBuffer(buf.subarray(0, 512))) continue;
          const text = buf.toString('utf-8');
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= MAX_GREP_RESULTS) break;
            if (regex.test(lines[i])) {
              results.push(`${rel}:${i + 1}:${lines[i]}`);
            }
          }
        } catch {
          /* ignore unreadable files */
        }
      }
    }
  }
  await walk(searchRoot);

  if (results.length === 0) return { result: `No matches for: ${pattern}` };
  const capped = results.length >= MAX_GREP_RESULTS;
  return { result: results.join('\n') + (capped ? `\n\n[capped at ${MAX_GREP_RESULTS} results]` : '') };
}

// ─── Bash ────────────────────────────────────────────────────────────────
async function execBash(input: any, cwd: string, signal?: AbortSignal): Promise<ToolExecResult> {
  const limits = runtimeConfig((await readSettings()).runtimeConfig);
  const maxOutputBytes = limits.maxToolOutputBytes;
  const command = String(input?.command ?? '').trim();
  if (!command) return { result: 'command is required', isError: true };

  const executionMode = await consumeCommand(input, cwd);
  auditAllow('bash', 'Bash', { command, reason:'执行边界检查：授权凭据已验证，执行模式='+executionMode }, { projectPath: cwd });

  let timeout = Number(input?.timeout) || DEFAULT_BASH_TIMEOUT;
  timeout = Math.max(1, Math.min(timeout, MAX_BASH_TIMEOUT));

  const runtime = await prepareRuntime(cwd, command, executionMode, buildSandboxEnv(cwd), await commandPolicy(cwd), input.__sageNetworkEndpoints);
  try {
    if (signal?.aborted) return { result: '操作已取消', isError: true };
    return await new Promise<ToolExecResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let failure = '';
      let settled = false;
      const child = spawn(runtime.file, runtime.args, {
        cwd, env: runtime.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stop = () => {
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group exited */ } }
      };
      const cancel = () => { failure = '操作已取消'; stop(); };
      signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => { failure = `command timed out after ${timeout}ms`; stop(); }, timeout);
      const finish = (code: number | null, error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        stop(); // Do not leave background descendants after the command completes.
        const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
        const reason = failure || error || (code !== 0 ? `command exited with code ${code}` : '');
        const networkHint = reason && /(?:network|connect|resolve|ENOTFOUND|ECONN|EAI_AGAIN|operation not permitted)/i.test(output) && executionMode !== 'project-network' && executionMode !== 'full' ? '\n[Networking is disabled in this sandbox. If this operation needs networking, request Bash with network=true, networkTargets=[{host,port}] and networkReason describing destinations and data; do not bypass a denial. Approval keeps filesystem restrictions.]' : '';
        resolve({ result: (output || '(no output)') + (reason ? `\n\n[${reason}]` : '') + networkHint, isError: !!reason });
      };
      const collect = (data: Buffer, isStderr: boolean) => {
        const remaining = maxOutputBytes - stdout.length - stderr.length;
        const text = data.toString();
        if (isStderr) stderr += text.slice(0, Math.max(0, remaining));
        else stdout += text.slice(0, Math.max(0, remaining));
        if (text.length > remaining) { failure = 'output limit exceeded'; stop(); }
      };
      child.stdout.on('data', data => collect(data, false));
      child.stderr.on('data', data => collect(data, true));
      child.once('error', error => finish(null, error.message));
      child.once('close', code => finish(code));
      if (signal?.aborted) cancel();
    });
  } finally { await runtime.cleanup(); }
}

// ─── WebFetch ────────────────────────────────────────────────────────────
async function execWebFetch(input: any, cwd?: string): Promise<ToolExecResult> {
  const limits = runtimeConfig((await readSettings()).runtimeConfig);
  const maxOutputBytes = limits.maxToolOutputBytes;
  const url = String(input?.url ?? '').trim();
  if (!url) return { result: 'url is required', isError: true };
  if (!/^https?:\/\//i.test(url)) {
    return { result: 'Only http:// or https:// URLs are allowed', isError: true };
  }

  // Sandbox: 网络出口域名白名单
  const allowedHosts = await resolveAllowedHosts();
  const urlCheck = checkUrl(url, allowedHosts);
  const granted = await consumeWebApproval(input,cwd??'');
  if (!urlCheck.ok && (urlCheck.decision !== 'ask' || !granted)) {
    auditDeny('net', 'WebFetch', { url, reason: urlCheck.reason }, { projectPath: cwd });
    return { result: `Sandbox: ${urlCheck.reason}`, isError: true };
  }
  auditAllow('net', 'WebFetch', { url }, { projectPath: cwd });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limits.apiRequestTimeoutMs);
    let target=url;
    let resp: Response;
    try {
      for(let redirects=0;;redirects++){
        resp=await fetch(target,{signal:controller.signal,redirect:'manual'});
        if(![301,302,303,307,308].includes(resp.status))break;
        const location=resp.headers.get('location');
        await resp.body?.cancel();
        if(!location||redirects>=5)throw Error('网页重定向无效或次数过多');
        target=new URL(location,target).href;
        const next=checkUrl(target,allowedHosts);
        if(!next.ok){auditDeny('net','WebFetch',{url:target,reason:next.reason},{projectPath:cwd});throw Error(`重定向目标需要单独审核：${target}；${next.reason}`);}
      }
    } finally {clearTimeout(timer);}


    if (!resp.ok) {
      return { result: `HTTP ${resp.status} ${resp.statusText}`, isError: true };
    }
    const contentType = resp.headers.get('content-type') ?? '';
    const buf = Buffer.from(await resp.arrayBuffer());
    const truncated = buf.length > maxOutputBytes;
    let text = (truncated ? buf.subarray(0, maxOutputBytes) : buf).toString('utf-8');
    if (truncated) text += `\n\n[response truncated at ${maxOutputBytes} bytes]`;
    return { result: `[${contentType}]\n${text}` };
  } catch (err: any) {
    return { result: `Fetch failed: ${err?.message ?? err}`, isError: true };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Convert an absolute or relative path to a project-relative form usable
 * by safeJoin. If the input is absolute and inside cwd, we make it relative.
 * Otherwise pass through so safeJoin can validate/reject.
 */
function toRelative(p: string, cwd: string): string {
  if (path.isAbsolute(p)) {
    const rel = path.relative(cwd, p);
    return rel || '.';
  }
  return p;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while (true) {
    const idx = haystack.indexOf(needle, i);
    if (idx < 0) break;
    n++;
    i = idx + needle.length;
  }
  return n;
}

/**
 * Convert a simple glob pattern to a RegExp.
 * Supported: * (any within segment), ** (any including /), ? (single char),
 * {a,b,c} (alternation), [abc] (char class).
 */
function globToRegex(pattern: string): RegExp {
  // Normalize leading ./
  const p = pattern.replace(/^\.\//, '');
  let re = '';
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (p[i] === '/') i++;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = p.indexOf('}', i);
      if (end < 0) {
        re += '\\{';
      } else {
        const opts = p.slice(i + 1, end).split(',');
        re += '(?:' + opts.map((s) => s.replace(/[.+^$|()\\/]/g, (m) => '\\' + m)).join('|') + ')';
        i = end;
      }
    } else if (c === '[') {
      const end = p.indexOf(']', i);
      if (end < 0) {
        re += '\\[';
      } else {
        re += p.slice(i, end + 1);
        i = end;
      }
    } else if ('.+^$|()\\/'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
    i++;
  }
  return new RegExp('^' + re + '$');
}

function looksBinaryBuffer(buf: Buffer): boolean {
  if (buf.includes(0)) return true;
  let nonText = 0;
  for (const b of buf) {
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 128) continue;
    nonText++;
  }
  return nonText / Math.max(1, buf.length) > 0.3;
}

// ─── Skill ───────────────────────────────────────────────────────────────
async function execSkill(input: any, cwd: string): Promise<ToolExecResult> {
  const name = String(input?.skill_name ?? '').trim();
  if (!name) return { result: 'skill_name is required', isError: true };
  try {
    const r = await readSkill(cwd, name);
    if (!r.ok || !r.content) return { result: r.error ?? 'skill load failed', isError: true };
    return { result: r.content };
  } catch (err: any) {
    return { result: `Failed to load skill: ${err?.message ?? String(err)}`, isError: true };
  }
}

// ─── SaveMemory ──────────────────────────────────────────────────────────
async function execSaveMemory(input: any, cwd: string, convId?: string): Promise<ToolExecResult> {
  const content = String(input?.content ?? '').trim();
  if (!content) return { result: 'content is required', isError: true };
  const tags = Array.isArray(input?.tags)
    ? input.tags.map((t: any) => String(t).trim()).filter(Boolean)
    : [];
  if (tags.length === 0) return { result: 'tags is required (provide 2-5 keywords)', isError: true };
  // conversation 级需要 convId；缺 convId 时降级为项目级，避免写入失败
  const requested = input?.scope === 'user' || input?.scope === 'conversation' ? input.scope : 'project';
  const scope: MemoryScope = requested === 'conversation' && !convId ? 'project' : requested;
  try {
    const { entry, scope: landed, merged, alsoExistsIn } = await addMemory(cwd, content, tags, 'agent', scope, convId);
    // 写入即融合：重复表述不会新增条目，把去向说清楚，避免模型以为没存上再存一遍
    const notes: string[] = [];
    if (merged) notes.push(`merged into existing memory ${merged.id} (scope: ${merged.scope}, folded ${merged.folded} duplicate(s)); newest wording wins`);
    if (alsoExistsIn.length) notes.push(`the same statement also exists at scope: ${[...new Set(alsoExistsIn.map((s) => s.scope))].join(', ')}`);
    return {
      result: `Memory ${merged ? 'merged (no new entry created)' : 'saved'} (id: ${entry.id}, scope: ${landed}, tags: ${entry.tags.join(', ')})${notes.length ? ` — ${notes.join('; ')}` : ''}`,
    };
  } catch (err: any) {
    return { result: `Failed to save memory: ${err?.message ?? String(err)}`, isError: true };
  }
}

// ─── RecallMemory ────────────────────────────────────────────────────────
async function execRecallMemory(input: any, cwd: string, convId?: string): Promise<ToolExecResult> {
  const query = String(input?.query ?? '').trim();
  if (!query) return { result: 'query is required', isError: true };
  const limit = Math.min(20, Math.max(1, Number(input?.limit) || 5));
  try {
    // 三层合并检索（对话 > 项目 > 全局），条目附带所属层级
    const all = await listMemories(cwd, query.split(/[\s,]+/).filter(Boolean), convId);
    if (all.length === 0) return { result: 'No matching memories found.' };
    const entries = all.slice(0, limit).map((e) =>
      `- [${e.scope}][${e.source === 'user' ? 'user' : 'agent'}] ${e.content} (tags: ${e.tags.join(', ')}, updated: ${e.updatedAt.slice(0, 10)})`,
    );
    return { result: `Found ${all.length} memories (showing ${entries.length}):\n\n${entries.join('\n')}` };
  } catch (err: any) {
    return { result: `Failed to recall memories: ${err?.message ?? String(err)}`, isError: true };
  }
}
