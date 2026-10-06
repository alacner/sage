import {RefreshButton} from './RefreshButton';
import { AnchoredPopover } from './AnchoredPopover';
import {formatDateTime,useDateTimeSettings} from '../lib/date-time';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText, AlignLeft, Search, FolderPlus, X, FolderOpen, Link2, Check, MoreHorizontal, ChevronDown, ChevronRight, ChevronUp, FilePlus, FolderDown, FolderUp, SortAsc, SortDesc } from 'lucide-react';
import { useAppStore, useActiveFile } from '../stores/appStore';
import { useT, translate } from '../i18n';
import { langInfoFor } from '../lib/lang';
import { confirmDialog } from '../lib/confirm-dialog';
import { useCursorMenuStyle } from '../lib/cursor-menu';
import type { FileEntry, ContentSearchResult } from '../../shared/types';
import { copyMarkdown } from '../lib/clipboard';

/** 格式化文件大小（紧凑格式） */
function formatFileSize(bytes: number | undefined): string {
  if (bytes === undefined) return '-';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 格式化时间（紧凑格式，精确到秒） */
function formatTime(isoStr: string | undefined): string { return formatDateTime(isoStr); }

/** 搜索模式：name = 按文件名，content = 全局内容（grep）。 */
type SearchMode = 'name' | 'content';

export function FileTree() {
  const hiddenDirectories = useAppStore(s=>s.settings?.fileBrowserHiddenDirectories);
  const project = useAppStore((s) => s.currentProject);
  const children = useAppStore((s) => s.fileTreeChildren);
  const loadDir = useAppStore((s) => s.loadDir);
  const refreshTree = useAppStore((s) => s.refreshFileTree);
  const search = useAppStore((s) => s.searchProjectFiles);
  const searchContent = useAppStore((s) => s.searchFileContents);
  const openFile = useAppStore((s) => s.openFile);
  const activeFile = useActiveFile();
  const t = useT();
  useEffect(()=>{void refreshTree();},[hiddenDirectories,refreshTree]);
  // 搜索范围限定（目录右键「作为搜索范围」设置，null = 全项目）
  const searchScope = useAppStore((s) => s.fileTreeSearchScope);
  const setFileTreeSearchScope = useAppStore((s) => s.setFileTreeSearchScope);
  
  // 文件定位（tab 右键「定位文件」）
  const fileToReveal = useAppStore((s) => s.fileToReveal);
  const clearFileToReveal = useAppStore((s) => s.clearFileToReveal);
  const treeRef = useRef<HTMLUListElement>(null);

  const [mode, setMode] = useState<SearchMode>('name');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FileEntry[]>([]);
  const [contentResults, setContentResults] = useState<ContentSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  
  // 文件树菜单状态
  const [menuOpen, setMenuOpen] = useState(false);
  const [sortSubmenuOpen, setSortSubmenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // 排序子菜单 Portal 定位（相对于"排序方式"按钮向左展开）
  const [sortSubmenuPos, setSortSubmenuPos] = useState<React.CSSProperties>({ display: 'none' });
  const { ref: sortMenuRef, style: sortMenuStyle } = useCursorMenuStyle(Number(sortSubmenuPos.left) || 0, Number(sortSubmenuPos.top) || 0, sortSubmenuOpen);
  const sortBtnRef = useRef<HTMLButtonElement>(null);
  
  // 从 store 获取排序状态和相关方法
  const sortBy = useAppStore((s) => s.fileTreeSortBy);
  const sortOrder = useAppStore((s) => s.fileTreeSortOrder);
  const setFileTreeSort = useAppStore((s) => s.setFileTreeSort);
  const expandAllDirs = useAppStore((s) => s.expandAllDirs);
  const collapseAllDirs = useAppStore((s) => s.collapseAllDirs);
  const createFolder = useAppStore((s) => s.createFolder);
  const createFile = useAppStore((s) => s.createFile);
  
  // 点击外部关闭菜单
  useEffect(() => {
    if (!menuOpen && !sortSubmenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      // 如果点击的是 submenu portal（document.body 下），忽略
      if ((target as Element)?.closest?.('.file-tree-submenu-portal')) return;
      if (menuRef.current && !menuRef.current.contains(target)) {
        setMenuOpen(false);
        setSortSubmenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen, sortSubmenuOpen]);

  // 排序子菜单展开时，计算 Portal 定位（在"排序方式"按钮左侧）
  // 使用 requestAnimationFrame 确保在下一帧计算，避免 sortBtnRef.current 为 null
  useLayoutEffect(() => {
    if (!sortSubmenuOpen) {
      setSortSubmenuPos({ display: 'none' });
      return;
    }
    
    const updatePosition = () => {
      if (!sortBtnRef.current) {
        // 如果按钮引用不存在，设置默认位置或隐藏
        setSortSubmenuPos({ display: 'none' });
        return;
      }
      const rect = sortBtnRef.current.getBoundingClientRect();
      setSortSubmenuPos({
        position: 'fixed',
        top: rect.bottom + 4,
        left: rect.left,
        zIndex: 9999,
      });
    };
    
    // 立即计算一次
    updatePosition();
    
    // 监听窗口大小变化，重新计算位置
    window.addEventListener('resize', updatePosition);
    return () => window.removeEventListener('resize', updatePosition);
  }, [sortSubmenuOpen]);
  
  // 创建文件夹处理
  const handleCreateFolder = async () => {
    const name = prompt(translate('ft.promptDir'));
    if (!name || !name.trim()) return;
    const result = await createFolder(name.trim());
    if (!result.ok) {
      alert(translate('ft.mkdirFail', { error: result.error ?? '' }));
    }
    setMenuOpen(false);
  };
  
  // 创建文件处理
  const handleCreateFile = async () => {
    const name = prompt(translate('ft.promptFile'));
    if (!name || !name.trim()) return;
    const result = await createFile(name.trim());
    if (!result.ok) {
      alert(translate('ft.mkfileFail', { error: result.error ?? '' }));
    } else {
      // 打开新创建的文件
      await useAppStore.getState().openFile(name.trim());
    }
    setMenuOpen(false);
  };

  // 跨组件搜索联动：FileEditor 右键菜单触发时注入 query + mode
  // 注意：setMode + setQuery 会在同一帧合并，搜索 effect 只触发一次。
  // 用 ref 防止 pendingSearch 的 effect 和搜索 effect 交叉触发竞态。
  const pendingSearch = useAppStore((s) => s.pendingFileTreeSearch);
  const setPendingSearch = useAppStore((s) => s.setPendingFileTreeSearch);
  useEffect(() => {
    if (pendingSearch) {
      // 先清除旧结果，避免新搜索过程中闪烁显示旧结果
      setResults([]);
      setContentResults(null);
      setMode(pendingSearch.mode);
      setQuery(pendingSearch.query);
      setPendingSearch(null); // 一次性消费
    }
  }, [pendingSearch, setPendingSearch]);

  const onRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshTree();
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (project && !children['']) loadDir('');
  }, [project, children, loadDir]);

  // Reset search when switching projects.
  useEffect(() => {
    setQuery('');
    setResults([]);
    setContentResults(null);
  }, [project?.path]);

  // Debounce search（两种模式共用输入框，防抖 250ms）。
  // 用 ref 维护请求序列号，防止竞态：快速输入时多次请求返回顺序不确定，
  // 只接受最新一次的结果，避免旧响应覆盖新响应导致显示重复/错乱。
  // searchScope 变化时（右键设置/清除搜索范围）也会自动重搜。
  const searchSeqRef = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setContentResults(null);
      return;
    }
    setSearching(true);
    const seq = ++searchSeqRef.current;
    const timer = setTimeout(async () => {
      if (mode === 'name') {
        const r = await search(q, searchScope ?? undefined);
        if (seq !== searchSeqRef.current) return; // 已被新请求取代
        setResults(r);
      } else {
        const r = await searchContent(q, searchScope ?? undefined);
        if (seq !== searchSeqRef.current) return; // 已被新请求取代
        setContentResults(r);
      }
      if (seq === searchSeqRef.current) setSearching(false);
    }, 250);
    return () => clearTimeout(timer);
  }, [query, mode, searchScope, search, searchContent, hiddenDirectories]);

  // 切换模式时若已有查询词，立即用新模式重搜。
  const switchMode = (m: SearchMode) => {
    if (m === mode) return;
    setMode(m);
  };

  // 监听 fileToReveal：滚动到对应文件并高亮
  useEffect(() => {
    if (!fileToReveal) return;
    
    // 目录展开后需要时间加载和渲染，使用轮询重试
    let attempts = 0;
    const maxAttempts = 20; // 最多重试 20 次（每次 100ms，共 2 秒）
    
    const tryReveal = () => {
      const fileNode = document.querySelector(`[data-rel-path="${CSS.escape(fileToReveal)}"]`);
      if (fileNode) {
        // 找到文件节点，滚动并高亮
        fileNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
        fileNode.classList.add('file-tree-reveal-highlight');
        setTimeout(() => {
          fileNode.classList.remove('file-tree-reveal-highlight');
          clearFileToReveal();
        }, 1500);
      } else if (attempts < maxAttempts) {
        // 未找到，重试
        attempts++;
        setTimeout(tryReveal, 100);
      } else {
        // 重试次数用完，清除状态
        console.warn('[FileTree] Failed to reveal file:', fileToReveal);
        clearFileToReveal();
      }
    };
    
    // 首次延迟 100ms 后开始尝试
    setTimeout(tryReveal, 100);
  }, [fileToReveal, children, clearFileToReveal]);

  if (!project) return null;

  const q = query.trim();
  const showingResults = q.length > 0;
  const roots = children[''] ?? [];

  /** 项目根的动作（从前的「空白处右键」菜单）：Finder / 恢复全项目搜索范围。 */
  const openRootInFinder = () => {
    void window.api.openInFinder(project.path);
    setMenuOpen(false);
  };
  const useWholeProjectAsScope = () => {
    // 根 = 整个项目，也就是「没有范围限定」（null），所以这里就是清除限定
    setFileTreeSearchScope(null);
    setMenuOpen(false);
  };

  return (
    <div className="file-tree">
      <div className="file-tree-search">
        {/* 单行布局：[类型切换][搜索框 flex-1][清除/刷新]，搜索框随侧栏宽度伸缩 */}
        <div className="file-tree-search-mode" role="group" aria-label={t('ft.modeAria')}>
          <button
            type="button"
            className={`file-tree-mode-btn ${mode === 'name' ? 'active' : ''}`}
            title={t('ft.modeName')}
            onClick={() => switchMode('name')}
          >
            <FileText size={12} />
          </button>
          <button
            type="button"
            className={`file-tree-mode-btn ${mode === 'content' ? 'active' : ''}`}
            title={t('ft.modeContent')}
            onClick={() => switchMode('content')}
          >
            <AlignLeft size={12} />
          </button>
        </div>
        <input
          type="text"
          placeholder={mode === 'name' ? t('ft.phName') : t('ft.phContent')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        {query ? (
          <button
            className="file-tree-search-clear"
            title={t('ft.clear')}
            onClick={() => setQuery('')}
          >×</button>
        ) : (
          <>
            {/* 文件树操作菜单 */}
            <div className="file-tree-menu-wrapper" ref={menuRef}>
              <button
                className="file-tree-menu-trigger"
                title={t('ft.more')}
                onClick={() => setMenuOpen(!menuOpen)}
              >
                <MoreHorizontal size={14} strokeWidth={2.5} />
              </button>
              {menuOpen && (
                <div className="file-tree-dropdown-menu">
                  {/* 项目根段（以前是“在列表空白处右键”才能拿到）：根目录不是一个 FileNode，
                      没有这一段就没有任何入口能拷项目绝对路径 / 在 Finder 里打开项目。 */}
                  <CopyPathRow
                    items={[
                      { kind: 'name', label: t('ft.projName'), text: project.name, title: t('ft.copyNameTitle', { name: project.name }) },
                      { kind: 'abs', label: t('ft.abs'), text: project.path, title: t('ft.copyAbsTitle', { path: project.path }) },
                    ]}
                  />
                  <div className="file-tree-dropdown-sep" />
                  <button className="file-tree-dropdown-item" onClick={openRootInFinder}>
                    <FolderOpen size={13} />
                    <span>{t('ft.finderOpen')}</span>
                  </button>
                  <button
                    className="file-tree-dropdown-item"
                    title={t('ft.scopeWholeProject', { path: project.path })}
                    onClick={useWholeProjectAsScope}
                  >
                    <Search size={13} />
                    <span>{t('ft.asScope')}</span>
                  </button>
                  <div className="file-tree-dropdown-sep" />
                  {/* 排序规则子菜单 */}
                  <div className="file-tree-dropdown-item file-tree-dropdown-item-with-submenu">
                    <button
                      ref={sortBtnRef}
                      className="file-tree-dropdown-item-btn"
                      onClick={() => setSortSubmenuOpen(!sortSubmenuOpen)}
                    >
                      {sortOrder === 'asc' ? <SortAsc size={13} /> : <SortDesc size={13} />}
                      <span>{t('ft.sortTitle')}</span>
                      {sortSubmenuOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    </button>
                    {sortSubmenuOpen && createPortal(
                      <div className="file-tree-submenu-portal" ref={sortMenuRef} style={{ ...sortMenuStyle, position: 'fixed', zIndex: 10001 }}>
                        {[
                          { key: 'name', label: t('ft.sortName') },
                          { key: 'ctime', label: t('ft.sortCtime') },
                          { key: 'mtime', label: t('ft.sortMtime') },
                          { key: 'type', label: t('ft.sortType') },
                        ].map((item) => (
                          <div key={item.key} className="file-tree-submenu-item">
                            <button
                              className={`file-tree-submenu-btn ${sortBy === item.key ? 'active' : ''}`}
                              onClick={() => {
                                if (sortBy === item.key) {
                                  // 切换排序顺序
                                  setFileTreeSort(item.key as any, sortOrder === 'asc' ? 'desc' : 'asc');
                                } else {
                                  setFileTreeSort(item.key as any, 'asc');
                                }
                                // 选择后关闭子菜单
                                setSortSubmenuOpen(false);
                              }}
                            >
                              {item.label}
                              {sortBy === item.key && (
                                <span className="file-tree-submenu-order">
                                  {sortOrder === 'asc' ? '↑' : '↓'}
                                </span>
                              )}
                            </button>
                          </div>
                        ))}
                      </div>,
                      document.body
                    )}
                  </div>
                  <div className="file-tree-dropdown-sep" />
                  <button className="file-tree-dropdown-item" onClick={handleCreateFolder}>
                    <FolderPlus size={13} />
                    <span>{t('ft.newFolder')}</span>
                  </button>
                  <button className="file-tree-dropdown-item" onClick={handleCreateFile}>
                    <FilePlus size={13} />
                    <span>{t('ft.newFile')}</span>
                  </button>
                  <div className="file-tree-dropdown-sep" />
                  <button className="file-tree-dropdown-item" onClick={() => { expandAllDirs(); setMenuOpen(false); }}>
                    <FolderDown size={13} />
                    <span>{t('ft.expandAll')}</span>
                  </button>
                  <button className="file-tree-dropdown-item" onClick={() => { collapseAllDirs(); setMenuOpen(false); }}>
                    <FolderUp size={13} />
                    <span>{t('ft.collapseAll')}</span>
                  </button>
                </div>
              )}
            </div>
            <RefreshButton
              className="file-tree-search-refresh"
              title={t('sidebar.refresh')}
              onClick={onRefresh}
              disabled={refreshing}
             loading={refreshing}/>
          </>
        )}
      </div>

      {/* 搜索范围限定条：目录右键「作为搜索范围」后显示，可一键清除 */}
      {searchScope ? (
        <div className="file-tree-scope-bar" title={t('ft.scopeBar', { scope: searchScope })}>
          <Search size={11} />
          <span className="file-tree-scope-label">{searchScope}</span>
          <button
            type="button"
            className="file-tree-scope-clear"
            title={t('ft.scopeClear')}
            onClick={() => setFileTreeSearchScope(null)}
          >
            <X size={11} />
          </button>
        </div>
      ) : null}

      {showingResults ? (
        mode === 'content' ? (
          <ContentResults
            result={contentResults}
            searching={searching}
            query={q}
            scope={searchScope}
            activeRelPath={activeFile?.relPath}
            onOpen={openFile}
          />
        ) : (
          <div className="file-tree-results">
            {searching && results.length === 0 ? (
              <div className="muted small" style={{ padding: '8px 12px' }}>{t('ft.searching')}</div>
            ) : results.length === 0 ? (
              <div className="muted small" style={{ padding: '8px 12px' }}>
                {searching ? t('ft.searching') : searchScope ? t('ft.noMatchFilesScope', { scope: searchScope }) : t('ft.noMatchFiles')}
              </div>
            ) : (
              <>
                <div className="file-tree-results-count muted small">
                  {t('ft.results', { n: results.length })}{results.length >= 200 ? t('ft.truncated') : ''}
                </div>
                <ul>
                  {results.map((e) => (
                    <li
                      key={e.relPath}
                      className={`file-result ${activeFile?.relPath === e.relPath ? 'open' : ''}`}
                      onClick={() => openFile(e.relPath)}
                    >
                      <div className="file-result-name">
                        {highlight(e.name, q)}
                      </div>
                      <div className="file-result-path muted small">
                        {highlight(e.relPath, q)}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )
      ) : roots.length === 0 ? (
        <div className="muted small" style={{ padding: '4px 12px' }}>{t('ft.empty')}</div>
      ) : (
        <ul>
          {roots.map((e) => (
            <FileNode key={e.relPath} entry={e} depth={0} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** 全局内容搜索结果：按文件分组，展示匹配行（行号 + 片段），点击跳到对应行。 */
function ContentResults({
  result,
  searching,
  query,
  scope,
  activeRelPath,
  onOpen,
}: {
  result: ContentSearchResult | null;
  searching: boolean;
  query: string;
  /** 限定的搜索范围目录（null = 全项目），用于空结果提示。 */
  scope?: string | null;
  activeRelPath?: string;
  onOpen: (relPath: string, line?: number, query?: string) => void;
}) {
  const t = useT();
  if (searching && !result) {
    return <div className="muted small" style={{ padding: '8px 12px' }}>{t('ft.searching')}</div>;
  }
  if (!result || result.files.length === 0) {
    return (
      <div className="muted small" style={{ padding: '8px 12px' }}>
        {scope ? t('ft.noMatchContentScope', { scope }) : t('ft.noMatchContent')}
      </div>
    );
  }
  return (
    <div className="file-tree-results content-results">
      <div className="file-tree-results-count muted small">
        {t('ft.matches', { n: result.totalMatches, f: result.files.length })}
        {result.truncated ? t('ft.truncated') : ''}
      </div>
      {result.files.map((f) => (
        <div key={f.relPath} className="content-result-file">
          <div
            className={`content-result-file-name ${activeRelPath === f.relPath ? 'open' : ''}`}
            onClick={() => onOpen(f.relPath, f.matches[0]?.line, query)}
          >
            <span style={{ color: langInfoFor(f.name).color }}>●</span>{' '}
            {highlight(f.name, query)}
            <span className="content-result-file-count muted">{f.total}</span>
          </div>
          {f.matches.map((m) => (
            <div
              key={`${f.relPath}:${m.line}`}
              className="content-result-line"
              onClick={() => onOpen(f.relPath, m.line, query)}
              title={t('ft.jumpLine', { n: m.line })}
            >
              <span className="content-result-line-no">{m.line}</span>
              <span className="content-result-snippet">{highlight(m.snippet, query)}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function highlight(text: string, q: string): React.ReactNode {
  if (!q) return text;
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q.toLowerCase());
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

function FileNode({ entry, depth }: { entry: FileEntry; depth: number }) {
  useDateTimeSettings();
  const t = useT();
  const expanded = useAppStore((s) => !!s.expandedDirs[entry.relPath]);
  const children = useAppStore((s) => s.fileTreeChildren[entry.relPath]);
  const toggleDir = useAppStore((s) => s.toggleDir);
  const openFile = useAppStore((s) => s.openFile);
  const activeFile = useActiveFile();
  // open = 当前 active tab；可考虑未来加 "在 tab 列表但未 active" 的弱标记，
  // 现阶段 tab bar 已经一目了然，文件树就用强 active 标记即可。
  const isOpen = !entry.isDir && activeFile?.relPath === entry.relPath;

  // ── 右键菜单：菜单本体见 FileCtxMenu（文件树空白处的“项目根”也用它）──
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const searchScope = useAppStore((s) => s.fileTreeSearchScope);
  const closeCtx = useCallback(() => setCtx(null), []);

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtx({ x: e.clientX, y: e.clientY });
  };

  const onClick = () => {
    if (entry.isDir) toggleDir(entry.relPath);
    else openFile(entry.relPath);
  };

  // 文件根据扩展名上色；目录用默认 muted 色（保留可识别的展开/折叠指示符）。
  // 用 inline style 而非 className 是因为颜色取自映射表，不便枚举到 CSS。
  const iconColor = entry.isDir ? undefined : langInfoFor(entry.name).color;
  const isScoped = entry.isDir && searchScope === entry.relPath;

  return (
    <li>
      <div
        className={`file-node ${isOpen ? 'open' : ''}${isScoped ? ' scoped' : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={onClick}
        onContextMenu={onContextMenu}
        data-rel-path={entry.relPath}
      >
        <span className="file-icon" style={iconColor ? { color: iconColor } : undefined}>
          {entry.isDir ? (
            expanded ? <ChevronDown size={12} strokeWidth={2} /> : <ChevronRight size={12} strokeWidth={2} />
          ) : '●'}
        </span>
        <span className="file-name">{entry.name}</span>
        {isScoped ? <span className="file-node-scope-badge">{t('ft.scopeBadge')}</span> : null}
      </div>
      {/* 右键菜单（FileCtxMenu 内部 Portal 到 body，复用 .file-ctx-menu 样式） */}
      {ctx ? <FileCtxMenu anchor={ctx} entry={entry} onClose={closeCtx} /> : null}
      {entry.isDir && expanded && children ? (
        <ul>
          {children.map((c) => (
            <FileNode key={c.relPath} entry={c} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * 「复制路径」横排行：右键菜单与「···」项目段共用，拷完短暂显示 ✓。
 * 按钮用 min-width: max-content（见 CSS .file-ctx-item-sm），否则文字会在按钮内部折行。
 */
function CopyPathRow({ items }: {
  items: { kind: string; label: string; text: string; title: string }[];
}) {
  const t = useT();
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async (it: { kind: string; text: string }) => {
    try {
      if (!await copyMarkdown(it.text)) return;
    } catch { return; }
    setCopied(it.kind);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 1200);
  };

  return (
    <div className="file-ctx-row">
      <span className="file-ctx-row-label muted small">{t('ft.copyPath')}</span>
      {items.map((it) => (
        <button key={it.kind} className="file-ctx-item file-ctx-item-sm" title={it.title} onClick={() => void copy(it)}>
          {copied === it.kind ? <Check size={12} /> : <Link2 size={12} />}
          {copied === it.kind ? t('ft.copied') : it.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 文件树右键菜单本体（文件 / 目录两种条目）。
 *
 * 项目根不在这里：根目录本身不是一个 FileNode，它那一段已并入搜索框右上角的
 * 「···」菜单（见 FileTree 里的 file-tree-dropdown-menu），列表空白处不再弹菜单。
 */
function FileCtxMenu({
  anchor,
  entry,
  onClose,
}: {
  anchor: { x: number; y: number };
  entry: FileEntry;
  onClose: () => void;
}) {
  useDateTimeSettings();
  const t = useT();
  // 贴光标弹，但列表底部/右边缘放不下时要翻到光标上方（见 shared/popover-placement）。
  const { ref: menuRef, style: menuStyle } = useCursorMenuStyle(anchor.x, anchor.y);

  // 收起：Esc / 点菜单外。菜单 Portal 在 body 上，所以只能自己挂全局监听。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.file-ctx-menu')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouseDown);
    };
  }, [onClose]);

  /** 当前条目的绝对路径（不带尾部分隔符）。 */
  const absPath = () => {
    const proj = useAppStore.getState().currentProject;
    return proj ? `${proj.path}/${entry.relPath}` : entry.relPath;
  };

  /** 目录 → 在 Finder 中打开该目录；文件 → 在 Finder 中选中该文件。 */
  const onRevealInFinder = () => {
    void window.api.openInFinder(absPath());
    onClose();
  };

  /** 目录 → 作为搜索范围（限定文件名/内容搜索的范围）。 */
  const onSetScope = () => {
    useAppStore.getState().setFileTreeSearchScope(entry.relPath);
    onClose();
  };

  /** 目录 → 作为 Sage 项目打开（注册为新项目并切换过去）。 */
  const onOpenAsProject = async () => {
    onClose();
    const abs = absPath();
    if (!(await confirmDialog({ message: translate('filetree.openAsProjectConfirm', { path: entry.relPath, abs }) }))) return;
    const added = (await window.api.addProject(abs)) as import('../../shared/types').ProjectEntry | null;
    if (!added) {
      useAppStore.getState().setBanner(translate('ft.bannerFail'));
      return;
    }
    await useAppStore.getState().refreshProjects();
    await useAppStore.getState().selectProject(added);
  };

  return createPortal(
    <div
      ref={menuRef}
      className="file-ctx-menu"
      style={menuStyle}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="file-ctx-menu-header muted small">
        {entry.isDir ? `${entry.name}/` : entry.name}
      </div>
      {/* 元信息：创建/修改时间（同一秒内只留一条）、文件再带大小 */}
      <div className="file-ctx-meta">
        {(() => {
          const sameTime = entry.ctime && entry.mtime &&
            Math.abs(new Date(entry.ctime).getTime() - new Date(entry.mtime).getTime()) < 1000;
          return (
            <>
              {entry.ctime && <span className="file-ctx-meta-item">{t('ft.metaCreated', { time: formatTime(entry.ctime) })}</span>}
              {entry.mtime && !sameTime && <span className="file-ctx-meta-item">{t('ft.metaModified', { time: formatTime(entry.mtime) })}</span>}
              {!entry.isDir && entry.size !== undefined && <span className="file-ctx-meta-item">{formatFileSize(entry.size)}</span>}
            </>
          );
        })()}
      </div>
      <CopyPathRow
        items={[
          { kind: 'rel', label: t('ft.rel'), text: entry.relPath, title: t('ft.copyRelTitle', { path: entry.relPath }) },
          { kind: 'abs', label: t('ft.abs'), text: absPath(), title: t('ft.copyAbsTitle', { path: absPath() }) },
        ]}
      />
      <div className="file-ctx-sep" />
      <button className="file-ctx-item" onClick={onRevealInFinder}>
        <FolderOpen size={13} />
        {entry.isDir ? t('ft.finderOpen') : t('ft.finderShow')}
      </button>
      {/* 只有目录能限定搜索范围 / 作为新项目打开（项目根本身已在「···」菜单里） */}
      {entry.isDir ? (
        <>
          <div className="file-ctx-sep" />
          <button className="file-ctx-item" onClick={onSetScope}>
            <Search size={13} /> {t('ft.asScope')}
          </button>
          <button className="file-ctx-item" onClick={() => void onOpenAsProject()}>
            <FolderPlus size={13} /> {t('ft.asProject')}
          </button>
        </>
      ) : null}
    </div>,
    document.body,
  );
}
