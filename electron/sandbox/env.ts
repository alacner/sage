import { audit } from './audit-log';
/**
 * 环境变量脱敏：构建给 AI 子进程的安全环境。
 *
 * 问题：claude-bridge.ts / api-tool-executor.ts 原先用 `env: { ...process.env }`，
 * 把宿主全部环境变量（含 ANTHROPIC_API_KEY、各云厂 *_TOKEN）下发给 AI 子进程。
 * AI 跑 `env` 即可读走全部密钥。
 *
 * 方案：白名单 + 主动剔除。借鉴 Claude Code 的 subprocessEnv() 函数——
 * 硬编码剥离 20 种密钥变量（比正则匹配更精确，不会误伤 BUILD_KEY 之类）。
 * 用户可在"设置 → 安全"面板覆盖各常量列表。
 */

import { homedir } from 'node:os';
import { readdirSync, statSync } from 'node:fs';
import { getSandboxOverrides } from '../main';

/**
 * 硬编码剥离的密钥环境变量（来自 Claude Code subprocessEnv）。
 * 比正则匹配更精确，不会误伤 BUILD_KEY 之类合法变量。
 * 用户可在"设置 → 安全"面板覆盖。
 */
export const DEFAULT_STRIP_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_BEDROCK_MANTLE_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CLIENT_SECRET',
  'AZURE_CLIENT_CERTIFICATE_PATH',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_RUNTIME_URL',
  'ALL_INPUTS',
  'OVERRIDE_GITHUB_TOKEN',
  'DEFAULT_WORKFLOW_TOKEN',
  'SSH_SIGNING_KEY',
  // Sage 自身鉴权变量（不泄漏给 AI 子进程）
  'SAGE_RELAY_TOKEN',
  'SAGE_RELAY_WEBHOOK_TOKEN',
  'SAGE_ANTHROPIC_API_KEY',
];

/** 兜底：名字匹配这些模式的也剥离（覆盖用户自定义 *_TOKEN / *_API_KEY）。 */
const SECRET_PATTERNS: RegExp[] = [
  /_API_KEY$/i,
  /_TOKEN$/i,
  /_SECRET$/i,
  /_PASSWORD$/i,
  /_PASSWD$/i,
  /_CREDENTIAL/i,
  /_PRIVATE_KEY$/i,
];

/** 必须保留给子进程的环境变量白名单。用户可在"设置 → 安全"面板覆盖。 */
export const DEFAULT_SAFE_ENV_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'PWD',
];

/** PATH 里允许出现的目录前缀（剥掉可能含密钥的私有目录）。用户可在"设置 → 安全"面板覆盖。 */
export const DEFAULT_SAFE_PATH_PREFIXES: string[] = [
  '/bin',
  '/sbin',
  '/usr/bin',
  '/usr/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/opt/homebrew/bin',
  '/opt/homebrew/opt',
  '/opt/homebrew/lib',
  '/usr/lib',
  '/usr/share',
  '/usr/include',
];

/**
 * 构建给 AI 子进程的安全环境（白名单 + 硬剥离）。
 *
 * 用法：
 *   // SDK 模式（env 整体替换子进程环境）
 *   sdkOptions.env = buildSandboxEnv(opts.cwd);
 *   // CLI / Bash 模式
 *   spawn(bin, args, { env: buildSandboxEnv(cwd), ... });
 *
 * 从 sandboxOverrides 缓存读取用户配置，不存在则用默认值。
 *
 * @param projectPath 当前项目路径，用于注入 PWD
 */
