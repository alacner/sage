/**
 * 文件扩展名 ↔ 语言 / Prism grammar / 文件树图标颜色的统一映射。
 *
 * 两个消费方：
 *  - <FileEditor>：根据扩展名挑 Prism grammar 做语法高亮。
 *  - <FileTree>：根据扩展名给文件图标着色，让目录树一眼能区分代码类型。
 *
 * 颜色取自常见的语言代表色（与各社区配色约定贴近），并复用应用主题里的
 * --info / --ok / --warn / --err / --accent 等变量做兜底，避免硬写死颜色
 * 与浅 / 深主题冲突。每条 entry 都给出 prism 字段用于编辑器；空字符串
 * 表示该扩展不强制高亮（编辑器回退到纯文本）。
 */
export interface LangInfo {
  /** Prism grammar 名（与 prismjs/components/prism-<x> 一一对应）。空字符串 = 纯文本。 */
  prism: string;
  /** 文件树图标颜色（CSS color 字符串或 var()）。 */
  color: string;
  /** 人类可读的语言名，用于编辑器右上角小标签。 */
  label: string;
}

const BY_EXT: Record<string, LangInfo> = {
  // TypeScript / JavaScript family — 同源同色但区分深浅
  ts:    { prism: 'typescript', color: '#3178c6', label: 'TypeScript' },
  tsx:   { prism: 'tsx',        color: '#3178c6', label: 'TSX' },
  mts:   { prism: 'typescript', color: '#3178c6', label: 'TypeScript' },
  cts:   { prism: 'typescript', color: '#3178c6', label: 'TypeScript' },
  js:    { prism: 'javascript', color: '#f7df1e', label: 'JavaScript' },
  jsx:   { prism: 'jsx',        color: '#f7df1e', label: 'JSX' },
  mjs:   { prism: 'javascript', color: '#f7df1e', label: 'JavaScript' },
  cjs:   { prism: 'javascript', color: '#f7df1e', label: 'JavaScript' },

  // 数据 / 配置
  json:  { prism: 'json',       color: '#cbcb41', label: 'JSON' },
  jsonc: { prism: 'json',       color: '#cbcb41', label: 'JSON' },
  yml:   { prism: 'yaml',       color: '#ec4899', label: 'YAML' },
  yaml:  { prism: 'yaml',       color: '#ec4899', label: 'YAML' },
  toml:  { prism: 'toml',       color: '#9c4221', label: 'TOML' },
  xml:   { prism: 'markup',     color: '#e34c26', label: 'XML' },
  svg:   { prism: 'markup',     color: '#ffb13b', label: 'SVG' },

  // Web 前端
  html:  { prism: 'markup',     color: '#e34c26', label: 'HTML' },
  htm:   { prism: 'markup',     color: '#e34c26', label: 'HTML' },
  vue:   { prism: 'markup',     color: '#41b883', label: 'Vue' },
  svelte:{ prism: 'markup',     color: '#ff3e00', label: 'Svelte' },
  css:   { prism: 'css',        color: '#563d7c', label: 'CSS' },
  scss:  { prism: 'css',        color: '#c6538c', label: 'SCSS' },
  sass:  { prism: 'css',        color: '#c6538c', label: 'Sass' },
  less:  { prism: 'css',        color: '#1d365d', label: 'Less' },

  // 文档（markdown 用 Seti 系蓝色，避免与 tab 文字同色失去圆点区分度）
  md:    { prism: 'markdown',   color: '#519aba', label: 'Markdown' },
  mdx:   { prism: 'markdown',   color: '#519aba', label: 'MDX' },
  txt:   { prism: '',           color: 'var(--text-mute)', label: 'Text' },

  // 后端 / 系统
  py:    { prism: 'python',     color: '#3572A5', label: 'Python' },
  go:    { prism: 'go',         color: '#00add8', label: 'Go' },
  rs:    { prism: 'rust',       color: '#dea584', label: 'Rust' },
  java:  { prism: 'java',       color: '#b07219', label: 'Java' },
  kt:    { prism: 'kotlin',     color: '#A97BFF', label: 'Kotlin' },
  rb:    { prism: 'ruby',       color: '#cc342d', label: 'Ruby' },
  php:   { prism: 'php',        color: '#4f5d95', label: 'PHP' },
  c:     { prism: 'c',          color: '#555555', label: 'C' },
  h:     { prism: 'c',          color: '#555555', label: 'C Header' },
  cc:    { prism: 'cpp',        color: '#f34b7d', label: 'C++' },
  cpp:   { prism: 'cpp',        color: '#f34b7d', label: 'C++' },
  hpp:   { prism: 'cpp',        color: '#f34b7d', label: 'C++ Header' },
  cs:    { prism: 'csharp',     color: '#178600', label: 'C#' },
  swift: { prism: 'swift',      color: '#FA7343', label: 'Swift' },

  // 脚本
  sh:    { prism: 'bash',       color: '#89e051', label: 'Shell' },
  bash:  { prism: 'bash',       color: '#89e051', label: 'Bash' },
  zsh:   { prism: 'bash',       color: '#89e051', label: 'Zsh' },
  fish:  { prism: 'bash',       color: '#89e051', label: 'Fish' },

  // DB / 其它
  sql:   { prism: 'sql',        color: '#dad8d8', label: 'SQL' },
  dockerfile: { prism: 'docker',color: '#384d54', label: 'Dockerfile' },
};

