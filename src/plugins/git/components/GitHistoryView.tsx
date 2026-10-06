import { GitActionDialog, type GitDialogAction } from '../GitActionDialog';
import {RefreshButton} from '../../../components/RefreshButton';
import {CursorMenu} from '../../../components/CursorMenu';
import {formatDateTime,useDateTimeSettings} from '../../../lib/date-time';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Upload, Filter, Check, Tag, Globe, GitBranch, Copy, GitCommit } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { useT } from '../../../i18n';
import { buildGraph, graphRowColumns, laneColor, GraphRow } from './GitGraph';
import { GitCommitDetailView } from '../GitCommitDetailView';
import './GitHistoryView.css';
import '../git-browser.css';
import { copyMarkdown } from '../../../lib/clipboard';
type GitCommit = {
    hash: string;
    parents: string[];
    message: string;
    author: string;
    date: string;
    refs: string[];
};
const ROW_HEIGHT = 28, COLUMN_WIDTH = 14, GRAPH_PAD_L = 10, GRAPH_PAD_R = 2, DOT_RADIUS = 3.2, LINE_WIDTH = 1.6;
const DETAIL_MIN = 120, DETAIL_H_KEY = 'gitHistoryDetailH';
export function GitHistoryView({ path, title }: {
    path?: string;
    title?: string;
}) {
  useDateTimeSettings();
    const t = useT();
    const project = useAppStore(s => s.currentProject);
    const tab = useAppStore(s => s.openTabs.find(t => t.id === s.activeTabId));
    const data = tab?.kind === 'git-history' ? tab.data : undefined;
    const root = path ?? data?.path ?? project?.path;
    // 过滤模式（only）：data.refs 为过滤引用集，按这些引用限定可见提交；
    // 定位模式（非 only）：data.ref 为定位目标，右侧展示全部提交并滚动选中该引用。
    const only = !!data?.only;
    const filterRefs = data?.refs?.length ? data.refs : undefined;
    const locateRef = data?.ref;
    // 工具栏漏斗 / 过滤横幅展示的「相关引用」：过滤集优先，否则回退定位引用
    const refs = filterRefs ?? (locateRef ? [locateRef] : undefined);
    const ref = locateRef ?? filterRefs?.[0];
    // 实际查询：仅过滤模式按 refs 限定，否则查全部（--all）再定位
    const queryRefs = only ? refs : undefined;
    const [commits, setCommits] = useState<GitCommit[]>([]);
    const [selected, setSelected] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [operationBusy, setOperationBusy] = useState(false), [notice, setNotice] = useState(''), [operationError,setOperationError] = useState('');
    const operationRunning = useRef(false);
    const [dialog, setDialog] = useState<{action: GitDialogAction; commit?: string}>();
    const [repository, setRepository] = useState<Awaited<ReturnType<typeof window.api.gitBrowserRefs>>>();
    const [more, setMore] = useState(true);
    const [revision, setRevision] = useState(0);
    // 右键菜单：记录坐标与目标提交哈希
    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; hash: string; message: string } | null>(null);
    useEffect(() => {
      const changed = (event: Event) => { if ((event as CustomEvent).detail === root) setRevision(n => n + 1); };
      window.addEventListener('sage-git-changed', changed);
      return () => window.removeEventListener('sage-git-changed', changed);
    }, [root]);
    // 远程名列表：用于区分远程引用徽章（主进程有 60s 缓存，代价很小）
    const [remotes, setRemotes] = useState<string[]>([]);
    useEffect(() => { let live = true; if (!root)
        return; window.api.gitBrowserRefs(root).then(d => { if (live) {
        setRemotes(d.remotes ?? []); setRepository(d); } }).catch(() => { if (live)
        setRemotes([]); }); return () => { live = false; }; }, [root, revision]);
    const selectedRow = useRef<HTMLDivElement>(null);
    const generation = useRef(0);
    const listRef = useRef<HTMLDivElement>(null);
    const endRef = useRef<HTMLDivElement>(null);
    const loadingPage = useRef(false);
    // 列表 / 详情之间的上下拖拽分割条：详情面板高度（px），null 表示使用默认比例
    const wrapRef = useRef<HTMLDivElement>(null);
    const dragState = useRef<{ startY: number; startH: number } | null>(null);
    const [dragging, setDragging] = useState(false);
    const [detailH, setDetailH] = useState<number | null>(() => {
        const v = Number(localStorage.getItem(DETAIL_H_KEY));
        return v >= DETAIL_MIN ? v : null;
    });
    useEffect(() => {
        const run = ++generation.current;
        loadingPage.current = false;
        let live = true;
        setCommits([]);
        setError('');
        setSelected('');
        if (!root)
            return;
        setBusy(true);
        (async () => { try {
            const target = data?.selectedSha ?? (ref ? (await window.api.gitBrowserCommit(root, ref)).sha : undefined);
            let all: GitCommit[] = [];
            let hasMore = true;
            do {
                const result = await window.api.gitLogGraph(root, { limit: 300, skip: all.length, refs: queryRefs, only });
                if (!live)
                    return;
                if (!result.ok)
                    throw Error(result.error);
                const page = result.commits ?? [];
                all = [...all, ...page];
                hasMore = page.length === 300;
                setCommits(all);
                setMore(hasMore);
            } while (target && !all.some(c => c.hash === target) && hasMore);
            if (live) {
                setSelected(target ?? all[0]?.hash ?? '');
                if (target && !all.some(c => c.hash === target))
                    setError('未找到该引用的提交');
            }
        }
        catch (e) {
            if (live)
                setError(String(e));
        }
        finally {
            if (live)
                setBusy(false);
        } })();
        return () => { live = false; generation.current++; };
    }, [root, ref, only, revision]);
    useEffect(() => { selectedRow.current?.scrollIntoView({ block: 'center' }); if (tab?.kind === 'git-history' && selected)
        useAppStore.setState(s => ({ openTabs: s.openTabs.map(t => t.id === tab.id && t.kind === 'git-history' ? { ...t, data: { ...t.data, selectedSha: selected } } : t) })); }, [selected]);
    // 分割条拖拽：mousemove 实时改详情高度，mouseup 落盘
    useEffect(() => {
        const move = (e: MouseEvent) => {
            const st = dragState.current, wrap = wrapRef.current;
            if (!st || !wrap)
                return;
            const max = wrap.clientHeight - DETAIL_MIN - 20;
            setDetailH(Math.max(DETAIL_MIN, Math.min(max, st.startH + (st.startY - e.clientY))));
        };
        const up = () => {
            if (!dragState.current)
                return;
            dragState.current = null;
            setDragging(false);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            setDetailH(h => { if (h)
                localStorage.setItem(DETAIL_H_KEY, String(h)); return h; });
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        return () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    }, []);
    const startSplitDrag = (e: React.MouseEvent) => {
        const detail = wrapRef.current?.querySelector('.git-history-detail') as HTMLElement | null;
        if (!detail)
            return;
        dragState.current = { startY: e.clientY, startH: detail.getBoundingClientRect().height };
        setDragging(true);
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    };
    const resetSplit = () => { localStorage.removeItem(DETAIL_H_KEY); setDetailH(null); };
    const loadMore = async () => { if (!root || busy || !more || error || loadingPage.current)
        return; const run = generation.current; loadingPage.current = true; setBusy(true); try {
        const result = await window.api.gitLogGraph(root, { limit: 300, skip: commits.length, refs: queryRefs, only });
        if (run !== generation.current)
            return;
        if (!result.ok)
            throw Error(result.error);
        setCommits(old => [...old, ...result.commits]);
        setMore(result.commits.length === 300);
    }
    catch (e) {
        if (run === generation.current)
            setError(String(e));
    }
    finally {
        if (run === generation.current) {
            loadingPage.current = false;
            setBusy(false);
        }
    } };
    useEffect(() => {
        if (busy || !more || error || !root || !listRef.current || !endRef.current) return;
        let live = true;
        const observer = new IntersectionObserver(entries => {
            if (live && entries.some(entry => entry.isIntersecting)) void loadMore();
        }, { root: listRef.current, rootMargin: '0px 0px 240px 0px' });
        observer.observe(endRef.current);
        return () => { live = false; observer.disconnect(); };
    }, [busy, more, error, root, commits.length, ref, only, revision]);
    const selectParent = async (hash: string) => { setSelected(hash); if (commits.some(c => c.hash === hash) || !root || busy)
        return; const run = generation.current; setBusy(true); let all = commits; try {
        let hasMore = more;
        while (hasMore && !all.some(c => c.hash === hash)) {
            const result = await window.api.gitLogGraph(root, { limit: 300, skip: all.length, refs: queryRefs, only });
            if (run !== generation.current)
                return;
            if (!result.ok)
                throw Error(result.error);
            all = [...all, ...result.commits];
            hasMore = result.commits.length === 300;
        }
        setCommits(all);
        setMore(hasMore);
        requestAnimationFrame(() => selectedRow.current?.scrollIntoView({ block: 'center' }));
    }
    catch (e) {
        if (run === generation.current)
            setError(String(e));
    }
    finally {
        if (run === generation.current)
            setBusy(false);
    } };
    const changed = () => { window.dispatchEvent(new CustomEvent('sage-git-changed', { detail: root })); };
    const operation = async (kind: 'fetch' | 'pull' | 'push') => {
      if (!root || operationRunning.current) return;
      if (kind === 'push' && !repository?.branches.find(b => b.current)?.upstream) { setDialog({ action: 'publish' }); return; }
      operationRunning.current = true; setOperationBusy(true); setOperationError(''); setNotice('');
      try {
        const result = kind === 'fetch' ? await window.api.gitBrowserFetch(root) : kind === 'pull' ? await window.api.gitPull(root) : await window.api.gitPush(root);
        setNotice(typeof result === 'string' && result.trim() ? result.trim() : `${kind} ✓`);
      } catch (e) { setOperationError(String(e)); }
      finally { operationRunning.current = false; setOperationBusy(false); changed(); }
    };
    const graph = useMemo(() => buildGraph(commits), [commits]);
    // Global width only reserves a shared scrollable row width; each SVG hugs its own lanes.
    const graphWidth = GRAPH_PAD_L + graph.totalColumns * COLUMN_WIDTH + GRAPH_PAD_R;
    // 清除过滤：回到仓库全部提交（清空 refs 并关 only）
    const clearFilter = () => { if (!tab || tab.kind !== 'git-history')
        return; useAppStore.setState(s => ({ openTabs: s.openTabs.map(x => x.id === tab.id && x.kind === 'git-history' ? { ...x, data: { ...x.data, only: false, refs: undefined, ref: undefined } } : x) })); };
    // 右键菜单：复制哈希 / 检出 / 新建分支
    const handleCtxCopyShort = async () => { if (!ctxMenu) return; try { await copyMarkdown(ctxMenu.hash.slice(0, 7)); } catch { /* ignore */ } setCtxMenu(null); };
    const handleCtxCopyFull = async () => { if (!ctxMenu) return; try { await copyMarkdown(ctxMenu.hash); } catch { /* ignore */ } setCtxMenu(null); };
    const handleCtxCheckout = () => { if (ctxMenu) setDialog({ action: 'checkout', commit: ctxMenu.hash }); setCtxMenu(null); };
    const handleCtxBranch = () => { if (ctxMenu) setDialog({ action: 'branch', commit: ctxMenu.hash }); setCtxMenu(null); };
    return <div ref={wrapRef} className="git-history-view git-browser-history" onClick={() => ctxMenu && setCtxMenu(null)}><header className="git-browser-toolbar"><strong>{title ?? data?.title ?? '提交历史'}</strong><button disabled={busy || operationBusy} onClick={() => void operation('fetch')}><Download size={13}/>Fetch</button><button disabled={busy || operationBusy} onClick={() => void operation('pull')}><Download size={13}/>Pull</button><button disabled={busy || operationBusy} onClick={() => void operation('push')}><Upload size={13}/>Push</button><RefreshButton disabled={busy || operationBusy} aria-label="刷新提交历史" onClick={() => setRevision(n => n + 1)}/></header>{only && refs?.length ? <div className="git-filter-bar"><Filter size={12}/><span>{t('git.filteredBy', { refs: refs.map(r => `'${formatRef(r)}'`).join(', ') })}</span><button className="git-filter-clear" onClick={clearFilter}>{t('git.clearFilter')}</button></div> : null}{error && <p role="alert">{error}</p>}{operationError && <p role="alert">{operationError}</p>}{operationBusy && <p role="status">Git…</p>}{notice && <p role="status" className="git-operation-notice">{notice}</p>}<div ref={listRef} className="git-history-list">{graph.rows.map(row => <div key={row.node.hash} ref={row.node.hash === selected ? selectedRow : undefined} role="button" tabIndex={0} style={{minWidth: Math.max(640, graphWidth + 480)}} className={'git-commit-row ' + (row.node.hash === selected ? 'selected' : '')} onClick={() => setSelected(row.node.hash)} onContextMenu={(e) => { e.preventDefault(); setSelected(row.node.hash); setCtxMenu({ x: e.clientX, y: e.clientY, hash: row.node.hash, message: row.node.message }); }} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setSelected(row.node.hash);
    } }}><svg className="git-graph-svg" width={GRAPH_PAD_L + graphRowColumns(row) * COLUMN_WIDTH + GRAPH_PAD_R} height={ROW_HEIGHT}>{renderRowGraph(row)}</svg><div className="git-commit-summary">{row.node.refs.length ? <div className="git-commit-refs">{row.node.refs.map(r => { const kind = classifyRef(r, remotes); return <span key={r} className={`git-ref git-ref--${kind}`} title={formatRef(r)}>{REF_ICONS[kind]}<span className="git-ref-name">{formatRef(r)}</span></span>; })}</div> : null}<div className="git-commit-message"><CommitSubject message={row.node.message}/></div></div><div className="git-commit-author"><span className="git-author-avatar" style={{ background: authorColor(row.node.author) }}>{(row.node.author.slice(0, 1) || '?').toUpperCase()}</span><span className="git-commit-author-name">{row.node.author}</span></div><div className="git-commit-hash">{row.node.hash.slice(0, 7)}</div><time className="git-commit-time">{formatDateTime(row.node.date)}</time></div>)}{busy ? <p role="status">加载中…</p> : !commits.length && !error ? <p>暂无提交</p> : null}<div ref={endRef} className="git-history-end" aria-hidden="true"/></div><div className={'git-history-splitter' + (dragging ? ' dragging' : '')} role="separator" aria-orientation="horizontal" title="拖拽调整上下高度（双击恢复默认）" onMouseDown={startSplitDrag} onDoubleClick={resetSplit}/><div className="git-history-detail" style={detailH ? { height: detailH } : undefined}>{root && selected ? <GitCommitDetailView key={selected} root={root} sha={selected} onSelectCommit={hash => void selectParent(hash)}/> : <p className="muted">选择提交查看详情</p>}</div>{dialog && root && <GitActionDialog root={root} action={dialog.action} commit={dialog.commit} remotes={remotes} onClose={() => setDialog(undefined)} onDone={changed}/>} {ctxMenu ? <CursorMenu x={ctxMenu.x} y={ctxMenu.y} className="file-tab-context-menu" onMouseDown={(e) => e.stopPropagation()}><button className="ftcm-item" onClick={handleCtxCopyShort}><Copy size={13}/>复制短哈希</button><button className="ftcm-item" onClick={handleCtxCopyFull}><GitCommit size={13}/>复制完整 SHA</button><div className="ftcm-sep"/><button className="ftcm-item" onClick={handleCtxCheckout}><GitBranch size={13}/>检出 / 新建分支到此提交</button><button className="ftcm-item" onClick={handleCtxBranch}><Tag size={13}/>仅新建分支（不切换）</button><div className="ftcm-sep"/><div className="git-ctx-menu-meta"><span className="muted">{ctxMenu.hash.slice(0, 7)}</span><span className="git-ctx-menu-msg">{ctxMenu.message}</span></div></CursorMenu> : null}</div>;
}
/**
 * 格式化引用名称（去掉 HEAD -> 、tag: 等前缀）
 */
