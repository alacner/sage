import { BoundedCache, payloadWeight } from '../shared/bounded-cache';
import { runGit, withGitMutation, assertGitRef, onGitMutation } from './git-runner';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';

const execFileP = promisify(execFile);

export interface GitRepoInfo {
  owner: string;
  repo: string;
  deepwikiUrl: string;
}

export interface GitBranch {
  name: string;
  /** Whether this is the currently checked-out branch. */
  current: boolean;
  /** Whether this is a remote tracking branch (refs/remotes/*). */
  remote: boolean;
  /** Upstream branch name (for local branches with tracking). */
  upstream?: string;
  /** Ahead/behind counts relative to upstream. */
  ahead?: number;
  behind?: number;
  /** Latest commit sha (short). */
  sha?: string;
  /** Latest commit subject. */
  subject?: string;
}

export type FileStatusKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'ignored'
  | 'conflicted';

export interface GitFileStatus {
  /** Relative path in the repository. */
  path: string;
  /** Original path for renamed files. */
  origPath?: string;
  /** Status in the staging area (index). */
  index?: FileStatusKind;
  /** Status in the working tree. */
  workTree?: FileStatusKind;
}

/**
 * Detect the git remote (origin) of a project and extract owner/repo
 * for DeepWiki. Supports GitHub, GitLab, Bitbucket SSH and HTTPS URLs.
 * Returns null if the project is not a git repo or has no origin remote.
 */
export async function detectGitRepo(projectPath: string): Promise<GitRepoInfo | null> {
  try {
    const { stdout } = await execFileP('git', ['remote', 'get-url', 'origin'], {
      cwd: projectPath,
      timeout: 5000,
    });
    const url = stdout.trim();
    if (!url) return null;

    // Match patterns:
    //   git@github.com:owner/repo.git
    //   https://github.com/owner/repo.git
    //   ssh://git@github.com/owner/repo.git
    const match = url.match(
      /(?:github\.com|gitlab\.com|bitbucket\.org)[:/]([^/]+)\/([^/.]+)/,
    );
    if (!match) return null;

    return {
      owner: match[1],
      repo: match[2],
      deepwikiUrl: `https://deepwiki.com/${match[1]}/${match[2]}`,
    };
  } catch {
    // Not a git project, no remote, or git not installed
    return null;
  }
}

/**
 * List all branches (local + remote).
 * Local branches come first, sorted with current branch at the top.
 */
export async function gitBranchList(projectPath: string): Promise<GitBranch[]> {
  const { stdout } = await execFileP('git', [
    'for-each-ref',
    '--format=%(refname)\t%(upstream:short)\t%(objectname:short)\t%(HEAD)\t%(upstream:track)\t%(contents:subject)',
    'refs/heads/', 'refs/remotes/',
  ], { cwd: projectPath, timeout: 10000 });
  const branches: GitBranch[] = stdout.split('\n').filter(Boolean).map(line => {
    const [ref, upstream, sha, head, track, ...subject] = line.split('\t');
    const remote = ref.startsWith('refs/remotes/');
    return { name: ref.slice(remote ? 13 : 11), remote, current: !remote && head === '*',
      upstream: upstream || undefined, sha, subject: subject.join('\t'),
      ahead: Number(track.match(/ahead (\d+)/)?.[1] ?? 0),
      behind: Number(track.match(/behind (\d+)/)?.[1] ?? 0) };
  });

  // Sort: current first, then local (alphabetical), then remote (alphabetical)
  branches.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    if (a.remote !== b.remote) return a.remote ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  return branches;
}

/**
 * Get the currently checked-out branch name, or null if detached/unborn.
 */
export async function gitCurrentBranch(projectPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectPath,
      timeout: 5000,
    });
    const name = stdout.trim();
    return name === 'HEAD' ? null : name;
  } catch {
    return null;
  }
}

/**
 * Checkout (switch to) a branch.
 */
export async function gitCheckout(projectPath: string, branch: string): Promise<void> {
  assertGitRef(branch);
  await withGitMutation(projectPath, async () => {
    const local = await runGit(projectPath, ['show-ref', '--verify', `refs/heads/${branch}`]).then(() => true, () => false);
    const sha = (await runGit(projectPath, ['rev-parse', '--verify', '--end-of-options', `${branch}^{commit}`])).stdout.trim();
    await runGit(projectPath, local ? ['switch', '--no-guess', branch] : ['switch', '--detach', sha]);
  });
}

/**
 * Create a new branch and optionally check it out.
 */
