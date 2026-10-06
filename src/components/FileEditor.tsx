import {formatDateTime,useDateTimeSettings} from '../lib/date-time';
import {PluginSlot} from './plugins/PluginWorkbench';
import { useShortcut } from '../lib/shortcuts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import Editor from 'react-simple-code-editor';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Code as CodeIcon, Eye, AlertTriangle, Search, ChevronUp, ChevronDown, X, FileSearch, Copy, Languages, Sparkles } from 'lucide-react';
// 注意 import 顺序：先 prism core，再各语言 grammar。
// 部分语言依赖前置（jsx 依赖 javascript，tsx 依赖 jsx + typescript），
// prismjs 包内部已经声明 require 关系，但为了安全显式按依赖顺序导入。
import Prism from '../lib/prism';

import { appendTab, useAppStore, useActiveFile } from '../stores/appStore';
import { CursorMenu } from './CursorMenu';
import { requestAiTranslation } from '../lib/ai-translate';
import { TranslatePop, useTranslatePopDismiss, type TranslatePopState } from './TranslatePop';
import { langInfoFor, SUPPORTED_PRISM_GRAMMARS, isImageFile, isHtmlFile, isMarkdownFile, isJsonFile } from '../lib/lang';
import { makeMarkdownComponents } from '../lib/markdownComponents';
import { countLines, buildLineNumbers, gutterWidthFor, lineTopOffset, GUTTER_PAD_TOP } from '../lib/lineNumbers';
import { checkSyntax, syntaxCheckerFor, type SyntaxReport } from '../lib/syntax-check';
import { useT } from '../i18n';
import { DEFAULT_CODE_FONT_SIZE } from '../../shared/appearance';
import { copyMarkdown } from '../lib/clipboard';

/**
 * 缩短文件路径显示：保留文件名和最后 2-3 层目录。
 * 例如：src/main/java/com/example/Service.java → .../example/Service.java
 */
function shortenPath(path: string, maxParts = 3): string {
  const parts = path.split('/');
  if (parts.length <= maxParts) return path;
  return '…/' + parts.slice(-maxParts).join('/');
}

/** 编辑时语法检查的防抖间隔：够跟上手感，又不至于每键触发一次解析。 */
const SYNTAX_DEBOUNCE_MS = 600;
/** tooltip 里最多列几条（store 侧还有 MAX_ISSUES 硬上限）。 */
const SYNTAX_POP_LIMIT = 8;
/** 告警与弹层的间隙；弹层走 CursorMenu，尺寸量不到时会按原意摆，所以留 6px 不致贴死。 */
const SYNTAX_POP_GAP = 6;
/** 鼠标从告警移到弹层中间那几像素时会短暂 leave，延迟关闭才不会把面板抽走。 */
const SYNTAX_POP_CLOSE_DELAY_MS = 180;

/**
 * 简易代码编辑器。
 *
 * 实现方式：react-simple-code-editor 用一个透明的 <textarea> 叠在 Prism 高亮过的
 * <pre> 上面，两者字符尺寸完全一致——编辑手感和原生 textarea 一样，但视觉上
 * 看到的是带语法高亮的内容。语法 token 颜色由 src/styles/index.css 里的
 * `.token.*` 规则用本应用的主题变量统一着色，光暗主题自动适配。
 */
