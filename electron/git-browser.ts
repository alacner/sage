import { BoundedCache, payloadWeight } from '../shared/bounded-cache';
import { runGit, withGitMutation, onGitMutation } from './git-runner';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitBranchList, gitStatus } from './git-utils';
import fs from 'node:fs/promises';
import {safeJoin} from './files';
const exec = promisify(execFile);
async function git(root: string, args: string[]) { return (await runGit(root, args)).stdout; }
export async function resolveCommit(root: string, ref: string) {
    if (typeof ref !== 'string' || !ref || ref.startsWith('-') || ref.includes('\0'))
        throw Error('无效引用');
    return (await git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
}
export async function gitBrowserRefs(root: string, force = false) {
    const epoch = refsEpoch;
    const now = Date.now();
    const hit = refsCache.get(root);
    if (hit?.data && !force) {
        // 过期则后台静默刷新（不阻塞返回），下次调用拿到新数据
        if (now - hit.at >= REFS_CACHE_TTL && !hit.inflight) {
            hit.inflight = loadRefs(root).then(data => { if (epoch === refsEpoch) refsCache.set(root, { at: Date.now(), data }); return data; }).catch(() => hit.data).finally(() => { const cur = refsCache.get(root); if (cur)
                cur.inflight = undefined; refsCache.trim(); });
        }
        return hit.data;
    }
    const data = await (hit?.inflight ?? loadRefs(root));
    if (epoch === refsEpoch) refsCache.set(root, { at: Date.now(), data });
    return data;
}
/** refs 缓存：仓库多/分支多时避免每次展开侧栏都跑一遍 git 命令 */
export type RefsSnapshot = Awaited<ReturnType<typeof loadRefs>>;
const refsCache = new BoundedCache<string, { at: number; data: RefsSnapshot; inflight?: Promise<RefsSnapshot> }>(64, 16 * 1024 * 1024, entry => payloadWeight(entry.data), (_key, entry) => !!entry.inflight);
const REFS_CACHE_TTL = 60_000;
let refsEpoch = 0;
async function loadRefs(root: string) {
    // 仓库刚被删除/损坏时给出可读错误，而不是裸抛 git 原始输出
    await git(root, ['rev-parse', '--git-dir']).catch(() => { throw Error(`${root} 不再是有效的 Git 仓库`); });
    // 各命令独立降级：单一失败（如无权限读 stash）不应打挂整个引用面板
    const q = (p: Promise<string>) => p.catch(() => '');
    const [branches, tags, remotes, stashes, modules] = await Promise.all([
        gitBranchList(root).catch(() => [] as Awaited<ReturnType<typeof gitBranchList>>), q(git(root, ['for-each-ref', '--format=%(refname:strip=2)%00%(objectname)', 'refs/tags'])),
        q(git(root, ['remote'])), q(git(root, ['stash', 'list', '--format=%gd%x00%H%x00%gs'])),
        q(git(root, ['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'])),
    ]);
    return { branches, tags: tags.trim().split('\n').filter(Boolean).map(row => { const [name, sha] = row.split('\0'); return { name, sha }; }), remotes: remotes.trim().split('\n').filter(Boolean), stashes: stashes.trim().split('\n').filter(Boolean).map(row => { const [name, sha, subject] = row.split('\0'); return { name, sha, subject }; }), submodules: modules.trim().split('\n').filter(Boolean).map(row => row.slice(row.indexOf(' ') + 1)) };
}
/** 写操作后失效缓存（fetch/pull/push/init 等），下次读取重新扫描 */
export function invalidateRefsCache(root?: string) { refsEpoch++; if (root)
    refsCache.delete(root); else
    refsCache.clear(); }
export async function gitBrowserCommit(root: string, ref: string) {
    if(ref===':working-tree'){
      await git(root,['rev-parse','--git-dir']);
      const status=await gitStatus(root);
      const letters:Record<string,string>={added:'A',untracked:'A',deleted:'D',renamed:'R',copied:'C',conflicted:'U',modified:'M'};
      return {sha:ref,parents:[] as string[],author:'',email:'',date:new Date().toISOString(),subject:'Working tree',body:'',refs:[] as string[],files:status.map(f=>({path:f.path,oldPath:f.origPath,status:letters[f.workTree??f.index??'modified']??'M'})),tree:[] as Array<{path:string;mode:string;type:string;oid:string}>};
    }
    const sha = await resolveCommit(root, ref);
    const info = await git(root, ['show', '-s', '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%b%x00%D', sha]);
    const [hash, parentsText, author, email, date, subject, body, refsText] = info.split('\0');
    const parents = parentsText ? parentsText.split(' ') : [];
    const base = parents[0];
    const changes = (await git(root, ['diff-tree', '--root', '--no-commit-id', '-r', '-M', '--name-status', '-z', ...(base ? [base, sha] : [sha])])).split('\0');
    const files: Array<{
        path: string;
        oldPath?: string;
        status: string;
    }> = [];
    for (let i = 0; i < changes.length && changes[i];) {
        const status = changes[i++];
        const first = changes[i++];
        if (/^[RC]/.test(status))
            files.push({ path: changes[i++], oldPath: first, status: status[0] });
        else
            files.push({ path: first, status: status[0] });
    }
    const tree = (await git(root, ['ls-tree', '-r', '-z', '--full-tree', sha])).split('\0').filter(Boolean).map(row => { const tab = row.indexOf('\t'); const [mode, type, oid] = row.slice(0, tab).split(' '); return { path: row.slice(tab + 1), mode, type, oid }; });
    return { sha: hash, parents, author, email, date, subject, body, refs: (refsText ?? '').trim().split(', ').filter(Boolean), files, tree };
}
export async function gitBrowserFile(root: string, ref: string, file: string, patch = false, base64 = false) {
    if (typeof file !== 'string' || !file || file.includes('\0'))
        throw Error('无效文件');
    if(ref===':working-tree'){
      const abs=safeJoin(root,file);
      const read=async()=>{safeJoin(await fs.realpath(root),await fs.realpath(abs));const stat=await fs.stat(abs);if(stat.size>10*1024*1024)throw Error('文件过大，请在文件标签页查看');return fs.readFile(abs);};
      if(patch){
        const statuses=await gitStatus(root),status=statuses.find(f=>f.path===file);
        if(status?.index==='untracked'||status?.workTree==='untracked'){
          const text=(await read()).toString('utf8');
          if(text.includes('\0'))return{text:'二进制文件，无法显示文本差异',binary:true};
          const lines=text?text.replace(/\n$/,'').split('\n'):[];
          return{text:`--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line=>'+'+line).join('\n')}`,binary:false};
        }
        const hasHead=await resolveCommit(root,'HEAD').then(()=>true,()=>false);
        return{text:await git(root,['diff','--no-ext-diff','--no-textconv',...(hasHead?['HEAD']:['--cached']),'--',file,...(status?.origPath?[status.origPath]:[])]),binary:false};
      }
      const buffer=await read();
      if(base64)return{text:buffer.toString('base64'),binary:true,base64:true};
      const text=buffer.toString('utf8');return{text:text.includes('\0')?'二进制文件':text,binary:text.includes('\0')};
    }
    const sha = await resolveCommit(root, ref);
    if (patch) {
        const parents = (await git(root, ['show', '-s', '--format=%P', sha])).trim().split(' ').filter(Boolean);
        const revisions = parents[0] ? [parents[0], sha] : [sha];
        const changed = (await git(root, ['diff-tree', '--root', '--no-commit-id', '-r', '-M', '--name-status', '-z', ...revisions])).split('\0');
        const paths = [file];
        for (let i = 0; i < changed.length && changed[i];) {
            const status = changed[i++], first = changed[i++];
            if (/^[RC]/.test(status)) {
                const next = changed[i++];
                if (next === file)
                    paths.push(first);
            }
        }
        return { text: await git(root, ['diff-tree', '--root', '--no-commit-id', '-r', '-p', '--no-ext-diff', '--no-textconv', '-M', ...revisions, '--', ...paths]), binary: false };
    }
    const row = (await git(root, ['ls-tree', '-z', sha, '--', file])).split('\0').find(row => row.slice(row.indexOf('\t') + 1) === file);
    if (!row)
        throw Error('该提交中不存在此文件');
    const [mode, type, oid] = row.slice(0, row.indexOf('\t')).split(' ');
    if (type !== 'blob')
        return { text: `Submodule ${oid}`, binary: false };
    const size = Number((await git(root, ['cat-file', '-s', oid])).trim());
    if (size > 2 * 1024 * 1024)
        return { text: `文件过大（${size} 字节），暂不预览`, binary: true };
    // 图片等二进制预览：直接返回 base64（渲染层拼 data URL）
    if (base64) {
        const buf = (await exec('git', ['cat-file', 'blob', oid], { cwd: root, timeout: 30000, maxBuffer: 24 * 1024 * 1024, encoding: 'buffer' })).stdout;
        return { text: buf.toString('base64'), binary: true, base64: true };
    }
    const text = await git(root, ['cat-file', 'blob', oid]);
    return { text: text.includes('\0') ? '二进制文件，无法显示文本差异' : text, binary: text.includes('\0') };
}
export async function gitBrowserFetch(root: string) { await withGitMutation(root, () => git(root, ['fetch', '--all', '--prune'])); return true; }
onGitMutation(() => invalidateRefsCache());
