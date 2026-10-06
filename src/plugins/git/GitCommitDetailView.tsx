import {GitWorkingActions} from './GitWorkingActions';
import {formatDateTime,useDateTimeSettings} from '../../lib/date-time';
import { useEffect, useState } from 'react';
import { ExternalLink, ArrowRight, ChevronDown, ChevronRight, Columns2, AlignJustify, File, BookOpen, Image as ImageIcon } from 'lucide-react';
import { appendTab, useAppStore } from '../../stores/appStore';
import { isImageFile, isMarkdownFile, isHtmlFile } from '../../lib/lang';
import { openGitCommit } from './git-tabs';
import { GitPathTree } from './components/GitPathTree';
import { CommitPatch, Code } from './components/CommitPatch';
import './git-browser.css';
type Commit = Awaited<ReturnType<typeof window.api.gitBrowserCommit>>;
type Section = 'commit' | 'changes' | 'tree';
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon' };
const imageDataUrl = (path: string, base64: string) => `data:${IMAGE_MIME[path.toLowerCase().split('.').pop() ?? ''] ?? 'application/octet-stream'};base64,${base64}`;
export function GitCommitDetailView({ sha: propSha, root: propRoot, onSelectCommit }: {
    sha?: string;
    root?: string;
    onSelectCommit?: (sha: string) => void;
}) {
  useDateTimeSettings();
    const tab = useAppStore(s => s.openTabs.find(t => t.id === s.activeTabId));
    const project = useAppStore(s => s.currentProject);
    const data = tab?.kind === 'git-commit' ? tab.data : undefined;
    const sha = propSha ?? data?.sha;
    const working=sha===':working-tree';
    const root = propRoot ?? data?.path ?? project?.path;
    const [commit, setCommit] = useState<Commit>();
    const [error, setError] = useState('');
    const [section, setSection] = useState<Section>(data?.section ?? 'commit');
    const [file, setFile] = useState(data?.file ?? '');
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [revision,setRevision]=useState(0);
    useEffect(()=>{if(!working)return;const changed=()=>setRevision(value=>value+1);window.addEventListener('sage-git-changed',changed);return()=>window.removeEventListener('sage-git-changed',changed);},[working]);
    const [query, setQuery] = useState('');
    const [split, setSplit] = useState(true);
    const [blob, setBlob] = useState<{
        text: string;
        binary: boolean;
        dataUrl?: string;
    }>();
    useEffect(() => { setSection(working?'changes':data?.section ?? 'commit'); setFile(data?.file ?? ''); }, [data?.section, data?.file, working]);
    useEffect(()=>{setCommit(undefined);},[root,sha]);
    useEffect(() => { let live = true; setError(''); setExpanded(new Set()); setBlob(undefined); if (root && sha)
        window.api.gitBrowserCommit(root, sha).then(result => { if (live) {
            setCommit(result);
            setFile(previous => data?.file ?? (result.files.some(item=>item.path===previous)||result.tree.some(item=>item.path===previous)?previous:result.files[0]?.path ?? result.tree[0]?.path ?? ''));
        } }).catch(e => { if (live)
            setError(String(e)); }); return () => { live = false; }; }, [root, sha, data, revision]);
    useEffect(() => { let live = true; setBlob(undefined); if (section === 'tree' && root && sha && file) {
        // 图片文件：取提交内 blob 的 base64 直接渲染预览；其它文件：取文本内容
        if (isImageFile(file))
            window.api.gitBrowserFile(root, sha, file, false, true).then(r => { if (live)
                setBlob({ text: '', binary: false, dataUrl: imageDataUrl(file, r.text) }); }).catch(e => { if (live)
                setBlob({ text: String(e), binary: true }); });
        else
            window.api.gitBrowserFile(root, sha, file).then(result => { if (live)
                setBlob(result); }).catch(e => { if (live)
                setBlob({ text: String(e), binary: true }); });
    } return () => { live = false; }; }, [root, sha, file, section]);
    if (!root || !sha)
        return <p>请选择提交</p>;
    if (error)
        return <p role="alert">{error}</p>;
    if (!commit)
        return <p>加载提交…</p>;
    const change = (path: string) => { setFile(path); setSection('changes'); };
    /** 图片 → 取提交内 blob 的 base64，开只读虚拟 tab 预览 */
    const previewImage = async (path: string) => {
        const sourceTabId = useAppStore.getState().activeTabId;
        try {
            const r = await window.api.gitBrowserFile(root, sha, path, false, true);
            const id = `file:git:${sha.slice(0, 7)}:${path}`;
            useAppStore.setState(s => ({ openTabs: s.openTabs.some(t => t.id === id) ? s.openTabs : appendTab(s.openTabs, { kind: 'file', id, data: { source: 'virtual', readOnly: true, relPath: path, content: '', originalContent: '', binary: true, size: 0, imageData: imageDataUrl(path, r.text) } }, sourceTabId), activeTabId: id }));
        }
        catch (e) {
            useAppStore.setState({ errorBanner: String(e) });
        }
    };
    /** md/html/json 等文本 → 以该提交的 blob 内容开只读虚拟 tab（md/html 支持预览切换） */
    const openBlobInTab = async (path: string) => {
        const sourceTabId = useAppStore.getState().activeTabId;
        try {
            const r = await window.api.gitBrowserFile(root, sha, path);
            if (r.binary) {
                useAppStore.setState({ errorBanner: '二进制文件无法在标签页打开' });
                return;
            }
            const id = `file:git:${sha.slice(0, 7)}:${path}`;
            const view = (isMarkdownFile(path) || isHtmlFile(path)) ? (useAppStore.getState().settings?.markdownDefaultView ?? 'preview') : undefined;
            useAppStore.setState(s => ({ openTabs: s.openTabs.some(t => t.id === id) ? s.openTabs : appendTab(s.openTabs, { kind: 'file', id, data: { source: 'virtual', readOnly: true, relPath: path, content: r.text, originalContent: r.text, binary: false, size: new TextEncoder().encode(r.text).length, view } }, sourceTabId), activeTabId: id }));
        }
        catch (e) {
            useAppStore.setState({ errorBanner: String(e) });
        }
    };
    const files = (section === 'tree' ? commit.tree : commit.files).filter(f => f.path.toLowerCase().includes(query.toLowerCase()));
    return <div className="git-commit-browser"><nav>{((working?['changes']:['commit', 'changes', 'tree']) as Section[]).map(value => <button key={value} className={section === value ? 'selected' : ''} onClick={() => { setSection(value); setQuery(''); if (value === 'tree' && !commit.tree.some(f => f.path === file))
        setFile(commit.tree[0]?.path ?? ''); if (value === 'changes' && !commit.files.some(f => f.path === file))
        setFile(commit.files[0]?.path ?? ''); }}>{value === 'tree' ? 'File Tree' : value === 'commit' ? 'Commit' : 'Changes'}</button>)}<button className="git-open-detail" aria-label="在新标签页打开提交" title="在新标签页打开" onClick={() => openGitCommit(root, commit.sha, commit.subject, section, file)}><ExternalLink size={15}/></button></nav>
 {working&&root&&<GitWorkingActions root={root} file={file}/>}
 {section === 'commit' ? <div className="git-commit-overview"><div className="git-author"><span className="git-avatar">{commit.author.slice(0, 1).toUpperCase()}</span><div><small>AUTHOR</small><p><strong>{commit.author}</strong> <span className="muted">{commit.email}</span></p><time>{formatDateTime(commit.date)}</time></div></div><dl><dt>REFS</dt><dd>{commit.refs.map(ref => <span className="git-ref" key={ref}>{ref}</span>)}</dd><dt>SHA</dt><dd>{commit.sha}</dd><dt>PARENTS</dt><dd>{commit.parents.map(parent => <button key={parent} onClick={() => onSelectCommit ? onSelectCommit(parent) : openGitCommit(root, parent, parent.slice(0, 7))}>{parent.slice(0, 7)}</button>)}</dd></dl><section className="git-message"><h3>{commit.subject}</h3>{commit.body && <pre>{commit.body}</pre>}</section><div className="git-expand-toolbar"><span>{commit.files.length} 个文件</span><button onClick={() => setExpanded(expanded.size === commit.files.length ? new Set() : new Set(commit.files.map(f => f.path)))}>{expanded.size === commit.files.length && expanded.size ? 'Collapse All' : 'Expand All'}</button></div>{commit.files.map(f => <section key={f.path} className="git-inline-file"><header><button onClick={() => setExpanded(old => { const next = new Set(old); next.has(f.path) ? next.delete(f.path) : next.add(f.path); return next; })}>{expanded.has(f.path) ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}<span className={`git-status status-${f.status}`}>{f.status}</span><File size={13}/>{f.path}</button><button className="git-file-diff-btn" aria-label={'查看差异 ' + f.path} title="在 Changes 中查看" onClick={() => change(f.path)}><ArrowRight size={15}/></button>{isImageFile(f.path) ? <button className="git-file-open-btn" aria-label={'预览图片 ' + f.path} title="预览图片" onClick={() => void previewImage(f.path)}><ImageIcon size={14}/></button> : null}</header>{expanded.has(f.path) && <CommitPatch root={root} sha={commit.sha} path={f.path}/>}</section>)}</div> : <><header className="git-selected-meta"><strong>{working?'工作区变更':commit.author}</strong>{!working&&<><code>{commit.sha.slice(0, 7)}</code><time>{formatDateTime(commit.date)}</time><span>{commit.subject}</span></>}</header><div className="git-files-layout"><aside><input aria-label="搜索文件" placeholder="搜索文件…" value={query} onChange={e => setQuery(e.target.value)}/><GitPathTree entries={files} selected={file} onSelect={setFile}/></aside><main><header><File size={13}/><span>{file}</span>{section === 'tree' && file ? (isImageFile(file) ? <button className="git-file-open-btn" aria-label={'预览图片 ' + file} title="预览图片" onClick={() => void previewImage(file)}><ImageIcon size={14}/></button> : (blob && !blob.binary ? <button className="git-file-open-btn" aria-label={'在标签页打开 ' + file} title="在标签页打开" onClick={() => void openBlobInTab(file)}><BookOpen size={14}/></button> : null)) : null}{section === 'changes' && <button aria-label="切换差异布局" title={split ? '统一差异' : '并排差异'} onClick={() => setSplit(!split)}>{split ? <Columns2 size={15}/> : <AlignJustify size={15}/>}</button>}</header>{!file ? <p>没有文件</p> : section === 'changes' ? <CommitPatch key={working?commit.date:undefined} root={root} sha={commit.sha} path={file} split={split} emptyMessage={working?'当前文件已无未提交变更':undefined}/> : blob?.dataUrl ? <div className="git-blob-image"><img src={blob.dataUrl} alt={file}/></div> : blob ? <pre className="git-blob">{blob.binary ? blob.text : <Code text={blob.text} path={file}/>}</pre> : <p>加载文件…</p>}</main></div></>}
 </div>;
}