export function FileEditor() {
  useDateTimeSettings();
  const t = useT();
  // 这里 ! 是因为本组件只在 activeFile 非 undefined 时被 App.tsx 渲染。
  const file = useActiveFile()!;
  const setContent = useAppStore((s) => s.setFileContent);
  const save = useAppStore((s) => s.saveFile);
  const setFileView = useAppStore((s) => s.setFileView);
  const clearScrollToLine = useAppStore((s) => s.clearFileScrollToLine);
  /** 是否在源码区左侧显示行号（设置 → 编辑器显示行号）。 */
  const showLineNumbers = useAppStore((s) => s.settings?.showLineNumbers ?? true);
  /** 代码字号（设置 → 外观）：行号栏度量必须与代码区同步。 */
  const codeFontSize = useAppStore((s) => s.settings?.appearance?.codeFontSize) ?? DEFAULT_CODE_FONT_SIZE;

  // markdown 预览组件：链接按"当前文档所在目录"相对解析（标准 markdown 语义）。
  // 例：docs/guide.md 里的 [x](哈哈哈(uc-abc).md) 解析为 docs/哈哈哈(uc-abc).md。
  // 依赖当前文件路径缓存，切换文件时才重建。
  const mdComponents = useMemo(() => {
    const idx = file.relPath.lastIndexOf('/');
    const baseDir = idx > 0 ? file.relPath.slice(0, idx) : '';
    return makeMarkdownComponents(undefined, { baseDir, onLocalLink: file.source === 'virtual' ? async href => {
      const sourceTabId = useAppStore.getState().activeTabId;
      const name = decodeURIComponent(href.split('#')[0]).replace(/^\.\//, '');
      const doc = await window.api.plugins('manual', {name});
      const id = 'file:bundled-document:' + doc.name;
      useAppStore.setState(state => ({openTabs: state.openTabs.some(tab => tab.id === id) ? state.openTabs : appendTab(state.openTabs, {kind:'file',id,data:{source:'virtual',relPath:doc.name,content:doc.content,originalContent:doc.content,binary:false,size:new TextEncoder().encode(doc.content).length,view:'preview',readOnly:true}}, sourceTabId),activeTabId:id}));
    } : undefined });
  }, [file.relPath, file.source]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);

  // 文件类型判断 + 预览模式：纯计算，提前到组件顶部，
  // 确保所有 useEffect 的依赖数组在渲染时能安全访问（避免 const TDZ）。
  const isMarkdown = isMarkdownFile(file.relPath);
  const isHtml = isHtmlFile(file.relPath);
  const isJson = isJsonFile(file.relPath);
  const isPreviewable = isMarkdown || isHtml;
  const view = file.view ?? 'source';
  const isPreview = isPreviewable && view === 'preview';

  // ── IME 合成保护（中文/日文/韩文输入法） + 光标恢复 ──
  // react-simple-code-editor 的 textarea 是完全受控的（value={value}），
  // 每次 input 事件都会触发 onValueChange → zustand set → FileEditor 重渲染。
  // React commit 阶段会把 value prop 写回 textarea DOM，浏览器会重置 selection 到末尾。
  // 处理：
  // 1. IME 合成期间不回传 store（避免打断合成）
  // 2. 普通输入时：保存当前光标位置 → flushSync 强制同步渲染 → requestAnimationFrame 延迟恢复光标
  const composingRef = useRef(false);
  const handleValueChange = (v: string) => {
    if (composingRef.current) return;
    
    // 保存当前光标位置
    const taBefore = containerRef.current?.querySelector('textarea');
    const selStart = taBefore?.selectionStart ?? 0;
    const selEnd = taBefore?.selectionEnd ?? 0;
    
    // flushSync 强制 React 同步完成渲染（DOM 立即更新）
    flushSync(() => setContent(v));
    
    // 用 requestAnimationFrame 延迟恢复光标，让浏览器先处理完 input 事件
    // 否则浏览器在 input 事件结束后会把 selection 重置到末尾
    requestAnimationFrame(() => {
      const taAfter = containerRef.current?.querySelector('textarea');
      if (taAfter) {
        taAfter.focus();
        taAfter.setSelectionRange(selStart, selEnd);
      }
    });
  };

  // ── 文件内搜索（⌘F）：Sublime 风格，支持 正则(.*) / 大小写(Aa) / 全词("") ──
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIdx, setSearchIdx] = useState(0);
  const [searchCase, setSearchCase] = useState(false);   // 区分大小写
  const [searchWord, setSearchWord] = useState(false);   // 全词匹配
  const [searchRegex, setSearchRegex] = useState(false); // 正则表达式
  // ── 右键上下文菜单 ──
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; text: string } | null>(null);
  // ── AI 翻译浮窗：跟在右键菜单位置后面，多语言译文可复制，点浮窗外/Esc 关闭 ──
  const [translatePop, setTranslatePop] = useState<TranslatePopState | null>(null);
  useTranslatePopDismiss(translatePop !== null, () => setTranslatePop(null));
  // ── 预览模式搜索：在渲染后的 DOM 文本节点中搜索 ──
  const [previewMatches, setPreviewMatches] = useState<Array<{ start: number; end: number }>>([]);
  const [previewSearchIdx, setPreviewSearchIdx] = useState(0);

  // 正则模式下校验语法，错误信息显示在计数区
  const searchError = useMemo(() => {
    if (!searchRegex || !searchQuery) return null;
    try {
      new RegExp(searchQuery);
      return null;
    } catch (err: any) {
      return t('editor.invalidRegex', { error: err?.message ?? t('editor.syntaxError') });
    }
  }, [searchQuery, searchRegex, t]);

  const searchMatches = useMemo(() => {
    const raw = searchQuery;
    if (!raw || file.binary || searchError) return [] as Array<{ start: number; end: number }>;
    let pattern: string;
    if (searchRegex) {
      pattern = raw;
    } else {
      // 非正则：转义特殊字符；全词匹配用单词边界环绕。
      // 用 (?<!\w)/(?!\w) 而非 \b：对 ASCII 词效果一致，
      // 且中文等 CJK 查询不会被 \b 语义误伤。
      const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, (ch) => '\\' + ch);
      pattern = searchWord ? `(?<!\\w)(?:${escaped})(?!\\w)` : escaped;
    }
    try {
      const re = new RegExp(pattern, searchCase ? 'g' : 'gi');
      const out: Array<{ start: number; end: number }> = [];
      let m: RegExpExecArray | null;
      // 上限 20000 处，防止巨型文件卡死；零宽匹配强制前进防死循环
      while (out.length < 20000 && (m = re.exec(file.content)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex = m.index + 1;
          continue;
        }
        out.push({ start: m.index, end: m.index + m[0].length });
      }
      return out;
    } catch {
      return [];
    }
  }, [searchQuery, searchCase, searchWord, searchRegex, searchError, file.content, file.binary]);

  /**
   * 选中并滚动到 content 中的一段。wrap 是滚动容器（textarea 随内容撑开）。
   * focus=false 时不抢焦点——文件内搜索栏输入时调用，焦点必须留在搜索框，
   * 否则下一个按键会打进编辑器里变成误编辑（setSelectionRange 无需焦点也生效）。
   */
  const revealRange = (start: number, end: number, focus = false) => {
    const wrap = containerRef.current;
    if (!wrap) return;
    const ta = wrap.querySelector('textarea');
    if (ta instanceof HTMLTextAreaElement) {
      if (focus) ta.focus();
      ta.setSelectionRange(start, end);
    }
    const lineIdx = file.content.slice(0, start).split('\n').length - 1;
    const lh = ta instanceof HTMLElement && ta
      ? parseFloat(getComputedStyle(ta).lineHeight) || 19.2
      : 19.2;
    wrap.scrollTop = Math.max(0, lineIdx * lh - wrap.clientHeight / 2);
  };

  const gotoMatch = (idx: number) => {
    if (isPreview) {
      // 预览模式：在渲染后的 DOM 中搜索
      if (previewMatches.length === 0) return;
      const wrapped = ((idx % previewMatches.length) + previewMatches.length) % previewMatches.length;
      setPreviewSearchIdx(wrapped);
      // 更新当前高亮
      const container = previewRef.current;
      if (container) {
        container.querySelectorAll('mark.search-hit').forEach((m) => m.classList.remove('current'));
        const el = container.querySelector(`mark.search-hit[data-search-idx="${wrapped}"]`);
        el?.classList.add('current');
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }
    if (searchMatches.length === 0) return;
    const wrapped = ((idx % searchMatches.length) + searchMatches.length) % searchMatches.length;
    setSearchIdx(wrapped);
    const m = searchMatches[wrapped];
    // 不抢焦点：保持搜索框可继续输入/连续 Enter 跳转（与 VSCode 行为一致）
    revealRange(m.start, m.end, false);
  };

  // 查询词或搜索选项变化时跳到第一个匹配（不抢焦点，否则打字会打进编辑器）
  useEffect(() => {
    if (searchMatches.length > 0) {
      setSearchIdx(0);
      const m = searchMatches[0];
      revealRange(m.start, m.end, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, searchCase, searchWord, searchRegex]);

  // 打开搜索栏时聚焦输入框
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // ── 从全局内容搜索结果跳转进来：file.scrollToLine（1 起，一次性） ──
  // 若带 scrollToQuery（搜索词），则只选中该行内匹配搜索词的片段，
  // 而不是整行——让用户一眼看到搜索命中的具体位置。
  useEffect(() => {
    if (file.scrollToLine === undefined || file.binary) return;
    const line = file.scrollToLine;
    const lines = file.content.split(/\r?\n/);
    let offset = 0;
    for (let i = 0; i < Math.min(line - 1, lines.length); i++) offset += lines[i].length + 1;
    const lineText = lines[line - 1] ?? '';
    // 在该行内定位搜索词（不区分大小写），命中则只选中匹配片段
    const query = file.scrollToQuery?.trim();
    let selStart = offset;
    let selEnd = offset + lineText.length;
    if (query) {
      const idx = lineText.toLowerCase().indexOf(query.toLowerCase());
      if (idx >= 0) {
        selStart = offset + idx;
        selEnd = offset + idx + query.length;
      }
    }
    // 延迟一帧：等 react-simple-code-editor 渲染完再滚。
    // 从全局搜索跳进来是用户主动定位，给编辑器焦点方便继续操作。
    const t = setTimeout(() => {
      revealRange(selStart, selEnd, true);
      clearScrollToLine();
    }, 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.relPath, file.scrollToLine, file.scrollToQuery]);

  // 预览模式下：搜索 query 变化时重新扫描 DOM 文本节点
  // isMarkdown/isHtml/isJson/isPreviewable/view/isPreview 已在组件顶部声明，
  // 此处可以直接在 useEffect 依赖数组中安全引用。
  useEffect(() => {
    if (!searchOpen || !isPreview || !searchQuery.trim()) {
      setPreviewMatches([]);
      setPreviewSearchIdx(0);
      return;
    }

    // 用 rAF 延迟一帧：确保 ReactMarkdown 已经把最新内容渲染到 DOM，
    // 否则 previewRef.current 里还是旧的（或空的）DOM 节点。
    let cancelled = false;
    const raf = requestAnimationFrame(() => {
      if (cancelled) return;

      const container = previewRef.current;
      if (!container) return;

      // 构建正则
      let pattern: string;
      if (searchRegex) {
        pattern = searchQuery;
      } else {
        const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, (ch) => '\\' + ch);
        pattern = searchWord ? `(?<!\\w)(?:${escaped})(?!\\w)` : escaped;
      }

      let re: RegExp;
      try {
        re = new RegExp(pattern, searchCase ? 'g' : 'gi');
      } catch {
        setPreviewMatches([]);
        return;
      }

      // 遍历所有文本节点，收集匹配
      const matches: Array<{ start: number; end: number }> = [];
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName.toLowerCase();
          if (tag === 'script' || tag === 'style') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });

      const textNodes: Text[] = [];
      let n: Node | null;
      while ((n = walker.nextNode())) textNodes.push(n as Text);

      // 清除之前的 highlight
      container.querySelectorAll('mark.search-hit').forEach((m) => {
        const parent = m.parentNode;
        if (parent) {
          parent.replaceChild(document.createTextNode(m.textContent || ''), m);
          parent.normalize();
        }
      });

      let currentIdx = 0;
      for (const textNode of textNodes) {
        const text = textNode.textContent || '';
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        const newMatches: Array<{ start: number; end: number }> = [];
        while ((m = re.exec(text)) !== null) {
          if (m[0].length === 0) {
            re.lastIndex++;
            continue;
          }
          newMatches.push({ start: m.index, end: m.index + m[0].length });
        }
        if (newMatches.length === 0) continue;

        // 高亮：把 textNode 拆分成 text + mark
        const range = document.createRange();
        range.selectNodeContents(textNode);
        const frag = document.createDocumentFragment();
        let lastEnd = 0;
        for (const match of newMatches) {
          if (match.start > lastEnd) {
            frag.appendChild(document.createTextNode(text.slice(lastEnd, match.start)));
          }
          const mark = document.createElement('mark');
          mark.className = `search-hit${currentIdx === 0 ? ' current' : ''}`;
          mark.textContent = text.slice(match.start, match.end);
          mark.dataset.searchIdx = String(currentIdx);
          frag.appendChild(mark);
          matches.push({ start: match.start, end: match.end });
          currentIdx++;
          lastEnd = match.end;
        }
        if (lastEnd < text.length) {
          frag.appendChild(document.createTextNode(text.slice(lastEnd)));
        }
        range.deleteContents();
        range.insertNode(frag);
      }

      setPreviewMatches(matches);
      setPreviewSearchIdx(0);

      // 滚动到第一个匹配
      if (matches.length > 0) {
        const firstMark = container.querySelector('mark.search-hit.current');
        firstMark?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, searchCase, searchWord, searchRegex, searchOpen, isPreview, file.content]);

  // ── 语法检查：打开即检 + 编辑防抖重查 ──────────────────────────────
  // 错误列表弹层：走 CursorMenu（Portal 到 body + “放不下就翻转/钳位”，见
  // shared/popover-placement）。不能用 CSS :hover + absolute：信息条本身靠右时
  // 弹层会掉出视口右边，长消息看不全（实测窄窗口必现）。
  const [syntaxPop, setSyntaxPop] = useState<{ x: number; y: number } | null>(null);
  const popCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPopClose = () => {
    if (popCloseTimer.current) { clearTimeout(popCloseTimer.current); popCloseTimer.current = null; }
  };
  const openSyntaxPop = (el: HTMLElement) => {
    cancelPopClose();
    const r = el.getBoundingClientRect();
    const x = r.left;
    const y = r.bottom + SYNTAX_POP_GAP;
    setSyntaxPop((prev) => (prev && prev.x === x && prev.y === y ? prev : { x, y }));
  };
  const schedulePopClose = () => {
    cancelPopClose();
    popCloseTimer.current = setTimeout(() => setSyntaxPop(null), SYNTAX_POP_CLOSE_DELAY_MS);
  };
  useEffect(() => cancelPopClose, []);

  // 只覆盖有成熟解析器的类型（JSON/JSONC、YAML、XML/SVG、JS/TS 系，见
  // src/lib/syntax-check.ts）。不支持的类型 checkSyntax 返回 null，此时不显示
  // 任何标志 —— 不能把「不会检查」显示成「语法没问题」。
  const [syntax, setSyntax] = useState<SyntaxReport | null>(null);
  const syntaxPathRef = useRef(file.relPath);
  useEffect(() => {
    const relPath = file.relPath;
    // 切文件时立即检（用户期待打开就看到结果）；编辑中防抖，避免每敲一键跑一次解析。
    const justSwitched = syntaxPathRef.current !== relPath;
    syntaxPathRef.current = relPath;
    setSyntax(null);
    setSyntaxPop(null); // 旧文件的弹层不能留在屏幕上，位置也是按旧 rect 算的
    if (file.binary || !syntaxCheckerFor(relPath)) return;
    const text = file.content ?? '';
    let settled = false;
    const timer = setTimeout(() => {
      void checkSyntax(relPath, text).then(
        (r) => { if (!settled) setSyntax(r); },
        // 解析器自己抛异常（超大文件、依赖加载失败）当作「不检查」，不能因此打断编辑
        () => { if (!settled) setSyntax(null); },
      );
    }, justSwitched ? 0 : SYNTAX_DEBOUNCE_MS);
    return () => { settled = true; clearTimeout(timer); };
  }, [file.relPath, file.content, file.binary]);

  const syntaxIssues = syntax && syntax.issues.length > 0 ? syntax.issues : null;
  // virtual 文件（内置文档等）的 tab id 与 `file:<relPath>` 不同，openFile 找不到它，
  // 所以只展示错误、不给跳转，避免点了没反应的错觉。
  const syntaxJumpable = file.source !== 'virtual';
  const jumpToSyntaxIssue = (line: number) => {
    if (!syntaxJumpable) return;
    setSyntaxPop(null);
    // 复用内容搜索那套跳转：同文件已打开时 openFile 只激活 tab + 写 scrollToLine，
    // 不重读盘，未保存的编辑不会丢。
    void useAppStore.getState().openFile(file.relPath, line);
  };

  // JSON 文件格式化错误提示（点击「美化」后，如果 JSON 解析失败就显示这个）
  const [jsonError, setJsonError] = useState<string | null>(null);
  const formatJson = () => {
    if (!isJson) return;
    try {
      const parsed = JSON.parse(file.content);
      const formatted = JSON.stringify(parsed, null, 2);
      setContent(formatted);
      setJsonError(null);
    } catch (err: any) {
      // JSON.parse 失败时给出可读的错误位置
      const msg = err?.message ?? t('editor.jsonParseError');
      setJsonError(msg);
      // 5 秒后自动清除错误提示
      setTimeout(() => setJsonError((cur) => (cur === msg ? null : cur)), 5000);
    }
  };

  // 切文件时让编辑器自然拿到焦点——react-simple-code-editor 内部有自己的
  // textarea ref，我们用容器 querySelector 拿一下就行。预览模式下没有 textarea
  // 可聚焦，跳过。
  useEffect(() => {
    if (isPreview) return;
    const ta = containerRef.current?.querySelector('textarea');
    if (ta instanceof HTMLTextAreaElement) ta.focus();
  }, [file.relPath, isPreview]);

  // ── 光标位置追踪（底部状态栏显示 Line X, Column Y，Sublime 风格） ──
  // 注意：必须放在 isPreview 声明之后——useEffect 的依赖数组在渲染时
  // 立即求值，提前引用 const 会触发 TDZ（Cannot access before initialization）。
  // react-simple-code-editor 不透传 onSelect，直接给原生 textarea 绑监听。
  // 关键：不在 input 事件上监听——因为 handleValueChange 已经在处理输入了，
  // input 事件再触发 setCursorOffset 会导致第二次重渲染，光标被重置。
  const [cursorOffset, setCursorOffset] = useState(0);
  useEffect(() => {
    if (isPreview || file.binary || file.imageData) return;
    const ta = containerRef.current?.querySelector('textarea') as HTMLTextAreaElement | null;
    if (!ta) return;
    // 只在点击和键盘导航时更新光标位置（不监听 input 事件，避免重复重渲染）
    const update = () => {
      if (composingRef.current) return;
      setCursorOffset(ta.selectionStart ?? 0);
    };
    ta.addEventListener('select', update);
    ta.addEventListener('keyup', update);
    ta.addEventListener('click', update);
    // IME 合成开始/结束：合成期间冻结 store 回传（见 composingRef 注释），
    // 结束时把最终文本提交进 store。切换文件时若正在合成，强制收尾。
    const onCompositionStart = () => {
      composingRef.current = true;
    };
    const onCompositionEnd = () => {
      composingRef.current = false;
      setContent(ta.value);
      // 合成结束后更新光标位置
      setCursorOffset(ta.selectionStart ?? 0);
    };
    ta.addEventListener('compositionstart', onCompositionStart);
    ta.addEventListener('compositionend', onCompositionEnd);
    update();
    return () => {
      ta.removeEventListener('select', update);
      ta.removeEventListener('keyup', update);
      ta.removeEventListener('click', update);
      ta.removeEventListener('compositionstart', onCompositionStart);
      ta.removeEventListener('compositionend', onCompositionEnd);
      // 卸载时若合成未收尾（切文件/关 tab），按已提交处理，避免下次打字被冻结
      composingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.relPath, isPreview, file.binary, file.imageData]);

  const cursorPos = useMemo(() => {
    const safe = Math.min(cursorOffset, file.content.length);
    const before = file.content.slice(0, safe);
    const lastNl = before.lastIndexOf('\n');
    return {
      line: (before.match(/\n/g)?.length ?? 0) + 1,
      col: safe - lastNl, // lastIndexOf 无换行时 -1 → col 从 1 计
    };
  }, [cursorOffset, file.content]);

  // ── 行号栏（源码视图） ─────────────────────────────────────────────
  // 几何常量集中在 src/lib/lineNumbers.ts，与 CSS 的字体度量保持一致。
  const lineCount = useMemo(() => countLines(file.content), [file.content]);

  // 依赖 lineCount 而非 content：同一行内打字不会重建这个字符串
  // （万行文件下每次按键重建 O(n) 字符串会明显卡顿）。
  const lineNumbersText = useMemo(
    () => (showLineNumbers ? buildLineNumbers(lineCount) : ''),
    [showLineNumbers, lineCount],
  );

  /** 行号栏宽度：按最大行号位数计算，至少 3 位。 */
  const gutterWidth = useMemo(() => gutterWidthFor(lineCount, codeFontSize), [lineCount, codeFontSize]);

  const dirty = file.content !== file.originalContent;

  // ⌘S 保存、⌘F 文件内搜索（默认键，可在 设置→键盘快捷键 自定义；编辑器 tab 打开期间生效）
  useShortcut('fileSave', () => { if (dirty && !file.saving) save(); });
  useShortcut('fileFind', () => setSearchOpen(true));

  // 先按文件名取语言信息（图标颜色 + grammar + 显示名）。
  // grammar 没装进 Prism 时（lang.ts 列表 > 编辑器 import 列表）回退到纯文本，
  // 避免 Prism.highlight 在 undefined grammar 上抛错。
  const lang = useMemo(() => langInfoFor(file.relPath), [file.relPath]);
  const effectivePrismLang =
    lang.prism && SUPPORTED_PRISM_GRAMMARS.has(lang.prism) ? lang.prism : 'plain';

  // 文件内搜索激活时的匹配高亮：在 Prism 高亮 HTML 里把匹配区段包进 <mark>。
  // 所有匹配 = search-hit，当前聚焦匹配 = search-hit current。
  const searchActive = searchOpen && searchMatches.length > 0;

  const highlight = (code: string) => {
    let html: string;
    if (effectivePrismLang === 'plain') {
      html = escapeHtml(code);
    } else {
      const grammar = Prism.languages[effectivePrismLang];
      html = grammar ? Prism.highlight(code, grammar, effectivePrismLang) : escapeHtml(code);
    }
    return searchActive ? wrapSearchMatches(html, searchMatches, searchIdx) : html;
  };

  // ── 右键上下文菜单 ──
  // 关闭右键菜单：点击外部 / Escape
  useEffect(() => {
    if (!ctxMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu(null); };
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.file-ctx-menu')) return;
      setCtxMenu(null);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouseDown);
    };
  }, [ctxMenu]);

  const handleContextMenu = (e: React.MouseEvent) => {
    const sel = window.getSelection()?.toString() ?? '';
    if (!sel.trim()) return; // 无选中文本时不弹菜单
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, text: sel.trim() });
  };

  const onCtxSearchFileName = () => {
    useAppStore.getState().setPendingFileTreeSearch({ query: ctxMenu!.text, mode: 'name' });
    setCtxMenu(null);
  };
  const onCtxSearchContent = () => {
    useAppStore.getState().setPendingFileTreeSearch({ query: ctxMenu!.text, mode: 'content' });
    setCtxMenu(null);
  };
  const onCtxCopy = async () => {
    try { await copyMarkdown(ctxMenu!.text); } catch { /* ignore */ }
    setCtxMenu(null);
  };
  const onCtxTranslate = async () => {
    const text = ctxMenu!.text;
    const { x, y } = ctxMenu!;
    setCtxMenu(null);
    // 浮窗跟在右键菜单位置后面：先占位 loading，模型返回后原地填充译文
    setTranslatePop({ x, y, text, loading: true, items: [] });
    try {
      const result = await requestAiTranslation(text, useAppStore.getState().currentProject?.path);
      setTranslatePop(p => (p && p.text === text && p.loading ? { ...p, loading: false, detected: result.detected, items: result.items } : p));
    } catch (e: any) {
      setTranslatePop(p => (p && p.text === text && p.loading ? { ...p, loading: false, error: e?.message ?? String(e) } : p));
    }
  };
  const onCtxAiSearch = async () => {
    const text = ctxMenu!.text;
    setCtxMenu(null);
    // AI 检索：新建对话，让 AI 检索该内容的背景知识及其在本项目中的用法
    const project = useAppStore.getState().currentProject;
    if (!project) return;
    const meta = await useAppStore.getState().createConversation();
    if (!meta) return;
    await useAppStore.getState().sendChat(
      t('editor.researchPrompt', { path: file.relPath, text }),
    );
  };

  return (
    <div className="file-editor" onContextMenu={handleContextMenu}>
      <header className="file-editor-header">
        <PluginSlot slot="editor.toolbar"/>
        <div className="file-editor-path">
          <div className="file-editor-path-row">
            <strong>{shortenPath(file.relPath)}</strong>
            {dirty ? <span className="dirty-dot" title={t('editor.unsaved')}>●</span> : null}
            <span className="muted small">
              {prettySize(file.size)}{file.truncated ? t('editor.truncated') : ''}
            </span>
            {!file.binary ? (
              <span
                className="file-editor-lang-chip"
                title={lang.label}
                style={{ color: lang.color }}
              >
                {lang.label}
              </span>
            ) : null}
            {/* 语法检查告警：hover/focus 展开错误列表，点击（告警本体或列表项）跳到出错行 */}
            {syntaxIssues ? (
              <span
                className="file-syntax-warn-wrap"
                onMouseEnter={(e) => openSyntaxPop(e.currentTarget)}
                onMouseLeave={schedulePopClose}
                onFocus={(e) => openSyntaxPop(e.currentTarget)}
                onBlur={schedulePopClose}
              >
                <button
                  type="button"
                  className="file-syntax-warn"
                  onClick={() => jumpToSyntaxIssue(syntaxIssues[0].line)}
                  aria-label={t('fe.syntaxErrors', { n: syntaxIssues.length })}
                  aria-expanded={syntaxPop ? true : undefined}
                >
                  <AlertTriangle size={12} />
                  {syntaxIssues.length}
                </button>
                {syntaxPop ? (
                  <CursorMenu
                    x={syntaxPop.x}
                    y={syntaxPop.y}
                    className="file-syntax-warn-pop"
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <div
                      className="file-syntax-warn-list"
                      onMouseEnter={cancelPopClose}
                      onMouseLeave={schedulePopClose}
                    >
                      <span className="file-syntax-warn-head muted small">
                        {t('fe.syntaxErrors', { n: syntaxIssues.length })}
                      </span>
                      {syntaxIssues.slice(0, SYNTAX_POP_LIMIT).map((iss, i) => (
                        <button
                          key={`${iss.line}:${iss.column}:${i}`}
                          type="button"
                          className={`file-syntax-warn-item${syntaxJumpable ? '' : ' disabled'}`}
                          onClick={() => jumpToSyntaxIssue(iss.line)}
                          title={syntaxJumpable ? t('fe.syntaxJump', { line: iss.line }) : t('fe.syntaxNoJump')}
                        >
                          <span className="file-syntax-warn-pos">{iss.line}:{iss.column || 1}</span>
                          <span className="file-syntax-warn-msg">{iss.message}</span>
                        </button>
                      ))}
                      {syntaxIssues.length > SYNTAX_POP_LIMIT ? (
                        <span className="file-syntax-warn-more muted small">
                          {t('fe.syntaxMore', { n: syntaxIssues.length - SYNTAX_POP_LIMIT })}
                        </span>
                      ) : null}
                    </div>
                  </CursorMenu>
                ) : null}
              </span>
            ) : null}
          </div>
          {/* 最后更新时间：灰色小字，独占一行显示在路径信息下方 */}
          {file.mtime ? (
            <span className="file-editor-mtime muted small">
              {t('editor.modified', { time: formatMtime(file.mtime) })}
            </span>
          ) : null}
        </div>
        <div className="file-editor-actions">
          {/* markdown / html 文件的「源码 / 预览」分段切换 —— 仅可预览的文件类型显示，
              且 binary 时根本走不到这里（binary 走单独分支）。 */}
          {isPreviewable ? (
            <div className="md-view-toggle" role="group" aria-label={t('editor.switchView')}>
              <button
                type="button"
                className={`md-view-toggle-btn ${view === 'source' ? 'active' : ''}`}
                onClick={() => setFileView('source')}
                title={t('editor.sourceTitle')}
              >
                <CodeIcon size={12} /> {t('editor.source')}
              </button>
              <button
                type="button"
                className={`md-view-toggle-btn ${view === 'preview' ? 'active' : ''}`}
                onClick={() => setFileView('preview')}
                title={t('editor.previewTitle')}
              >
                <Eye size={12} /> {t('editor.preview')}
              </button>
            </div>
          ) : null}
          {/* JSON 文件的「美化」按钮 —— 一键格式化。解析失败时在编辑器下方弹错误。 */}
          {isJson && !isPreview ? (
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={formatJson}
              title={t('editor.formatTitle')}
            >
              ✨ {t('editor.format')}
            </button>
          ) : null}
          {/* 文件内搜索入口（⌘F） */}
          {!file.binary ? (
            <button
              type="button"
              className={`btn-ghost btn-sm ${searchOpen ? 'active' : ''}`}
              onClick={() => setSearchOpen(!searchOpen)}
              title={t('editor.searchTitle')}
            >
              <Search size={12} /> {t('editor.search')}
            </button>
          ) : null}
          {/* "关闭" 按钮已挪到上方 FileTabs 的每个 tab × 上——保留这里只会与
              tab × 重复。需要单独 hint 用户可以在 tab × 关。 */}
          {/* 保存按钮：只在有修改时显示，避免"已保存"状态按钮不协调 */}
          {file.binary || isPreview || !dirty ? null : (
            <button
              className="btn-primary btn-sm"
              disabled={!!file.saving}
              onClick={save}
            >
              {file.saving ? t('editor.saving') : t('editor.save')}
            </button>
          )}
        </div>
      </header>

      {file.imageData ? (
        // 图片预览：直接渲染 <img> 标签
        <div className="file-image-preview">
          <img src={file.imageData} alt={file.relPath} />
        </div>
      ) : file.binary ? (
        <div className="file-binary">
          <p className="muted">{t('editor.binary')}</p>
          <p className="muted small">{prettySize(file.size)}</p>
        </div>
      ) : isPreview ? (
        isMarkdown ? (
          // markdown 预览：用 ReactMarkdown 渲染。保留 dirty 状态（切回源码仍能看到
          // 未保存改动），但预览本身只读。复用 .doc-render 的 markdown 排版
          // （headings / code / lists / strong 等已有 spec phase 一致的样式）。
          <>
            {searchOpen ? (
              <div className="file-search-bar">
                {/* Sublime 风格选项开关：正则 / 大小写 / 全词 */}
                <div className="file-search-opts" role="group" aria-label={t('editor.searchOptions')}>
                  <button
                    type="button"
                    className={`file-search-opt ${searchRegex ? 'active' : ''}`}
                    title={t('editor.regex')}
                    onClick={() => setSearchRegex(!searchRegex)}
                  >.*</button>
                  <button
                    type="button"
                    className={`file-search-opt ${searchCase ? 'active' : ''}`}
                    title={t('editor.matchCase')}
                    onClick={() => setSearchCase(!searchCase)}
                  >Aa</button>
                  <button
                    type="button"
                    className={`file-search-opt ${searchWord ? 'active' : ''}`}
                    title={t('editor.wholeWord')}
                    onClick={() => setSearchWord(!searchWord)}
                  >""</button>
                </div>
                <Search size={12} className="file-search-icon" />
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder={searchRegex ? t('editor.regexPlaceholder') : t('editor.previewPlaceholder')}
                  value={searchQuery}
                  spellCheck={false}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      gotoMatch(previewSearchIdx + (e.shiftKey ? -1 : 1));
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setSearchOpen(false);
                    } else if (e.altKey && (e.key === 'r' || e.key === 'R')) {
                      e.preventDefault();
                      setSearchRegex(!searchRegex);
                    } else if (e.altKey && (e.key === 'c' || e.key === 'C')) {
                      e.preventDefault();
                      setSearchCase(!searchCase);
                    } else if (e.altKey && (e.key === 'w' || e.key === 'W')) {
                      e.preventDefault();
                      setSearchWord(!searchWord);
                    }
                  }}
                />
                <span className="file-search-count muted small">
                  {searchError ? (
                    <span style={{ color: 'var(--err)' }}>{searchError}</span>
                  ) : searchQuery ? (
                    previewMatches.length === 0 ? t('editor.noMatches') : `${previewSearchIdx + 1}/${previewMatches.length}`
                  ) : (
                    t('editor.navigation')
                  )}
                </span>
                <button type="button" className="file-search-nav" title={t('editor.previous')} onClick={() => gotoMatch(previewSearchIdx - 1)} disabled={previewMatches.length === 0}>
                  <ChevronUp size={13} />
                </button>
                <button type="button" className="file-search-nav" title={t('editor.next')} onClick={() => gotoMatch(previewSearchIdx + 1)} disabled={previewMatches.length === 0}>
                  <ChevronDown size={13} />
                </button>
                <button type="button" className="file-search-nav" title={t('editor.close')} onClick={() => setSearchOpen(false)}>
                  <X size={13} />
                </button>
              </div>
            ) : null}
            <div ref={previewRef} className="file-md-preview doc-render">
              <div data-markdown-document><ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{file.content}</ReactMarkdown></div>
            </div>
          </>
        ) : (
          // HTML 预览：用 iframe srcDoc 渲染，能完整执行 CSS 和 JS，看到真实效果。
          // iframe 与父页面隔离，脚本和样式不会泄露出去。
          <div className="file-html-preview">
            <iframe
              srcDoc={file.content}
              title={file.relPath}
              sandbox="allow-same-origin allow-scripts"
            />
          </div>
        )
      ) : (
        <>
          {searchOpen ? (
            <div className="file-search-bar">
              {/* Sublime 风格选项开关：正则 / 大小写 / 全词 */}
              <div className="file-search-opts" role="group" aria-label={t('editor.searchOptions')}>
                <button
                  type="button"
                  className={`file-search-opt ${searchRegex ? 'active' : ''}`}
                  title={t('editor.regex')}
                  onClick={() => setSearchRegex(!searchRegex)}
                >.*</button>
                <button
                  type="button"
                  className={`file-search-opt ${searchCase ? 'active' : ''}`}
                  title={t('editor.matchCase')}
                  onClick={() => setSearchCase(!searchCase)}
                >Aa</button>
                <button
                  type="button"
                  className={`file-search-opt ${searchWord ? 'active' : ''}`}
                  title={t('editor.wholeWord')}
                  onClick={() => setSearchWord(!searchWord)}
                >""</button>
              </div>
              <Search size={12} className="file-search-icon" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder={searchRegex ? t('editor.regexPlaceholder') : t('editor.filePlaceholder')}
                value={searchQuery}
                spellCheck={false}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    gotoMatch(searchIdx + (e.shiftKey ? -1 : 1));
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setSearchOpen(false);
                  } else if (e.altKey && (e.key === 'r' || e.key === 'R')) {
                    e.preventDefault();
                    setSearchRegex(!searchRegex);
                  } else if (e.altKey && (e.key === 'c' || e.key === 'C')) {
                    e.preventDefault();
                    setSearchCase(!searchCase);
                  } else if (e.altKey && (e.key === 'w' || e.key === 'W')) {
                    e.preventDefault();
                    setSearchWord(!searchWord);
                  }
                }}
              />
              <span className="file-search-count muted small">
                {searchError ? (
                  <span style={{ color: 'var(--err)' }}>{searchError}</span>
                ) : searchQuery ? (
                  searchMatches.length === 0 ? t('editor.noMatches') : `${searchIdx + 1}/${searchMatches.length}`
                ) : (
                  t('editor.navigation')
                )}
              </span>
              <button type="button" className="file-search-nav" title={t('editor.previous')} onClick={() => gotoMatch(searchIdx - 1)} disabled={searchMatches.length === 0}>
                <ChevronUp size={13} />
              </button>
              <button type="button" className="file-search-nav" title={t('editor.next')} onClick={() => gotoMatch(searchIdx + 1)} disabled={searchMatches.length === 0}>
                <ChevronDown size={13} />
              </button>
              <button type="button" className="file-search-nav" title={t('editor.close')} onClick={() => setSearchOpen(false)}>
                <X size={13} />
              </button>
            </div>
          ) : null}
          <div
            ref={containerRef}
            className={`file-code-wrap${showLineNumbers ? ' with-gutter' : ''}`}
          >
          {/* 行号栏：sticky left 使其在横向滚动时保持可见，
              纵向随内容一起滚动（同一滚动容器内，天然同步）。 */}
          {showLineNumbers ? (
            <div
              className="file-code-gutter"
              style={{ width: gutterWidth, paddingTop: GUTTER_PAD_TOP }}
              aria-hidden
            >              <span className="file-code-gutter-text">{lineNumbersText}</span>
              {/* 当前行号高亮：绝对定位到光标所在行，零额外 DOM 开销 */}
              <span
                className="file-code-gutter-current"
                style={{ top: lineTopOffset(cursorPos.line, codeFontSize) }}
              >
                {cursorPos.line}
              </span>
            </div>
          ) : null}
          <Editor
            readOnly={file.readOnly}
            value={file.content}
            onValueChange={handleValueChange}
            highlight={highlight}
            padding={{ top: 16, right: 24, bottom: 16, left: showLineNumbers ? 12 : 24 }}
            tabSize={2}
            insertSpaces
            textareaClassName="file-code-textarea"
            preClassName="file-code-pre"
            // 关键：父 .file-code-wrap 给定高度，react-simple-code-editor 自身
            // 用 style={{minHeight:'100%'}} 撑满；内部超长用 pre 的 overflow 处理。
            style={{
              minHeight: '100%',
              fontFamily: 'var(--font-mono, "JetBrains Mono", Menlo, monospace)',
              fontSize: 'var(--fs-code, 12px)',
              lineHeight: 1.6,
              background: 'var(--bg-1)',
              color: 'var(--text)',
              tabSize: 2,
            }}
            // react-simple-code-editor 把以下 props 透传到内部 textarea。
            // 用 ...{spellCheck:false} 形式避开 lib 的 props 类型限制。
            {...({ spellCheck: false } as Record<string, unknown>)}
          />
          </div>
        </>
      )}

      {file.error ? <div className="file-error"><AlertTriangle size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />{file.error}</div> : null}
      {file.truncated ? (
        <div className="file-warn">
          <AlertTriangle size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
          {t('editor.largeFile')}
        </div>
      ) : null}
      {jsonError ? (
        <div className="file-error">
          <AlertTriangle size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
          {t('editor.formatError', { error: jsonError })}
        </div>
      ) : null}

      {/* 状态栏：光标行/列（Sublime 风格），仅文本文件源码视图显示 */}
      {!file.binary && !file.imageData && !isPreview ? (
        <div className="file-editor-statusbar muted small">
          <span>{t('editor.cursor', { line: cursorPos.line, column: cursorPos.col })}</span>
          <span>{lang.label}</span>
        </div>
      ) : null}

      {/* 右键上下文菜单（贴光标弹，底部放不下时翻向上方） */}
      {ctxMenu ? <CursorMenu x={ctxMenu.x} y={ctxMenu.y}>
        <div className="file-ctx-menu-header muted small">
          「{ctxMenu.text.length > 40 ? ctxMenu.text.slice(0, 40) + '…' : ctxMenu.text}」
        </div>
        <button className="file-ctx-item" onClick={onCtxSearchFileName}>
          <FileSearch size={13} /> {t('editor.findFile')}
        </button>
        <button className="file-ctx-item" onClick={onCtxSearchContent}>
          <Search size={13} /> {t('editor.globalSearch')}
        </button>
        <div className="file-ctx-sep" />
        <button className="file-ctx-item" onClick={onCtxTranslate}>
          <Languages size={13} /> {t('editor.translate')}
        </button>
        <button className="file-ctx-item" onClick={onCtxAiSearch}>
          <Sparkles size={13} /> {t('editor.research')}
        </button>
        <div className="file-ctx-sep" />
        <button className="file-ctx-item" onClick={onCtxCopy}>
          <Copy size={13} /> {t('editor.copy')}
        </button>
      </CursorMenu> : null}
      {/* AI 翻译浮窗（Portal 到 body）：跟在右键位置后，点外部/Esc 关闭 */}
      {translatePop ? <TranslatePop pop={translatePop} onClose={() => setTranslatePop(null)} /> : null}
    </div>
  );
}

