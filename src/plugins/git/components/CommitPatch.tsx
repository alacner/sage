import { useEffect, useMemo, useState } from 'react';
import Prism from '../../../lib/prism';
import { langInfoFor } from '../../../lib/lang';
type Line = {
    text: string;
    old?: number;
    next?: number;
    kind: string;
};
export function patchLines(patch: string): Line[] { let old = 0, next = 0, inside = false; const out: Line[] = []; for (const text of patch.split('\n')) {
    const match = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (match) {
        old = +match[1];
        next = +match[2];
        inside = true;
        out.push({ text, kind: 'hunk' });
    }
    else if (inside && /^[ +-]/.test(text)) {
        const kind = text[0] === '+' ? 'add' : text[0] === '-' ? 'remove' : 'context';
        out.push({ text: text.slice(1), kind, old: kind === 'add' ? undefined : old++, next: kind === 'remove' ? undefined : next++ });
    }
    else if (text.startsWith('diff --git'))
        inside = false;
} return out; }
export function Code({ text, path }: {
    text: string;
    path: string;
}) { const lang = langInfoFor(path).prism; const grammar = Prism.languages[lang]; return grammar ? <code dangerouslySetInnerHTML={{ __html: Prism.highlight(text, grammar, lang) }}/> : <code>{text}</code>; }
let running = 0;
const waiting: Array<() => void> = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> { if (running >= 4)
    await new Promise<void>(resolve => waiting.push(resolve));
else
    running++; try {
    return await fn();
}
finally {
    const next = waiting.shift();
    if (next)
        next();
    else
        running--;
} }
export function CommitPatch({ root, sha, path, split = false, emptyMessage }: {
    root: string;
    sha: string;
    path: string;
    split?: boolean;
    emptyMessage?: string;
}) {
    const [patch, setPatch] = useState<string>();
    const [error, setError] = useState('');
    useEffect(() => { let live = true; setPatch(undefined); setError(''); void limited(async () => { if (!live)
        return; try {
        const result = await window.api.gitBrowserFile(root, sha, path, true);
        if (live)
            setPatch(result.text);
    }
    catch (e) {
        if (live)
            setError(String(e));
    } }); return () => { live = false; }; }, [root, sha, path]);
    const lines = useMemo(() => patchLines(patch ?? ''), [patch]);
    const pairs = useMemo(() => { const result: Array<[
        Line | undefined,
        Line | undefined
    ]> = []; for (let i = 0; i < lines.length;) {
        const line = lines[i];
        if (line.kind === 'remove' || line.kind === 'add') {
            const removed: Line[] = [], added: Line[] = [];
            while (i < lines.length && lines[i].kind === 'remove')
                removed.push(lines[i++]);
            while (i < lines.length && lines[i].kind === 'add')
                added.push(lines[i++]);
            for (let j = 0; j < Math.max(removed.length, added.length); j++)
                result.push([removed[j], added[j]]);
        }
        else {
            result.push([line, line]);
            i++;
        }
    } return result; }, [lines]);
    if (error)
        return <p role="alert">{error}</p>;
    if (patch === undefined)
        return <p className="muted">加载差异…</p>;
    if (!lines.length)
        return <pre className="git-patch-empty">{patch.trim() || emptyMessage || '文件内容未变化（重命名或模式变化）'}</pre>;
    return <div className="git-patch-scroll"><table className={`git-patch ${split ? 'split' : ''}`}><tbody>{split ? pairs.map(([left, right], i) => <tr key={i}><td className="line-no">{left?.old}</td><td className={left?.kind}><pre>{left && <Code text={left.text} path={path}/>}</pre></td><td className="line-no">{right?.next}</td><td className={right?.kind}><pre>{right && <Code text={right.text} path={path}/>}</pre></td></tr>) : lines.map((line, i) => <tr key={i} className={line.kind}><td className="line-no">{line.old}</td><td className="line-no">{line.next}</td><td><pre><Code text={line.text} path={path}/></pre></td></tr>)}</tbody></table></div>;
}
