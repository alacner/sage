import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
const exec = promisify(execFile);
const mutations = new Set<string>();
const listeners = new Set<() => void>();
export function onGitMutation(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function assertGitRef(ref: string) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-') || /[\x00-\x1f\x7f]/.test(ref)) throw Error('无效的 Git 引用');
}
/** Literal paths, bounded execution and no invisible terminal authentication prompts. */
export async function runGit(root: string, args: string[], timeout = 120_000) {
  return exec('git', ['--no-pager', '--literal-pathspecs', '-c', 'core.quotepath=false', ...args], {
    cwd: root, timeout, maxBuffer: 24 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
  });
}
/** Worktrees share references: lock their common Git directory, not just the UI path. */
export async function withGitMutation<T>(root: string, action: () => Promise<T>): Promise<T> {
  const canonical = await realpath(root);
  const common = (await runGit(canonical, ['rev-parse', '--git-common-dir'])).stdout.trim();
  const key = await realpath(resolve(canonical, common));
  if (mutations.has(key)) throw Error('此仓库已有 Git 操作正在执行，请稍后再试');
  mutations.add(key);
  try { return await action(); }
  finally { mutations.delete(key); for (const notify of listeners) notify(); }
}