function prettySize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** ISO 时间 → 「2026-12-12 12:12:12」（本地时区，Date Modified 风格）。 */
function formatMtime(iso: string): string { return formatDateTime(iso); }

/**
 * 纯文本兜底时也要 escape，否则用户内容里的 `<` / `&` 会被 dangerouslySetInnerHTML
 * 当 HTML 渲染——react-simple-code-editor 的 highlight 返回值是直接塞 innerHTML 的。
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 把搜索匹配区段注入 Prism 高亮后的 HTML（文件内搜索高亮）。
 *
 * 难点：Prism 输出的是嵌套 <span> + HTML 实体（&amp; / &lt; / &#39; …），
 * 而匹配区间是按纯文本偏移算的。直接字符串插入会破坏标签嵌套。
 * 方案：逐段扫描 HTML，维护「纯文本偏移」和「打开的 span 栈」；
 * 碰到匹配边界时先临时闭合所有 span，插入 </mark> 或 <mark>，
 * 再按原样重新打开 span——输出的 HTML 始终合法。
 *
 * mark 只加背景不改字体度量，与透明 textarea 的光标位置保持一致。
 */
function wrapSearchMatches(
  html: string,
  matches: Array<{ start: number; end: number }>,
  currentIdx: number,
): string {
  if (matches.length === 0) return html;

  const out: string[] = [];
  const spanStack: string[] = [];
  let textPos = 0;   // 已消费的纯文本字符数
  let mi = 0;        // 下一个要打开的匹配索引
  let open = -1;     // 当前打开的匹配索引（-1 = 无）

  const closeSpans = () => {
    for (let i = spanStack.length - 1; i >= 0; i--) out.push('</span>');
  };
  const reopenSpans = () => {
    for (const tag of spanStack) out.push(tag);
  };

  let i = 0;
  const n = html.length;
  while (i < n) {
    // 匹配边界检查（先处理「结束」再处理「开始」，支持相邻匹配）
    if (open !== -1 && textPos >= matches[open].end) {
      closeSpans();
      out.push('</mark>');
      open = -1;
      mi++;
      reopenSpans();
      continue;
    }
    if (open === -1 && mi < matches.length && textPos >= matches[mi].start) {
      closeSpans();
      out.push(`<mark class="search-hit${mi === currentIdx ? ' current' : ''}">`);
      open = mi;
      reopenSpans();
      continue;
    }

    const ch = html[i];
    if (ch === '<') {
      // 标签：不消费文本偏移；维护 span 栈
      const close = html.indexOf('>', i);
      const tag = html.slice(i, close + 1);
      if (tag.startsWith('</')) {
        spanStack.pop();
      } else if (tag.startsWith('<span') && !tag.endsWith('/>')) {
        spanStack.push(tag);
      }
      out.push(tag);
      i = close + 1;
    } else if (ch === '&') {
      // 实体（&amp; &lt; &gt; &quot; &#39;）：整体输出，算 1 个文本字符
      const semi = html.indexOf(';', i);
      if (semi > i && semi - i <= 8) {
        out.push(html.slice(i, semi + 1));
        i = semi + 1;
      } else {
        out.push(ch);
        i++;
      }
      textPos++;
    } else {
      out.push(ch);
      i++;
      textPos++;
    }
  }
  // 收尾：文末仍未闭合的匹配
  if (open !== -1) {
    closeSpans();
    out.push('</mark>');
  }
  return out.join('');
}
