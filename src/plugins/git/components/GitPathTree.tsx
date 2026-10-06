import { useMemo, useEffect, useRef } from 'react';
import { Folder, File, GitBranch } from 'lucide-react';
type Entry = {
    path: string;
    status?: string;
};
type Node = {
    dirs: Map<string, Node>;
    files: Entry[];
};
export function GitPathTree({ entries, selected, onSelect, branches = false }: {
    entries: Entry[];
    branches?: boolean;
    selected?: string;
    onSelect: (path: string) => void;
}) {
    const selectedRef = useRef<HTMLButtonElement>(null);
    useEffect(() => { selectedRef.current?.scrollIntoView({ block: 'nearest' }); }, [selected]);
    const root = useMemo(() => { const root: Node = { dirs: new Map(), files: [] }; for (const item of entries) {
        let node = root;
        const parts = item.path.split('/');
        parts.pop();
        for (const part of parts) {
            if (!node.dirs.has(part))
                node.dirs.set(part, { dirs: new Map(), files: [] });
            node = node.dirs.get(part)!;
        }
        node.files.push(item);
    } return root; }, [entries]);
    const render = (node: Node, prefix = ''): React.ReactNode => <>{[...node.dirs].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => <details key={name} open><summary><Folder size={14}/>{name}</summary><div className="git-tree-children">{render(child, prefix + name + '/')}</div></details>)}{node.files.map(item => <button ref={selected === item.path ? selectedRef : undefined} key={item.path} className={selected === item.path ? 'selected' : ''} onClick={() => onSelect(item.path)}>{item.status && <span className={`git-status status-${item.status}`}>{item.status}</span>}{branches ? <GitBranch size={13}/> : <File size={13}/>}<span>{item.path.slice(prefix.length)}</span></button>)}</>;
    return <div className="git-path-tree">{render(root)}</div>;
}
