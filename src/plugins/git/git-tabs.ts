import { appendTab, useAppStore } from '../../stores/appStore';
/**
 * 打开提交历史标签。
 * - 非过滤（定位）模式：复用同一「全部提交」标签（id 固定 …:all），仅更新定位目标
 *   ref 与标题，右侧展示全部提交并滚动选中该引用指向的提交（对齐 Fork 的点击语义）。
 * - 过滤模式（only）：按 refs 限定可见提交，每个引用集单独一个标签。
 */
export function openGitHistory(path: string, ref?: string, title?: string, opts?: { refs?: string[]; only?: boolean }) {
    const only = !!opts?.only;
    const label = title ?? ref ?? '提交历史';
    if (!only) {
        const id = `git-history:${path}:all`;
        useAppStore.setState(s => {
            const data = { path, ref, refs: undefined, only: false, title: label, selectedSha: undefined };
            const exists = s.openTabs.some(t => t.id === id);
            return {
                openTabs: exists
                    ? s.openTabs.map(t => t.id === id && t.kind === 'git-history' ? { ...t, data: { ...t.data, ...data } } : t)
                    : appendTab(s.openTabs, { kind: 'git-history' as const, id, data }, s.activeTabId),
                activeTabId: id,
            };
        });
        return;
    }
    const refs = [...new Set(opts?.refs?.length ? opts.refs : (ref ? [ref] : []))].sort();
    const id = `git-history:${path}:${refs?.join(' ') ?? ref ?? 'all'}:only`;
    useAppStore.setState(s => {
        const data = { path, ref, refs, only, title: label, selectedSha: undefined };
        return { openTabs: s.openTabs.some(t => t.id === id)
            ? s.openTabs.map(t => t.id === id && t.kind === 'git-history' ? { ...t, data: { ...t.data, ...data } } : t)
            : appendTab(s.openTabs, { kind: 'git-history', id, data }, s.activeTabId), activeTabId: id };
    });
}
export function openGitCommit(path: string, sha: string, title: string, section: 'commit' | 'changes' | 'tree' = 'commit', file?: string) {
    const id = `git-commit:${path}:${sha}`;
    useAppStore.setState(s => {
        const tab = { kind: 'git-commit' as const, id, data: { path, sha, title, section, file } };
        return { openTabs: s.openTabs.some(t => t.id === id)
            ? s.openTabs.map(t => t.id === id ? { ...t, ...tab } : t)
            : appendTab(s.openTabs, tab, s.activeTabId), activeTabId: id };
    });
}
