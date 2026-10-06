import {RefreshButton} from '../../components/RefreshButton';
import { useBranchActions } from './BranchActions';
import { useEffect, useState, useCallback, useRef, useMemo, type ReactNode } from 'react';
import {PluginSlot} from '../../components/plugins/PluginWorkbench';
import { Folder, ChevronRight, GitBranch, Tag, Archive, FolderGit2, FolderPlus, RefreshCw, Check, Globe, Filter } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useT } from '../../i18n';
import { builtinSettingValue } from '../../../shared/builtin-plugins';
import { openGitHistory } from './git-tabs';
import './git-browser.css';
type Refs = Awaited<ReturnType<typeof window.api.gitBrowserRefs>>;
/** 侧栏 refs 定期自动刷新间隔（主进程另有 60s TTL 缓存，命中缓存时即时返回） */
const REFS_POLL_MS = 60_000;
function Repository({ path, name, isRoot, current, revision }: {
    path: string;
    name: string;
    /** Whether this repository is the selected Sage project's root repository. */
    isRoot: boolean;
    current?: boolean;
    /** 手动刷新代数：变化时强制绕过缓存重新扫描 */
    revision: number;
}) {
    const t = useT();
    const [data, setData] = useState<Refs>();
    const [error, setError] = useState('');
    const [open, setOpen] = useState(!!current);
    const [refreshing, setRefreshing] = useState(false);
    const sequence = useRef(0);
    const load = useCallback((force: boolean) => {
        const request = ++sequence.current;
        let live = true;
        setRefreshing(true);
        window.api.gitBrowserRefs(path, force).then(d => { if (live && request === sequence.current) {
            setData(d);
            setError('');
        } }).catch(e => { if (live && request === sequence.current)
            setError(String(e)); }).finally(() => { if (live && request === sequence.current)
            setRefreshing(false); });
        return () => { live = false; };
    }, [path]);
    useEffect(() => () => { sequence.current++; }, [path]);
    useEffect(() => {
      const changed = (event: Event) => { if (open && (event as CustomEvent).detail === path) load(true); };
      window.addEventListener('sage-git-changed', changed);
      return () => window.removeEventListener('sage-git-changed', changed);
    }, [path, open, load]);
    const actions = useBranchActions(path, data?.branches ?? [], () => load(true));
    // 展开时先读缓存（秒开），过期数据由主进程后台静默刷新
    useEffect(() => { if (!open)
        return; return load(false); }, [open, load]);
    // 手动刷新：强制绕过缓存
    useEffect(() => { if (!open || !revision)
        return; return load(true); }, [revision, open, load]);
    // 定期自动刷新
    useEffect(() => { if (!open)
        return; const id = setInterval(() => load(false), REFS_POLL_MS); return () => clearInterval(id); }, [open, load]);
    // 当前激活的 git-history tab 若处于过滤（only）模式：其涉及引用在侧栏常显漏斗图标
    const activeFilterKey = useAppStore(s => {
        const tb = s.openTabs.find(x => x.id === s.activeTabId);
        if (tb?.kind === 'git-history' && tb.data.path === path && tb.data.only && tb.data.refs?.length)
            return tb.data.refs.join('\u0000');
        return '';
    });
    const activeRefs = useMemo(() => new Set(activeFilterKey ? activeFilterKey.split('\u0000') : []), [activeFilterKey]);
    // 当前激活历史标签「选中」的引用：过滤模式=过滤引用集，定位模式=定位引用；
    // 侧栏对应行显示选中背景（默认无背景，仅选中行高亮）。
    const activeSelectKey = useAppStore(s => {
        const tb = s.openTabs.find(x => x.id === s.activeTabId);
        if (tb?.kind !== 'git-history' || tb.data.path !== path)
            return '';
        if (tb.data.only && tb.data.refs?.length)
            return tb.data.refs.join('\u0000');
        return tb.data.ref ?? '';
    });
    const selectedRefs = useMemo(() => new Set(activeSelectKey ? activeSelectKey.split('\u0000') : []), [activeSelectKey]);
    const rowClass = (refs: string[]) => 'git-ref-row' + (refs.some(r => selectedRefs.has(r)) ? ' git-ref-selected' : '');
    /** 相关引用：本地分支 ↔ 各远程同名分支互相关联（过滤时一并纳入，对齐 Fork） */
    const relatedRefs = (refs: string[]): string[] => {
        if (!data)
            return refs;
        const out = new Set(refs);
        for (const r of refs) {
            if (r.startsWith('refs/heads/')) {
                const name = r.slice('refs/heads/'.length);
                for (const b of data.branches) {
                    if (b.remote && b.name.split('/').slice(1).join('/') === name)
                        out.add(`refs/remotes/${b.name}`);
                }
            } else if (r.startsWith('refs/remotes/')) {
                const name = r.slice('refs/remotes/'.length).split('/').slice(1).join('/');
                if (data.branches.some(b => !b.remote && b.name === name))
                    out.add(`refs/heads/${name}`);
            }
        }
        return [...out];
    };
    /** 漏斗：未选中 = 按相关引用开启过滤；已选中 = 清除当前过滤 */
    const isFilterActive = (refs: string[]) => {
        const related = relatedRefs(refs);
        return related.length > 0 && related.length === activeRefs.size && related.every(r => activeRefs.has(r));
    };
    const toggleFilter = (refs: string[], label: string) => {
        if (isFilterActive(refs)) {
            useAppStore.setState(s => ({ openTabs: s.openTabs.map(x => x.id === s.activeTabId && x.kind === 'git-history' ? { ...x, data: { ...x.data, only: false, refs: undefined, ref: undefined } } : x) }));
            return;
        }
        openGitHistory(path, refs[0], label, { refs: relatedRefs(refs), only: true });
    };
    /** 行内悬停操作：仅显示该引用提交（漏斗）；过滤涉及引用常显高亮 */
    const refActions = (refs: string[], label: string) => {
        const on = isFilterActive(refs);
        const tip = on ? t('git.clearFilter') : t('git.showOnly', { name: label });
        return <span className="git-ref-actions">
            <button className={on ? 'git-filter-on' : undefined} disabled={!refs.length} title={tip} aria-label={tip} aria-pressed={on} onClick={e => { e.preventDefault(); e.stopPropagation(); toggleFilter(refs, label); }}><Filter size={12}/></button>
        </span>;
    };
    const displayName = (b: Refs['branches'][number], remote: boolean) => remote ? b.name.split('/').slice(1).join('/') : b.name;
    const fullRef = (b: Refs['branches'][number], remote: boolean) => `${remote ? 'refs/remotes/' : 'refs/heads/'}${b.name}`;
    interface Node { dirs: Map<string, Node>; leaves: Refs['branches']; }
    const buildTree = (branches: Refs['branches'], remote: boolean) => { const root: Node = { dirs: new Map(), leaves: [] }; for (const b of branches) { const parts = displayName(b, remote).split('/'); let node = root; for (let i = 0; i < parts.length - 1; i++) { if (!node.dirs.has(parts[i]))
        node.dirs.set(parts[i], { dirs: new Map(), leaves: [] }); node = node.dirs.get(parts[i])!; } node.leaves.push(b); } return root; };
    const collectRefs = (node: Node, remote: boolean): string[] => [...node.leaves.map(b => fullRef(b, remote)), ...[...node.dirs.values()].flatMap(child => collectRefs(child, remote))];
    const renderTree = (node: Node, remote: boolean, prefix: string): ReactNode => <>{[...node.dirs].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => <details key={name} open className="git-ref-group"><summary><Folder size={13}/><span className="git-ref-label">{name}</span>{refActions(collectRefs(child, remote), prefix + name)}</summary><div className="git-ref-group-children">{renderTree(child, remote, prefix + name + '/')}</div></details>)}{[...node.leaves].sort((a,b) => a.name.localeCompare(b.name)).map(b => <div key={b.name} className={rowClass([fullRef(b, remote)])}><button {...actions.events(b)} className={"git-ref-row-main" + (b.current ? " git-current-ref" : "")} onClick={() => openGitHistory(path, fullRef(b, remote), b.name)}><>{b.current ? <Check size={13}/> : <GitBranch size={13}/>}</><span className="git-ref-label">{displayName(b, remote).slice(prefix.length)}</span><small>{b.ahead ? `${b.ahead}↑` : ''}{b.behind ? ` ${b.behind}↓` : ''}</small></button>{refActions([fullRef(b, remote)], displayName(b, remote))}</div>)}</>;
    return <>{actions.overlay}<details className="git-repository" open={open} onToggle={e => setOpen(e.currentTarget.open)}><summary><FolderGit2 size={15}/><span className="git-repository-name">{name}</span>{isRoot && <small className="git-repo-root-badge">{t('git.projectRoot')}</small>}{refreshing && <RefreshCw className="git-spin git-repo-refreshing" size={12}/>}</summary>{error ? <p role="alert">{error}</p> : !data ? <p>加载中…</p> : <div className="git-repository-sections">
 <details open><summary>Branches</summary>{renderTree(buildTree(data.branches.filter(b => !b.remote), false), false, '')}</details>
 <details open><summary>Remotes</summary>{data.remotes.map(remote => { const tree = buildTree(data.branches.filter(b => b.remote && b.name.startsWith(remote + '/') && !b.name.endsWith('/HEAD')), true); return <details key={remote} open className="git-ref-group"><summary><Globe size={13}/><span className="git-ref-label">{remote}</span>{refActions(collectRefs(tree, true), remote)}</summary><div className="git-ref-group-children">{renderTree(tree, true, '')}</div></details>; })}</details>
 <details open><summary>Tags</summary>{data.tags.map(tag => <button key={tag.name} className={selectedRefs.has('refs/tags/' + tag.name) ? 'git-ref-selected' : undefined} onClick={() => openGitHistory(path, 'refs/tags/' + tag.name, tag.name)}><Tag size={14}/>{tag.name}</button>)}</details>
 <details><summary>Stashes</summary>{data.stashes.length ? data.stashes.map(stash => <button key={stash.name} onClick={() => openGitHistory(path, stash.sha, stash.name)}><Archive size={14}/>{stash.name} {stash.subject}</button>) : <small>无暂存记录</small>}</details>
 <details open><summary>Submodules</summary>{data.submodules.map(module => <button key={module} onClick={() => openGitHistory(path + '/' + module, undefined, module)}><GitBranch size={14}/>{module}</button>)}</details>
 </div>}</details></>;
}
export function GitSidebarTab() {
    const project = useAppStore(s => s.currentProject);
    const [repos, setRepos] = useState<Array<{
        path: string;
        name: string;
        isRoot: boolean;
    }>>([]);
    const [unmanaged, setUnmanaged] = useState<string[]>([]);
    const [error, setError] = useState('');
    const [revision, setRevision] = useState(0);
    const request = useRef(0);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    /** force=手动刷新（绕缓存）；silent=定时无感更新（不显示 busy 状态） */
    const refresh = useCallback(async (force = false, silent = false) => { if (!project)
        return; const run = ++request.current; if (!silent) { busyRef.current = true; setBusy(true); } setError(''); try {
        const r = await window.api.gitDiscoverRepos(project.path, force);
        if (run !== request.current)
            return;
        if (!r.ok)
            throw Error(r.error);
        setRepos(r.repos ?? []);
        setUnmanaged(r.unmanaged ?? []);
        if (force)
            setRevision(n => n + 1);
    }
    catch (e) {
        if (run === request.current)
            setError(String(e));
    }
    finally {
        if (run === request.current && !silent) { busyRef.current = false; setBusy(false); }
    } }, [project?.path]);
    useEffect(() => { setRepos([]); setUnmanaged([]); void refresh(); return () => { request.current++; }; }, [refresh]);
    // 定时无感更新：间隔取 Git 插件配置项（分钟）；手动刷新进行中跳过
    const scanMinutes = useAppStore(s => builtinSettingValue(s.settings, s.currentProject?.path, 'git', 'scanRefreshMinutes'));
    useEffect(() => { const ms = Math.max(1, Math.floor(Number(scanMinutes) || 10)) * 60_000; const id = setInterval(() => { if (!busyRef.current)
        void refresh(false, true); }, ms); return () => clearInterval(id); }, [scanMinutes, refresh]);
    const init = async (dir: string) => { if (!project)
        return; setBusy(true); try {
        const r = await window.api.gitInit(project.path, dir === '.' ? undefined : dir);
        if (!r.ok)
            throw Error(r.error);
        await refresh(true);
    }
    catch (e) {
        setError(String(e));
    }
    finally {
        setBusy(false);
    } };
    if (!project)
        return <p>请先选择项目</p>;
    return <div className="git-repo-browser">
      <PluginSlot slot="git.toolbar"/>
      <header><strong>Git</strong><RefreshButton aria-label="刷新仓库" disabled={busy} onClick={() => void refresh(true)} loading={busy}/></header>
      {error && <p role="alert">{error}</p>}
      {busy && !repos.length && !error && <p className="git-scan-hint">扫描仓库中…</p>}
      {repos.map((repo, i) => <Repository key={repo.path} {...repo} current={repo.isRoot || i === 0} revision={revision}/>)}
      {!!unmanaged.length && <section>
        <p className="muted">未管理目录</p>
        <details className="git-unmanaged-tree" open key={project.path}>
          <summary className="git-unmanaged">
            <span className="git-unmanaged-name"><ChevronRight className="git-unmanaged-chevron" size={14}/><Folder size={16}/><span>{project.name}</span></span>
            {unmanaged.includes('.') && <button disabled={busy} aria-label={`初始化 ${project.name}`} onClick={e => {e.preventDefault(); e.stopPropagation(); void init('.');}}><FolderPlus size={14}/>初始化</button>}
          </summary>
          <ul className="git-unmanaged-children">
            {unmanaged.filter(dir => dir !== '.').map(dir => <li key={dir}>
              <div className="git-unmanaged">
                <span className="git-unmanaged-name"><Folder size={16}/><span>{dir}</span></span>
                <button disabled={busy} aria-label={`初始化 ${dir}`} onClick={() => void init(dir)}><FolderPlus size={14}/>初始化</button>
              </div>
            </li>)}
          </ul>
        </details>
      </section>}
    </div>;
}
