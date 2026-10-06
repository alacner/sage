import { runGit, withGitMutation } from './git-runner';
import type { GitBranchRequest } from '../shared/git-branch-action';
export async function gitBranchAction(root: string, request: GitBranchRequest): Promise<void> {
  return withGitMutation(root, async () => {
  const git = async (...args: string[]) => (await runGit(root, args)).stdout.trim();
  const valid = (s: unknown): s is string => typeof s === 'string' && !!s && !s.startsWith('-') && !/[\x00-\x20\x7f]/.test(s);
    const { action, branch, remote, name } = request;
    if (action === 'abort-merge') { await git('merge', '--abort'); return; }
    if (action === 'abort-rebase') { await git('rebase', '--abort'); return; }
    if (action === 'continue-rebase') { await git('rebase', '--continue'); return; }
    if (!valid(branch) || typeof remote !== 'boolean') throw Error('无效的分支');
    const ref = `${remote ? 'refs/remotes/' : 'refs/heads/'}${branch}`;
    await git('show-ref', '--verify', ref);
    const current = await git('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '');
    const splitRemote = async (value: string) => {
      const remotes = (await git('remote')).split('\n').sort((a,b) => b.length-a.length);
      const r = remotes.find(r => value.startsWith(r + '/'));
      if (!r) throw Error('找不到远程仓库');
      return [r, value.slice(r.length + 1)];
    };
    const newName = async (kind: 'heads' | 'tags') => {
      if (!valid(name)) throw Error('请输入有效名称');
      await git('check-ref-format', `refs/${kind}/${name}`);
      // check-ref-format --branch additionally rejects reserved branch syntax.
      if (kind === 'heads') await git('check-ref-format', '--branch', name);
      if (await git('show-ref', '--verify', `refs/${kind}/${name}`).then(() => true, () => false)) throw Error(`名称 ${name} 已存在`);
      return name;
    };
    const localOnly = () => { if (remote) throw Error('此操作仅适用于本地分支'); };
    switch (action) {
      case 'checkout': localOnly(); await git('switch', '--no-guess', branch); break;
      case 'track': if (!remote) throw Error('请选择远程分支'); await git('switch', '--track', '-c', await newName('heads'), ref); break;
      case 'create': await git('branch', await newName('heads'), ref); break;
      case 'tag': await git('tag', await newName('tags'), ref); break;
      case 'rename': localOnly(); await git('branch', '-m', branch, await newName('heads')); break;
      case 'delete':
        if (remote) { const [r,b] = await splitRemote(branch); await git('push', r, '--delete', b); }
        else { if (branch === current) throw Error('不能删除当前分支'); await git('branch', '-d', branch); }
        break;
      case 'upstream': localOnly(); if (!valid(name)) throw Error('请选择上游分支'); await git('show-ref', '--verify', `refs/remotes/${name}`); await git('branch', `--set-upstream-to=refs/remotes/${name}`, branch); break;
      case 'unset-upstream': localOnly(); await git('branch', '--unset-upstream', branch); break;
      case 'merge': case 'rebase':
        if (!current || (!remote && branch === current)) throw Error('请选择不同于当前分支的引用');
        await git(action, ...(action === 'merge' ? ['--no-edit'] : []), ref); break;
      case 'pull':
        if (!current) throw Error('请先切换到本地分支');
        if (remote) { const [r,b] = await splitRemote(branch); await git('pull', '--ff-only', r, b); }
        else { if (branch !== current) throw Error('只能拉取当前分支，请使用快进更新其他分支'); await git('pull', '--ff-only'); }
        break;
      case 'push': {
        localOnly();
        const r = await git('config', '--get', `branch.${branch}.remote`);
        const destination = await git('config', '--get', `branch.${branch}.merge`);
        if (!valid(r) || !valid(destination) || !destination.startsWith('refs/heads/')) throw Error('请先配置有效的上游分支');
        await git('push', r, `${ref}:${destination}`); break;
      }
      case 'fast-forward': {
        localOnly();
        const upstream = await git('for-each-ref', '--format=%(upstream)', ref);
        if (!upstream) throw Error('此分支未配置上游');
        if (branch === current) await git('merge', '--ff-only', upstream);
        else await git('fetch', '--no-tags', '.', `${upstream}:${ref}`);
        break;
      }
      default: throw Error('不支持的分支操作');
    }
  });
}