export function buildSandboxEnv(projectPath: string): Record<string, string> {
  const overrides = getSandboxOverrides()?.env;
  const stripKeys = overrides?.stripKeys ?? DEFAULT_STRIP_ENV_KEYS;
  const safeKeys = overrides?.safeKeys ?? DEFAULT_SAFE_ENV_KEYS;
  const safePathPrefixes = overrides?.safePathPrefixes ?? DEFAULT_SAFE_PATH_PREFIXES;

  const env: Record<string, string> = {};

  // 1. 白名单注入
  for (const k of safeKeys) {
    const v = process.env[k];
    if (v !== undefined && v !== '') env[k] = v;
  }

  // 2. PATH 重构：过滤现有 PATH + 追加白名单前缀下扫描出的可执行目录。
  //    注意：不能只"过滤"，因为主进程（Dock 启动）的 PATH 很精简，
  //    不含用户自定义路径（如 ~/.nvm）。用户配置的白名单前缀需要
  //    主动扫描出真实可执行目录并追加，否则配置了也用不了。
  env.PATH = buildSafePath(safePathPrefixes);
  env.PWD = projectPath;

  // 3. 双保险：即使白名单漏过，也绝不主动注入任何密钥变量
  const removed=stripKeys.filter(k=>Object.hasOwn(env,k));
  for (const k of stripKeys) { delete env[k]; }
  if(removed.length)audit({ts:new Date().toISOString(),source:'tool',tool:'工具环境',action:'deny',stage:'direct-deny',category:'工具环境',projectPath,detail:{reason:`按规则移除环境变量（不记录值，不代表拒绝整个命令）：${removed.join(', ')}`}});
  for (const k of Object.keys(env)) {
    if (SECRET_PATTERNS.some((re) => re.test(k))) {
      delete env[k];
    }
  }

  return env;
}

// ─── PATH 构建：过滤现有 + 递归扫描白名单前缀 ─────────────────────────────

/** 递归扫描时跳过的大型/无关目录，避免深度遍历耗时过长。 */
const PATH_SCAN_SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.cache', '.Trash',
  'site-packages', 'dist-packages', 'Library', 'share', 'include', 'man',
]);

/** 递归扫描深度上限（覆盖 ~/.nvm/versions/node/vXX/bin 这类 4~5 层结构）。 */
const PATH_SCAN_MAX_DEPTH = 5;
/** 单次扫描最多访问的目录数，防止异常目录导致长时间阻塞。 */
const PATH_SCAN_MAX_DIRS = 2000;

/** 扫描结果缓存：前缀路径 → 找到的可执行目录列表。 */
const pathScanCache = new Map<string, string[]>();
let scanBudget = PATH_SCAN_MAX_DIRS;

/**
 * 递归扫描目录，找出所有包含可执行文件的子目录。
 * 用于把用户配置的宽泛前缀（如 ~/.nvm）展开成真实的 bin 目录。
 */
function findExecutableDirs(dir: string, depth: number): string[] {
  if (depth < 0 || scanBudget <= 0) return [];
  const cached = pathScanCache.get(dir);
  if (cached) return cached;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  scanBudget--;

  const result: string[] = [];
  let hasExecutable = false;
  const subdirs: string[] = [];

  for (const e of entries) {
    // 跳过隐藏目录和已知大型目录，避免无谓的深度遍历
    if (e.name.startsWith('.') || PATH_SCAN_SKIP_DIRS.has(e.name)) continue;
    const full = dir + '/' + e.name;
    if (e.isFile()) {
      try {
        const st = statSync(full);
        // 任意执行位（0111）存在即视为可执行
        if ((st.mode & 0o111) !== 0) hasExecutable = true;
      } catch { /* ignore */ }
    } else if (e.isDirectory()) {
      subdirs.push(full);
    }
  }

  if (hasExecutable) result.push(dir);
  // 继续向下递归（在深度预算内）
  if (depth > 0) {
    for (const sub of subdirs) {
      result.push(...findExecutableDirs(sub, depth - 1));
    }
  }

  pathScanCache.set(dir, result);
  return result;
}

/**
 * 构建安全 PATH：
 * 1. 从主进程现有 PATH 中过滤出匹配白名单前缀的部分；
 * 2. 对白名单前缀递归扫描，把找到的真实可执行目录追加进来
 *    （这样配置 ~/.nvm 就能自动找到 ~/.nvm/versions/node/vXX/bin）。
 */
function buildSafePath(prefixes: readonly string[]): string {
  const home = homedir();
  const resolvedPrefixes = prefixes.map((pre) =>
    pre.startsWith('~/') ? home + pre.slice(1) : pre,
  );

  // 1. 过滤现有 PATH
  const parts = (process.env.PATH || '').split(':');
  const filtered = parts.filter((p) => {
    if (!p) return false;
    return resolvedPrefixes.some((abs) => p === abs || p.startsWith(abs + '/'));
  });

  // 2. 递归扫描白名单前缀，追加真实可执行目录
  const discovered: string[] = [];
  for (const abs of resolvedPrefixes) {
    discovered.push(...findExecutableDirs(abs, PATH_SCAN_MAX_DEPTH));
  }

  // 合并去重保序
  return Array.from(new Set([...filtered, ...discovered])).join(':');
}