export async function gitBranchCreate(
  projectPath: string,
  name: string,
  opts: { base?: string; checkout?: boolean } = {},
): Promise<void> {
  assertGitRef(name);
  if (opts.base) assertGitRef(opts.base);
  await withGitMutation(projectPath, async () => {
    await runGit(projectPath, ['check-ref-format', '--branch', name]);
    const args = opts.checkout ? ['switch', '-c', name] : ['branch', name];
    if (opts.base) args.push((await runGit(projectPath, ['rev-parse', '--verify', '--end-of-options', `${opts.base}^{commit}`])).stdout.trim());
    await runGit(projectPath, args);
  });
}

/**
 * Delete a branch (local or remote tracking).
 */
export async function gitBranchDelete(
  projectPath: string,
  name: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  assertGitRef(name);
  await withGitMutation(projectPath, async () => {
    const local = await runGit(projectPath, ['show-ref', '--verify', `refs/heads/${name}`]).then(() => true, () => false);
    if (local) { await runGit(projectPath, ['branch', opts.force ? '-D' : '-d', name]); return; }
    const remotes = (await runGit(projectPath, ['remote'])).stdout.trim().split('\n').filter(Boolean).sort((a,b) => b.length-a.length);
    const remote = remotes.find(r => name.startsWith(r + '/'));
    if (!remote) throw Error('找不到本地或远程分支');
    assertGitRef(remote);
    await runGit(projectPath, ['show-ref', '--verify', `refs/remotes/${name}`]);
    await runGit(projectPath, ['push', remote, '--delete', name.slice(remote.length + 1)]);
  });
}

/**
 * Pull the current branch from origin.
 */
export async function gitPull(projectPath: string): Promise<string> {
  return withGitMutation(projectPath, async () => {
    const result = await runGit(projectPath, ['pull', '--ff-only']);
    return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  });
}

/**
 * Push the current branch to origin.
 */
/** git push 参数组装（纯函数，便于测试）：setUpstream 先建轨道，forceWithLease 用安全强推 */
export function pushArgs(opts: { setUpstream?: boolean; forceWithLease?: boolean; remote?: string } = {}): string[] {
  const args = ['push'];
  if (opts.setUpstream) args.push('-u', opts.remote ?? 'origin', 'HEAD');
  if (opts.forceWithLease) args.push('--force-with-lease');
  return args;
}

/**
 * 分支前缀应用（纯函数）：配置了前缀（如 'codex/'）时，新建分支名自动补齐。
 * 不叠加的情形：名称已带该前缀，或名称自带命名空间（含 '/'，视为显式指定）。
 */
export function applyBranchPrefix(name: string, prefix?: string): string {
  const p = String(prefix ?? '').trim().replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  if (!p) return name;
  const full = `${p}/`;
  if (name.startsWith(full) || name.includes('/')) return name;
  return `${full}${name}`;
}

export async function gitPush(
  projectPath: string,
  opts: { setUpstream?: boolean; forceWithLease?: boolean; remote?: string } = {},
): Promise<string> {
  return withGitMutation(projectPath, async () => {
    if (opts.remote) {
      assertGitRef(opts.remote);
      const remotes = (await runGit(projectPath, ['remote'])).stdout.trim().split('\n');
      if (!remotes.includes(opts.remote)) throw Error('找不到所选远程仓库');
    }
    const result = await runGit(projectPath, pushArgs(opts));
    return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  });
}

/**
 * Parse `git status --porcelain=v1 -z` into a structured file status list.
 */
export async function gitStatus(projectPath: string): Promise<GitFileStatus[]> {
  let stdout: string;
  try {
    const r = await execFileP('git', ['status', '--porcelain=v1', '-z', '-u'], {
      cwd: projectPath,
      timeout: 10000,
      maxBuffer: 10 * 1024 * 1024,
    });
    stdout = r.stdout;
  } catch (error) {
    throw error;
  }

  // Porcelain v1 with -z: entries are separated by NUL, renames have
  // "XY newPath\0origPath\0". Otherwise "XY path\0".
  const result: GitFileStatus[] = [];
  const entries = stdout.split('\0');
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];
    if (!entry) {
      i++;
      continue;
    }
    const xy = entry.slice(0, 2);
    const x = xy[0] ?? ' ';
    const y = xy[1] ?? ' ';
    const conflict = ['DD','AU','UD','UA','DU','AA','UU'].includes(xy);
    let path = entry.slice(3);

    // Rename / copy have an extra NUL-separated original path
    if ((x === 'R' || y === 'R' || x === 'C' || y === 'C') && i + 1 < entries.length) {
      const origPath = entries[++i];
      result.push({
        path,
        origPath,
        index: conflict ? 'conflicted' : mapStatusCode(x),
        workTree: conflict ? 'conflicted' : mapStatusCode(y),
      });
    } else {
      result.push({
        path,
        index: conflict ? 'conflicted' : mapStatusCode(x),
        workTree: conflict ? 'conflicted' : mapStatusCode(y),
      });
    }
    i++;
  }
  return result;
}