function formatRef(ref: string): string {
    return ref.replace(/^HEAD -> /, '').replace(/^tag: /, '');
}
/**
 * 渲染单行图谱：车道垂直线段 + 合并贝塞尔曲线 + 节点圆点
 *
 * 线段只按"穿过本行的车道"绘制，不再无条件连接上一行，避免悬空线段。
 * 精致度对齐 IDEA / gitgraph.js 惯例：圆头线帽消除行间接缝、
 * S 形贝塞尔合并曲线、合并提交用空心环节点、普通提交实心点带底色描边。
 */
function renderRowGraph(row: GraphRow): React.ReactNode {
    const node = row.node;
    const cx = GRAPH_PAD_L + node.column * COLUMN_WIDTH + COLUMN_WIDTH / 2;
    const cy = ROW_HEIGHT / 2;
    const elements: React.ReactNode[] = [];
    for (let i = 0; i < row.lanes.length; i++) {
        const lane = row.lanes[i];
        if (!lane.top && !lane.bottom)
            continue;
        const x = GRAPH_PAD_L + lane.col * COLUMN_WIDTH + COLUMN_WIDTH / 2;
        elements.push(<line key={`l-${i}`} x1={x} y1={lane.top ? 0 : cy} x2={x} y2={lane.bottom ? ROW_HEIGHT : cy} style={{ stroke: laneColor(lane.color) }} strokeWidth={LINE_WIDTH} strokeLinecap="round"/>);
    }
    for (let i = 0; i < row.merges.length; i++) {
        const merge = row.merges[i];
        const fromX = GRAPH_PAD_L + merge.fromCol * COLUMN_WIDTH + COLUMN_WIDTH / 2;
        // 控制点偏向行底，曲线先垂直下行再平滑拐入节点，接近 IDEA 的肘形汇入
        const cpY = cy + (ROW_HEIGHT - cy) * 0.72;
        elements.push(<path key={`m-${i}`} d={`M ${fromX} ${ROW_HEIGHT} C ${fromX} ${cpY}, ${cx} ${cpY}, ${cx} ${cy}`} style={{ stroke: laneColor(merge.color) }} strokeWidth={LINE_WIDTH} strokeLinecap="round" fill="none"/>);
    }
    // 颜色一律走 var() 表达式 → 必须放在 style 里（表现属性不吃 var()，会被整条作废退回黑色）。
    const color = laneColor(node.color);
    const listBg = 'var(--bg-1, #ffffff)';
    if (node.parents.length > 1) {
        // 合并提交：空心环（中心透出列表底色），与 IDEA 一致
        elements.push(<circle key="dot" cx={cx} cy={cy} r={DOT_RADIUS + 0.6} style={{ fill: listBg, stroke: color }} strokeWidth={LINE_WIDTH + 0.2}/>);
    } else {
        elements.push(<circle key="dot" cx={cx} cy={cy} r={DOT_RADIUS} style={{ fill: color, stroke: listBg }} strokeWidth={1}/>);
    }
    return <>{elements}</>;
}
/** 引用徽章类型：当前分支 / 本地分支 / 远程分支 / 标签 */
type RefKind = 'head' | 'branch' | 'remote' | 'tag';
function classifyRef(ref: string, remotes: string[]): RefKind {
    if (ref.startsWith('HEAD -> '))
        return 'head';
    if (ref.startsWith('tag: '))
        return 'tag';
    if (remotes.some(r => ref === r || ref.startsWith(r + '/')))
        return 'remote';
    return 'branch';
}
const REF_ICONS: Record<RefKind, React.ReactNode> = { head: <Check size={10}/>, branch: <GitBranch size={10}/>, remote: <Globe size={10}/>, tag: <Tag size={10}/> };
/** conventional commit 前缀：feat(scope)!: 等，着语义色加粗 */
const CC_RE = /^([a-z]+)(\([^)]*\))?(!?):\s/;
function CommitSubject({ message }: { message: string }) {
    const m = CC_RE.exec(message);
    if (!m)
        return <>{message}</>;
    return <><span className={`git-cc git-cc-${m[1]}`}>{m[1]}{m[2] ?? ''}{m[3] ?? ''}:</span>{' '}{message.slice(m[0].length)}</>;
}
/** 作者头像底色：按名字哈希取色相，同一作者颜色稳定 */
function authorColor(name: string): string {
    let h = 0;
    for (let i = 0; i < name.length; i++)
        h = (h * 31 + name.charCodeAt(i)) % 360;
    return `hsl(${h} 55% 45%)`;
}