/**
 * 按文件名拿语言信息。优先看扩展名，扩展名查不到再看常见的特殊文件名
 * （Dockerfile / Makefile / .gitignore 等）。
 */
export function langInfoFor(filenameOrPath: string): LangInfo {
  const name = filenameOrPath.split('/').pop() ?? filenameOrPath;
  const lower = name.toLowerCase();

  // 整名特例：没扩展名但能识别的
  if (lower === 'dockerfile' || lower.endsWith('.dockerfile')) return BY_EXT.dockerfile;
  if (lower === 'makefile') return { prism: '', color: '#427819', label: 'Makefile' };
  if (lower === '.gitignore' || lower === '.gitattributes' || lower.startsWith('.env')) {
    return { prism: '', color: 'var(--text-mute)', label: 'Config' };
  }

  const ext = lower.includes('.') ? lower.split('.').pop()! : '';
  return BY_EXT[ext] ?? { prism: '', color: 'var(--text-mute)', label: ext ? ext.toUpperCase() : 'File' };
}

/**
 * Prism grammar 名 → 是否已经被 import 进 prism 全局对象。
 *
 * 我们只在 FileEditor 那一侧 import 一组 grammar；这个集合用来在 FileEditor
 * 里做兜底（请求的 grammar 没装时回退到纯文本，避免 Prism 报 undefined）。
 */
export const SUPPORTED_PRISM_GRAMMARS = new Set<string>([
  'typescript', 'tsx', 'javascript', 'jsx',
  'json', 'yaml', 'toml', 'markup', 'css',
  'markdown', 'bash', 'python', 'sql',
  // 后端 / 系统语言（FileEditor 与 PhasePanel 按依赖顺序 import）
  'c', 'cpp', 'csharp', 'java', 'kotlin', 'php',
  'go', 'rust', 'ruby', 'swift', 'docker',
]);

/** 判断是否是图片文件（通过扩展名）。 */
export function isImageFile(filenameOrPath: string): boolean {
  const name = filenameOrPath.split('/').pop() ?? filenameOrPath;
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext);
}

/** 判断是否是 markdown 文件（通过扩展名）。 */
export function isMarkdownFile(filenameOrPath: string): boolean {
  const name = filenameOrPath.split('/').pop() ?? filenameOrPath;
  const lower = name.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.mdx');
}

/** 判断是否是 HTML 文件（通过扩展名），支持源码/预览切换。 */
export function isHtmlFile(filenameOrPath: string): boolean {
  const name = filenameOrPath.split('/').pop() ?? filenameOrPath;
  const lower = name.toLowerCase();
  return lower.endsWith('.html') || lower.endsWith('.htm') || lower.endsWith('.xhtml');
}

/** 判断是否是 JSON 文件（通过扩展名），用于显示美化按钮。 */
export function isJsonFile(filenameOrPath: string): boolean {
  const name = filenameOrPath.split('/').pop() ?? filenameOrPath;
  const lower = name.toLowerCase();
  return lower.endsWith('.json') || lower.endsWith('.jsonc');
}

/** 是否支持「源码 / 预览」切换的文件类型（markdown 或 HTML）。 */
export function isPreviewableFile(filenameOrPath: string): boolean {
  return isMarkdownFile(filenameOrPath) || isHtmlFile(filenameOrPath);
}