function mapStatusCode(code: string): FileStatusKind | undefined {
  switch (code) {
    case ' ': return undefined;
    case 'M': return 'modified';
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case '?': return 'untracked';
    case '!': return 'ignored';
    case 'U': return 'conflicted';
    default: return undefined;
  }
}

/**
 * Stage specific files (add to index).
 */
export async function gitStage(projectPath: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await withGitMutation(projectPath, async () => {
    const status = await gitStatus(projectPath);
    const expanded = [...new Set([...paths, ...status.filter(file => paths.includes(file.path) && file.origPath).map(file => file.origPath!)])];
    await runGit(projectPath, ['add', '--', ...expanded]);
  });
}

/**
 * Unstage specific files (reset in index, keep working tree changes).
 */
export async function gitUnstage(projectPath: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await withGitMutation(projectPath, async () => {
    const status = await gitStatus(projectPath);
    paths = [...new Set([...paths, ...status.filter(file => paths.includes(file.path) && file.origPath).map(file => file.origPath!)])];
    const hasHead = await runGit(projectPath, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false);
    await runGit(projectPath, hasHead ? ['reset', 'HEAD', '--', ...paths] : ['rm', '--cached', '-r', '-f', '--', ...paths]);
  });
}

/**
 * Create a commit with the staged changes.
 */
export async function gitCommit(
  projectPath: string,
  message: string,
): Promise<string> {
  if (!message.trim()) throw Error('请输入提交说明');
  return withGitMutation(projectPath, async () => {
    const result = await runGit(projectPath, ['commit', '-m', message]);
    return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  });
}

/**
 * Get a unified diff between two refs (or working tree if ref2 is omitted).
 */
export async function gitDiff(
  projectPath: string,
  ref1?: string,
  ref2?: string,
): Promise<string> {
  for (const ref of [ref1, ref2]) if (ref) assertGitRef(ref);
  const args = ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv'];
  if (ref1 && ref2) {
    args.push(ref1, ref2);
  } else if (ref1) {
    args.push(ref1);
  }
  const { stdout } = await execFileP('git', args, {
    cwd: projectPath,
    timeout: 30000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Get a unified diff for a specific file between two refs.
 */
export async function gitFileDiff(
  projectPath: string,
  filePath: string,
  ref1?: string,
  ref2?: string,
): Promise<string> {
  for (const ref of [ref1, ref2]) if (ref) assertGitRef(ref);
  const args = ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv'];
  if (ref1 && ref2) args.push(ref1, ref2);
  else if (ref1) args.push(ref1);
  args.push('--', filePath);
  const { stdout } = await execFileP('git', args, {
    cwd: projectPath,
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Get the list of files changed between two refs.
 */
export async function gitDiffNameOnly(
  projectPath: string,
  ref1?: string,
  ref2?: string,
): Promise<string[]> {
  for (const ref of [ref1, ref2]) if (ref) assertGitRef(ref);
  const args = ['diff', '--name-only', '-z'];
  if (ref1 && ref2) args.push(ref1, ref2);
  else if (ref1) args.push(ref1);
  const { stdout } = await execFileP('git', args, {
    cwd: projectPath,
    timeout: 30000,
  });
  return stdout.split('\0').filter(Boolean);
}

/**
 * Get recent commit log (for history view).
 * Supports filtering by file/directory path.
 */
export async function gitLog(
  projectPath: string,
  opts: { limit?: number; ref?: string; path?: string; skip?: number } = {},
): Promise<Array<{ sha: string; subject: string; author: string; date: string }>> {
  const args = [
    'log',
    `--max-count=${Math.max(1, Math.min(opts.limit ?? 50, 1000))}`,
    `--skip=${Math.max(0, opts.skip ?? 0)}`,
    '--format=%H%x00%s%x00%an%x00%aI',
  ];
  if (opts.ref) { assertGitRef(opts.ref); args.push(opts.ref); }
  args.unshift('--literal-pathspecs');
  args.push('--');
  if (opts.path) args.push(opts.path);
  const { stdout } = await execFileP('git', args, {
    cwd: projectPath,
    timeout: 30000,
  });
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject, author, date] = line.split('\0');
      return { sha, subject, author, date };
    });
}

/**
 * Get commit log with graph data (parents, refs) for building branch visualization.
 */
export async function gitLogGraph(
  projectPath: string,
  opts: { limit?: number; ref?: string; refs?: string[]; only?: boolean; path?: string; skip?: number } = {},
): Promise<Array<{ hash: string; parents: string[]; message: string; author: string; date: string; refs: string[] }>> {
  // 正引用列表：refs 优先（分支组等多引用场景），兼容单 ref
  const positives = [...(opts.refs ?? []), ...(opts.ref ? [opts.ref] : [])].filter(Boolean);
  for (const p of positives) if (p.startsWith('-') || p.includes('\0')) throw Error('无效引用');
  const args = [
    'log',
    `--max-count=${Math.max(1,Math.min(opts.limit ?? 100,1000))}`,
    `--skip=${Math.max(0,opts.skip??0)}`,
    '--topo-order',
    '--format=%H%x00%P%x00%s%x00%an%x00%aI%x00%D',
  ];
  // 过滤语义（对齐 Fork）：显示这些引用可达的提交（包含式）。
  // 旧的排他写法（--not --exclude …）会把同时被标签/同名远程指向的提交误排空；
  // only 标志现在仅驱动渲染层横幅/图标，不再改变 log 参数。
  if (positives.length) args.push(...positives);
  else args.push('--all');
  args.unshift('--literal-pathspecs');
  args.push('--');
  if (opts.path) args.push(opts.path);
  const { stdout } = await execFileP('git', args, {
    cwd: projectPath,
    timeout: 30000,
  });
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, parentsStr, message, author, date, refsStr] = line.split('\0');
      const parents = parentsStr ? parentsStr.split(' ') : [];
      const refs = refsStr ? refsStr.split(',').map(r => r.trim()) : [];
      return { hash, parents, message, author, date, refs };
    });
}

