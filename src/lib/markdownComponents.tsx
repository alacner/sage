import { CopyImageAddress, isTemporaryImageUrl } from '../components/CopyImageAddress';
import {MarkdownTable} from '../components/MarkdownTable';
import { enabledBuiltins } from '../../shared/builtin-plugins';
import {getTabRenderer} from '../plugins';
import { scrollMarkdownAnchor } from './markdown-anchors';
import Prism from './prism';
import type { MouseEvent } from 'react';
import { MermaidBlock } from '../components/MermaidBlock';
import { AsciiDiagramPre, looksLikeCjkDiagram } from '../components/AsciiDiagram';
import { useAppStore } from '../stores/appStore';
import { translate } from '../i18n';
import { MarkdownImage } from '../components/MarkdownImage';

/** Extract plain text from React children (for code block content). */
function extractText(node: any): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node?.props?.children) return extractText(node.props.children);
  return '';
}

// ---------------------------------------------------------------------------
// 项目内文件引用 → 点击打开
// ---------------------------------------------------------------------------

/** 常见代码/文档/配置扩展名：裸文件名带这些扩展名时视为文件引用。 */
const FILE_EXT_RE =
  /\.(?:tsx?|mts|cts|jsx?|mjs|cjs|py|php[0-9]?|phtml|java|c|h|cpp|hpp|cc|cs|go|rs|rb|swift|kt|scala|md|mdx|jsonc?|ya?ml|toml|xml|svg|html?|css|scss|less|sass|sql|sh|bash|zsh|fish|vue|svelte|txt|csv|ini|cfg|conf|env|lock|log)$/i;

/** 无扩展名但约定俗成的文件名。 */
const KNOWN_FILENAMES = /^(dockerfile|makefile|readme|license|procfile|gemfile|rakefile)$/i;

/** 路径段字符：字母数字 . _ @ - （不含空格，避免把普通句子误判成路径）。 */
const SEG = '[\\w.@-]+';

/**
 * 文本是否"看起来像项目内文件引用"。
 * 支持：foo.ts / src/foo.ts / a/b/c.md / Dockerfile / foo.ts:42
 */
export function looksLikeFileRef(text: string): boolean {
  if (!text || text.length > 200) return false;
  const ref = stripFileRef(text).ref;
  if (!ref) return false;
  // 含空格/换行 = 普通句子或命令，不是文件引用
  if (ref.includes(' ') || ref.includes('\n')) return false;
  if (KNOWN_FILENAMES.test(ref)) return true;
  if (ref.includes('/')) return FILE_EXT_RE.test(ref);
  return FILE_EXT_RE.test(ref);
}

