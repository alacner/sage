/**
 * 文件作用域强约束：阻止 AI 读取项目外的密钥 / 系统文件，
 * 阻止 AI 写入持久化后门路径（shell rc、git hooks、package.json 钩子）。
 *
 * deny 路径表借鉴 Claude Code 的 scrubSandboxConfig —— 它覆盖了所有
 * 持久化后门路径和密钥存储路径。
 */

import { resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { SandboxOverrides } from '../../shared/types';
import { getSandboxOverrides } from '../main';

/** Sandbox 拒绝错误。 */
export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

/**
 * 绝对不允许 AI 读取的敏感路径前缀（即使审批也不放行）。
 * 借鉴 Claude Code scrubSandboxConfig 的 denyRead 列表。
 * 用户可在"设置 → 安全"面板覆盖。
 */
export const DEFAULT_DENY_READ_PREFIXES: string[] = [
  // 密钥 / 凭证
  '~/.ssh',
  '~/.aws',
  '~/.config/gh',
  '~/.config/git',
  '~/.gnupg',
  '~/.netrc',
  '~/Library/Keychains',
  // 容器/编排 socket（防容器逃逸）
  '/run/docker.sock',
  '/run/containerd/containerd.sock',
  '/run/podman/podman.sock',
  '/run/buildkit/buildkitd.sock',
  '/run/dbus',
  '/run/user',
  // 系统配置
  '/etc',
  '/var',
  '/private/etc',
  '/private/var',
  // 明确拒绝读取 Sage 自身配置（含 API Key）
  '~/Library/Application Support/Sage',
];

/**
 * 绝对不允许 AI 写入的路径（防持久化后门）。
 * 这是 Claude Code 最值得借鉴的部分——它覆盖了所有 shell rc / 包管理器
 * 配置 / git hooks / CI runner 配置，堵死 AI 留后门的路径。
 * 用户可在"设置 → 安全"面板覆盖。
 */
export const DEFAULT_DENY_WRITE_PREFIXES: string[] = [
  // Shell 初始化文件（防注入 alias / PATH 篡改）
  '~/.bashrc',
  '~/.bash_profile',
  '~/.bash_aliases',
  '~/.bash_login',
  '~/.bash_logout',
  '~/.profile',
  '~/.zshrc',
  '~/.zprofile',
  '~/.zshenv',
  '~/.zlogin',
  '~/.zlogout',
  // Claude / Sage 自身配置
  '~/.claude',
  '~/.claude.json',
  '~/Library/Application Support/Sage',
  // Git 全局配置 / hooks
  '~/.gitconfig',
  '~/.config/git',
  // 包管理器配置（npm/yarn/pip 的 token）
  '~/.npmrc',
  '~/.yarnrc',
  '~/.yarnrc.yml',
  '~/.config/pip',
  '~/.pip',
  '~/.bunfig.toml',
  // 密钥目录
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.netrc',
  // 本地 bin / CI runner
  '~/.local/bin',
  '~/runners',
  '~/actions-runner',
  // 系统配置
  '/etc',
  '/var',
  '/private/etc',
  '/private/var',
  // 明确拒绝写入 Sage 自身配置
  '~/Library/Application Support/Sage',
];

/**
 * 路径段黑名单：路径中包含这些段的也拒绝写入（防项目内 git hooks 后门）。
 * 这些是相对路径段，匹配路径中的任何位置（如 /project/.git/hooks/...）。
 * 用户可在"设置 → 安全"面板覆盖。
 */
export const DEFAULT_DENY_WRITE_SEGMENTS: string[] = [
  '.git/hooks',
  '.git/config',
  '.git/info/exclude',
  '.gitmodules',
  '.github/workflows', // CI 配置（可被触发执行）
  'package.json',      // scripts 钩子（npm install 时可被触发）
  'package-lock.json',
  'bunfig.toml',
  // Sage 自身的应用配置/审计面：模型输出可诱导 AI 静默改写这些文件，
  // 形成数据外泄通道（channels）、持久化执行（scheduled）或审计证据篡改（audit/monitor）。
  // 应用自身的写入走主进程内部路径，不经过本策略；.sage/skills 仍开放（对话式建技能是产品设计）。
  '.sage/channels',
  '.sage/scheduled',
  '.sage/audit.log',
  '.sage/monitor',
];

/** 把路径展开为绝对路径（支持 ~ / 相对路径 / 绝对路径）。 */
function expandAndResolve(p: string, cwd?: string): string {
  const s = p.trim();
  if (s === '~') return homedir();
  if (s.startsWith('~/')) return resolve(homedir(), s.slice(2));
  if (s.startsWith('./') || s === '.') return resolve(cwd ?? process.cwd(), s);
  if (!s.startsWith('/')) return resolve(cwd ?? process.cwd(), s);
  return resolve(s);
}

/** 解析前缀（~/ → homedir，./ → cwd，其余原样）。 */
function resolvePrefix(pre: string): string {
  if (pre === '~') return homedir();
  if (pre.startsWith('~/')) return resolve(homedir(), pre.slice(2));
  if (pre.startsWith('./')) return resolve(process.cwd(), pre.slice(2));
  return resolve(pre);
}

/** 判断路径是否落在某个前缀下。 */
function matchesPrefix(absPath: string, prefix: string): boolean {
  const resolved = resolvePrefix(prefix);
  if (absPath === resolved) return true;
  // 目录前缀：子路径（用 sep 避免 /Users/a 匹配 /Users/ab）
  return absPath.startsWith(resolved + sep) || absPath.startsWith(resolved + '/');
}

/** 路径是否绝对不允许 AI 读取（即使审批也不放行）。 */
export function isDeniedRead(p: string, explicit?: SandboxOverrides['fs'], cwd?: string): boolean {
  if (!explicit && getSandboxOverrides()?.runtime?.fullAccess) return false;
  if (!p || !p.trim()) return false;
  const overrides = explicit ?? getSandboxOverrides()?.fs;
  const DENY_READ_PREFIXES = overrides?.denyRead ?? DEFAULT_DENY_READ_PREFIXES;
  const abs = expandAndResolve(p, cwd);
  return DENY_READ_PREFIXES.some((pre) => matchesPrefix(abs, pre));
}

/** 路径是否绝对不允许 AI 写入（防持久化后门）。 */
export function isDeniedWrite(p: string, explicit?: SandboxOverrides['fs'], cwd?: string): boolean {
  if (!explicit && getSandboxOverrides()?.runtime?.fullAccess) return false;
  if (!p || !p.trim()) return false;
  const overrides = explicit ?? getSandboxOverrides()?.fs;
  const DENY_WRITE_PREFIXES = overrides?.denyWrite ?? DEFAULT_DENY_WRITE_PREFIXES;
  const DENY_WRITE_SEGMENTS = overrides?.denyWriteSegments ?? DEFAULT_DENY_WRITE_SEGMENTS;
  const abs = expandAndResolve(p, cwd);
  // 1. 前缀匹配（绝对路径 / ~ 前缀）
  if (DENY_WRITE_PREFIXES.some((pre) => matchesPrefix(abs, pre))) return true;
  // 2. 路径段匹配（项目内相对路径段，如 .git/hooks）
  const normalized = abs.replace(/\\/g, '/');
  return DENY_WRITE_SEGMENTS.some((seg) =>
    normalized === seg ||
    normalized.includes('/' + seg) ||
    normalized.endsWith('/' + seg) ||
    normalized.endsWith('/' + seg + '/'),
  );
}

/**
 * 强制路径在项目目录内（用于 AI 的文件读写工具）。
 * 与 files.ts 的 safeJoin 类似，但抛 SandboxError 并额外检查 deny 表。
 */
export function enforceInsideProject(p: string, projectPath: string, readOnly = false): string {
  if (!p || !p.trim()) throw new SandboxError('path required');
  const root = resolve(projectPath);
  const abs = expandAndResolve(p, projectPath);

  if (getSandboxOverrides()?.runtime?.fullAccess) return abs;
  // 先检查 deny 表（即使路径在项目内也不允许，如 .sage/.. 不会命中，但兜底）
  if (isDeniedRead(abs)) {
    throw new SandboxError(`禁止读取敏感路径: ${p}`);
  }

  if (abs === root || abs.startsWith(root + sep) || (readOnly && isSafeSystemPath(abs))) return abs;
  throw new SandboxError(`路径越出项目目录: ${p}（解析为 ${abs}）`);
}

/**
 * 路径是否在项目目录内（支持相对路径 / ~ / .. 规范化）。
 * 复用自 project-scope.ts 的语义，供 bash-policy 复用。
 */
export function isPathInsideProject(p: string, projectPath: string): boolean {
  if (!p || !p.trim()) return false;
  const root = resolve(projectPath);
  const abs = expandAndResolve(p, projectPath);
  return abs === root || abs.startsWith(root + sep);
}

/**
 * Bash 命令里视为安全的系统路径前缀（只读/解释器位置，
 * 出现在命令里不代表要修改它们，如 `#!/usr/bin/env node`）。
 * 用户可在"设置 → 安全"面板覆盖。
 */
export const DEFAULT_SAFE_SYSTEM_PREFIXES: string[] = [
  '/dev/null',
  '/dev/zero',
  '/dev/stdin',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/tty',
  '/bin/',
  '/sbin/',
  '/usr/bin/',
  '/usr/sbin/',
  '/usr/local/bin/',
  '/usr/local/sbin/',
  '/opt/homebrew/bin/',
  '/opt/homebrew/opt/',
  '/opt/homebrew/lib/',
  '/usr/lib/',
  '/usr/share/',
  '/usr/include/',
];

/** 路径是否是安全的系统只读前缀（bash 命令里出现这些路径是正常的）。 */
export function isSafeSystemPath(p: string, explicit?: SandboxOverrides['fs']): boolean {
  if (!p) return false;
  const overrides = explicit ?? getSandboxOverrides()?.fs;
  const SAFE_SYSTEM_PREFIXES = overrides?.safeSystemPrefixes ?? DEFAULT_SAFE_SYSTEM_PREFIXES;
  const abs = expandAndResolve(p);
  return SAFE_SYSTEM_PREFIXES.some((pre) => {
    // 展开 ~/ 前缀后再匹配（否则用户配置 ~/.nvm/... 永远匹配不上）
    const resolved = resolvePrefix(pre);
    const norm = resolved.replace(/\/$/, '');
    return abs === norm || abs.startsWith(norm + '/');
  });
}

/** Name the exact existing rule for audit output without changing matching semantics. */
export function matchedFileRule(p:string,writing:boolean,explicit?:SandboxOverrides['fs'],cwd?:string):string|undefined {
  const rules=explicit??getSandboxOverrides()?.fs;
  const abs=expandAndResolve(p,cwd);
  const prefix=(writing?(rules?.denyWrite??DEFAULT_DENY_WRITE_PREFIXES):(rules?.denyRead??DEFAULT_DENY_READ_PREFIXES)).find(pre=>matchesPrefix(abs,pre));
  if(prefix!==undefined)return (writing?'fs.denyWrite':'fs.denyRead')+'：'+prefix;
  if(writing){
    const normalized=abs.replace(/\\/g,'/');
    const segment=(rules?.denyWriteSegments??DEFAULT_DENY_WRITE_SEGMENTS).find(seg=>normalized===seg||normalized.includes('/'+seg)||normalized.endsWith('/'+seg)||normalized.endsWith('/'+seg+'/'));
    if(segment!==undefined)return 'fs.denyWriteSegments：'+segment;
  }
}