/**
 * Get full details of a single commit (for commit detail view).
 * Returns commit info + unified diff.
 */
export async function gitShow(
  projectPath: string,
  sha: string,
): Promise<{ sha: string; subject: string; author: string; date: string; body: string; diff: string }> {
  assertGitRef(sha);
  const resolved = (await runGit(projectPath, ['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`])).stdout.trim();
  const { stdout } = await runGit(projectPath, ['show', '--format=%H%x00%s%x00%an%x00%aI%x00%b%x00', '--no-ext-diff', '--no-textconv', '--patch', resolved, '--']);
  const [hash, subject, author, date, body, ...rest] = stdout.split('\0');
  const diff = rest.join('\0');
  return { sha: hash, subject, author, date, body: body || '', diff };
}

/**
 * Get list of files changed between two refs (or working tree if ref2 is omitted).
 * Returns array of { path, insertions, deletions }.
 */
export async function gitDiffFiles(
  projectPath: string,
  ref1: string,
  ref2?: string,
): Promise<Array<{ path: string; insertions: number; deletions: number }>> {
  for (const ref of [ref1, ref2]) if (ref) assertGitRef(ref);
  const args = ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv'];
  if (ref1) args.push(ref1);
  if (ref2) args.push(ref2);
  args.push('--');
  const {stdout} = await runGit(projectPath,args);
  const records = stdout.split('\0'), files: Array<{path:string;insertions:number;deletions:number}> = [];
  for(let i=0;i<records.length;i++) {
    if(!records[i])continue;
    const match = records[i].match(/^([^\t]+)\t([^\t]+)\t([\s\S]*)$/);
    if(!match)continue;
    let file=match[3];
    if(!file){i++;file=records[++i];}
    if(file)files.push({path:file,insertions:parseInt(match[1],10)||0,deletions:parseInt(match[2],10)||0});
  }
  return files;
}

/** 发现结果中的单个 git 仓库 */
export interface DiscoveredRepo {
  /** 仓库目录绝对路径 */
  path: string;
  /** 目录名（根仓库为项目根目录名） */
  name: string;
  /** 是否就是项目根目录 */
  isRoot: boolean;
  /** 当前分支（解析失败为 null） */
  currentBranch: string | null;
}

/** 仓库扫描跳过的目录（依赖/产物/隐藏目录） */
const SCAN_SKIP_DIRS = new Set([
  'node_modules', 'dist', 'dist-electron', 'release', 'build', 'out', 'coverage', '.cache', 'vendor',
]);

/**
 * 判断目录是否为「可用」git 仓库：仅判断 .git 存在会把损坏/半初始化的 .git
 * （如只有 info/ 目录）误认成仓库，侧栏所有 git 命令随即报错；
 * 改用 rev-parse 真实校验（-C 锚定本目录工作树，不向父仓库穿透）。
 * 文件检查和 Git 子进程均异步执行，避免扫描期间阻塞主进程与侧栏交互。
 */
async function isGitRepoDir(dir: string): Promise<boolean> {
  try {
    await fs.promises.access(path.join(dir, '.git'));
    const { stdout } = await execFileP('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { timeout: 5000 });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * 自动发现项目内的 git 仓库：根目录本身可能是仓库，
 * 也可能一级子目录各自是独立仓库（monorepo 多仓场景）。
 * 根目录尚未初始化时，额外返回 "."，允许直接初始化整个项目。
 * 同时返回「未进行 git 管理」的一级子目录（仅当根目录不是仓库时——
 * 根目录已是仓库时子目录归根仓库管理，不再建议单独 init）。
 */
export async function discoverGitRepos(
  rootPath: string,
): Promise<{ repos: DiscoveredRepo[]; unmanaged: string[] }> {
  const repos: DiscoveredRepo[] = [];
  const unmanaged: string[] = [];
  const rootIsRepo = await isGitRepoDir(rootPath);
  if (rootIsRepo) {
    repos.push({ path: rootPath, name: path.basename(rootPath), isRoot: true, currentBranch: null });
  }
  let entries: fs.Dirent[] = [];
  try {
    entries = await fs.promises.readdir(rootPath, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.') || SCAN_SKIP_DIRS.has(ent.name)) continue;
    const dir = path.join(rootPath, ent.name);
    if (await isGitRepoDir(dir)) {
      repos.push({ path: dir, name: ent.name, isRoot: false, currentBranch: null });
    } else if (!rootIsRepo) {
      unmanaged.push(ent.name);
    }
  }
  if (!rootIsRepo) unmanaged.unshift('.');
  for (const repo of repos) {
    repo.currentBranch = await gitCurrentBranch(repo.path).catch(() => null);
  }
  return { repos, unmanaged };
}

/** 仓库扫描结果缓存：侧栏 Git 页签切换秒开，过期后台静默刷新不阻塞返回 */
type DiscoverResult = { repos: DiscoveredRepo[]; unmanaged: string[] };
const discoverCache = new BoundedCache<string, { at: number; data: DiscoverResult; inflight?: Promise<DiscoverResult> }>(64, 16 * 1024 * 1024, entry => payloadWeight(entry.data), (_key, entry) => !!entry.inflight);
export async function discoverGitReposCached(
  rootPath: string,
  ttlMs: number,
  force = false,
): Promise<DiscoverResult> {
  const now = Date.now();
  const hit = discoverCache.get(rootPath);
  if (hit?.data && !force) {
    if (now - hit.at >= ttlMs && !hit.inflight) {
      hit.inflight = discoverGitRepos(rootPath)
        .then(data => { discoverCache.set(rootPath, { at: Date.now(), data }); return data; })
        .catch(() => hit.data)
        .finally(() => { const cur = discoverCache.get(rootPath); if (cur)
          cur.inflight = undefined; discoverCache.trim(); });
    }
    return hit.data;
  }
  const data = await (hit?.inflight ?? discoverGitRepos(rootPath));
  discoverCache.set(rootPath, { at: Date.now(), data });
  return data;
}
/** 写操作（init 等）后失效扫描缓存，下次读取重新扫描 */
export function invalidateDiscoverCache(root?: string) { if (root)
  discoverCache.delete(root); else
  discoverCache.clear(); }

/**
 * 在指定目录执行 git init。relDir 为相对项目根的子目录（缺省为根目录）；
 * 安全约束：目标必须落在项目根内，防止越权初始化。
 */
export async function gitInit(rootPath: string, relDir?: string): Promise<string> {
  const root = path.resolve(rootPath);
  const target = relDir ? path.resolve(root, relDir) : root;
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('初始化目录必须位于当前项目内');
  }
  const { stdout } = await execFileP('git', ['init'], { cwd: target, timeout: 15000 });
  return stdout.trim();
}

onGitMutation(() => invalidateDiscoverCache());