/** 规范化文件引用：去引号反引号、尾随标点（含中文标点），拆出 path:line。 */
export function stripFileRef(text: string): { ref: string; line?: number } {
  let ref = text.trim().replace(/[`'"]/g, '').replace(/[.,;:。；，、)\]）】]+$/, '');
  let line: number | undefined;
  // 末尾 :数字 视为行号（排除 Windows 盘符，项目都在 macOS 上）
  const m = /^(.+?):(\d+)$/.exec(ref);
  if (m) {
    ref = m[1];
    line = parseInt(m[2], 10);
  }
  return { ref, line };
}

/**
 * 按消息中提到的文件引用打开项目内文件。
 * 解析顺序：绝对路径（限项目内）→ 相对路径精确匹配 → 文件名搜索最佳匹配。
 * 找不到返回 false（调用方不提示，保持安静）。
 */
export async function openProjectFileByRef(text: string): Promise<boolean> {
  let { ref, line } = stripFileRef(text);
  return resolveAndOpenFile(ref, line);
}

/**
 * 打开 markdown 文档内的本地链接（如 [哈哈哈](哈哈哈(uc-abc).md)）。
 *
 * 与 openProjectFileByRef 的区别：
 * - 先剥离 #fragment 和 ?query（文档锚点/查询参数不映射到文件路径）
 * - URL 解码（空格等会被编码成 %20）
 * - 支持 baseDir：链接相对当前文档所在目录解析（标准 markdown 语义）
 */
export async function openMarkdownLink(href: string, baseDir?: string): Promise<boolean> {
  if (!href) return false;
  // 去掉 fragment / query（纯锚点链接直接忽略）
  const pathPart = href.split('#')[0].split('?')[0];
  if (!pathPart) return false;
  // URL 解码：文件名里的空格等字符在 href 中是 %20
  let ref: string;
  try {
    ref = decodeURIComponent(pathPart);
  } catch {
    ref = pathPart;
  }
  if (!ref || ref.includes('\n')) return false;
  return resolveAndOpenFile(ref, undefined, baseDir);
}

/**
 * 核心解析：把一个文件引用解析成项目内文件并打开。
 * 顺序：绝对路径（限项目内）→ baseDir 相对解析 → 项目根相对路径精确匹配
 *       → 路径后缀匹配 → 文件名搜索最佳匹配。
 * 找不到返回 false。
 */
async function resolveAndOpenFile(
  ref: string,
  line?: number,
  baseDir?: string,
): Promise<boolean> {
  const { currentProject, openFile, searchProjectFiles } = useAppStore.getState();
  if (!currentProject) return false;
  if (!ref || ref.includes(' ') || ref.includes('\n')) return false;

  // 项目内绝对路径 → 转相对路径
  if (ref.startsWith(currentProject.path)) {
    ref = ref.slice(currentProject.path.length).replace(/^\/+/, '');
  } else if (ref.startsWith('/')) {
    return false; // 项目外绝对路径不在文件树范围
  }

  // baseDir 相对解析（标准 markdown 语义：链接相对当前文档所在目录）。
  // 规范化 ../、./ 后作为首选候选。
  let baseResolved: string | undefined;
  if (baseDir && !ref.startsWith('/')) {
    baseResolved = joinRelative(baseDir, ref);
  }

  // 搜索候选：完整路径 + 文件名双路查询，命中面更大。
  const fileName = ref.split('/').pop() ?? ref;
  const [byPath, byName] = await Promise.all([
    searchProjectFiles(ref),
    fileName !== ref ? searchProjectFiles(fileName) : Promise.resolve([] as Awaited<ReturnType<typeof searchProjectFiles>>),
  ]);
  const entries = [...byPath, ...byName];
  if (entries.length === 0) return false;

  // 最佳匹配：baseDir 解析结果 > 相对路径精确 > 路径后缀匹配 > 文件名精确 > 首个
  const pick =
    (baseResolved && entries.find((e) => e.relPath === baseResolved)) ||
    entries.find((e) => e.relPath === ref) ||
    entries.find((e) => e.relPath.endsWith(`/${ref}`)) ||
    entries.find((e) => e.name === ref) ||
    entries[0];

  await openFile(pick.relPath, line);
  return true;
}

/** 把相对链接按 baseDir 解析并规范化（处理 ./ 与 ../）。 */
function joinRelative(baseDir: string, ref: string): string {
  const parts = baseDir.split('/').filter(Boolean);
  for (const seg of ref.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** markdown 组件工厂的选项。 */
export interface MarkdownComponentsOptions {
  /**
   * 本地链接的基准目录（相对项目根，如 "docs"）。
   * FileEditor 预览 markdown 文件时传入该文件所在目录，
   * 使链接按标准 markdown 语义（相对当前文档）解析。
   */
  baseDir?: string;
  onLocalLink?: (href: string) => Promise<void>;
}

/**
 * Build ReactMarkdown component overrides that render ```mermaid fenced blocks
 * as live diagrams (via MermaidBlock), while leaving all other code blocks to
 * their default (or caller-provided) rendering.
 *
 * The mermaid detection happens on the `pre` element so the diagram is not
 * nested inside a styled <pre><code>. Extra overrides (e.g. a custom `code`
 * renderer for syntax highlighting) are merged in and preserved.
 *
 * opts.baseDir: 本地文件链接（如 [x](x.md)）的相对解析基准目录。
 */
export function makeMarkdownComponents(
  extra?: Record<string, any>,
  opts?: MarkdownComponentsOptions,
) {
  const baseDir = opts?.baseDir;
  return {
    table: MarkdownTable,
    img({ src, alt, title, ...props }: any) {
      return <MarkdownImage src={src} alt={alt} title={title} {...props} />;
    },
    pre({ children, ...props }: any) {
      const child = Array.isArray(children) ? children[0] : children;
      const cls: string = child?.props?.className ?? '';
      if (typeof cls === 'string' && cls.split(/\s+/).includes('language-mermaid')) {
        return <MermaidBlock source={extractText(child.props.children).trim()} />;
      }
      // 含中文的制表符图：按 2:1 栅格对齐渲染（否则 CJK 回退字宽非整 ch，竖线参差）
      const rawText = extractText(children);
      if (looksLikeCjkDiagram(rawText)) {
        return (
          <div className="ascii-diagram">
            <AsciiDiagramPre text={rawText.replace(/\n+$/, '')} className="ascii-diagram-pre" />
          </div>
        );
      }
      // 代码块：用 Prism 高亮 + 行号
      const text = rawText.trim();
      const lang = typeof cls === 'string' ? cls.replace('language-', '') : '';
      if (text && lang && lang !== 'mermaid') {
        try {
          const grammar = (Prism as any).languages[lang] || (Prism as any).languages.javascript;
          const highlighted = Prism.highlight(text, grammar, lang);
          return (
            <pre className="code-block" {...props}>
              <code className={`language-${lang}`} dangerouslySetInnerHTML={{ __html: highlighted }} />
            </pre>
          );
        } catch {
          /* fallthrough to plain */
        }
      }
      return <pre className="code-block" {...props}>{children}</pre>;
    },
    code({ className, children, ...props }: any) {
      // inline code 若"看起来像项目内文件"则渲染为可点击链接。
      const text = extractText(children).trim();
      const isBlock =
        (typeof className === 'string' && /language-/.test(className)) ||
        text.includes('\n');
      if (!isBlock && looksLikeFileRef(text)) {
        const { ref, line } = stripFileRef(text);
        return (
          <code
            className={`md-file-link ${className ?? ''}`.trim()}
            title={translate('md.fileLinkTitle')}
            onClick={(e: MouseEvent) => {
              e.preventDefault();
              e.stopPropagation();
              void openProjectFileByRef(text);
            }}
            onContextMenu={(e: MouseEvent) => {
              e.preventDefault();
              e.stopPropagation();
              // 获取当前项目和文件路径，显示右键菜单
              const { currentProject } = useAppStore.getState();
              if (!currentProject) return;
              
              // 创建右键菜单事件，传递给 ChatView 处理
              const event = new CustomEvent('file-link-context-menu', {
                detail: {
                  x: e.clientX,
                  y: e.clientY,
                  filePath: ref,
                  absPath: `${currentProject.path}/${ref}`,
                },
              });
              window.dispatchEvent(event);
            }}
            {...props}
          >
            {children}
          </code>
        );
      }
      // inline code 高亮
      if (!isBlock && text) {
        return <code className={className} {...props}>{children}</code>;
      }
      return <code className={className} {...props}>{children}</code>;
    },
    a({ href, children, ...props }: any) {
      if (isTemporaryImageUrl(href)) return <CopyImageAddress url={href}/>;
      // 外部链接一律用系统浏览器打开；其他任何链接（本地 .md、锚点、未知协议）
      // 都必须 preventDefault —— 否则 webContents 会真的导航过去，把整个
      // SPA 替换成 404/空文档（表现为黑屏，且 React 状态全部丢失）。
      const isExternal = typeof href === 'string' && /^https?:\/\//i.test(href);
      const onClick = (e: MouseEvent) => {
        if (isExternal) {
          e.preventDefault();
          const state=useAppStore.getState();
          if(getTabRenderer('browser',enabledBuiltins(state.settings,state.currentProject)))state.openBrowserTab(href);
          else void window.api.openExternal(href);
          return;
        }
        // 非外部链接：无条件阻止默认导航
        e.preventDefault();
        if (typeof href !== 'string' || !href) return;
        if (href.startsWith('#')) {
          scrollMarkdownAnchor(e.currentTarget, href);
          return;
        }
        // 项目内文件链接 → 解析并打开对应文件（.md/.mdx/其他代码文件均可）
        if (opts?.onLocalLink) void opts.onLocalLink(href).catch(error => useAppStore.getState().setBanner(String(error)));
        else void openMarkdownLink(href, baseDir);
      };
      return (
        <a href={href} {...props} onClick={onClick}>
          {children}
        </a>
      );
    },
    ...extra,
  };
}

/** Ready-to-use overrides for plain markdown views (no custom code renderer). */
export const mermaidMarkdownComponents = makeMarkdownComponents();
