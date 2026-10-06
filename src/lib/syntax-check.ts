/**
 * 打开文件时的语法检查 —— 按扩展名分派到成熟解析器，不自研词法/语法分析。
 *
 * 覆盖范围（刻意保守，全部是「零依赖或已有依赖」）：
 *  - JSON / JSONC / JS / TS / JSX / TSX → 项目已有的 typescript 包的**语法**诊断
 *      （createSourceFile().parseDiagnostics，等价于 tsc / VS Code 给的那些 syntactic
 *       diagnostics，不做类型检查）。JSON 也走它而不是 JSON.parse：V8 的新版报错
 *       消息只给一段上下文、不给行列，跳转会落空；而 ScriptKind.JSON 给的是准确
 *       行列，且天然容忍注释/尾逗号，所以 .jsonc 不会被误报。
 *  - YAML      → js-yaml（社区标准实现，报错自带行列 mark）
 *  - XML / SVG → 浏览器原生 DOMParser（parsererror 节点）
 *
 * 明确不覆盖：PHP / Java / Go / Python / Rust 等 —— 那些要么需要各自的语言服务器，
 * 要么需要引入几百 KB 的专用 parser 依赖，不符合「打开即检、不额外装工具链」。
 *
 * 所有解析器都走 dynamic import：typescript 单包就有几 MB，只有真打开对应类型文件
 * 时才会拉上那个 chunk，首屏零成本。
 */

export type SyntaxChecker = 'json' | 'yaml' | 'xml' | 'ts';

export interface SyntaxIssue {
  /** 1 起的行号（与编辑器跳转/行号栏一致）。 */
  line: number;
  /** 1 起的列号，拿不到时为 0。 */
  column: number;
  message: string;
  /** 解析器自己的错误码（typescript 的 diagnostic code 等），便于排查。 */
  code?: string;
}

export interface SyntaxReport {
  checker: SyntaxChecker;
  /** 按出现顺序排列，最多 MAX_ISSUES 条。空数组 = 语法通过。 */
  issues: SyntaxIssue[];
  /** 是否因为条数超限被截断。 */
  truncated: boolean;
}

/** 单个文件最多报几条：再多也看不完，且避免超大报错把 tooltip 撑爆。 */
export const MAX_ISSUES = 20;

/** 超过这个体积就不检查（几 MB 的文件解析会明显拖慢输入）。 */
export const MAX_CHECK_CHARS = 2_000_000;

const EXT_CHECKER: Record<string, SyntaxChecker> = {
  json: 'json',
  jsonc: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  xml: 'xml',
  svg: 'xml',
  ts: 'ts',
  tsx: 'ts',
  mts: 'ts',
  cts: 'ts',
  js: 'ts',
  jsx: 'ts',
  mjs: 'ts',
  cjs: 'ts',
};

/**
 * 该文件用哪个解析器检查；返回 null 表示不支持（不检查）。
 *
 * html 刻意排除：浏览器解析 HTML 几乎不报错（容错才是它的语义），报了也没参考价值。
 */
export function syntaxCheckerFor(relPath: string): SyntaxChecker | null {
  const base = relPath.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_CHECKER[ext] ?? null;
}

/** V8 / libxml 的报错里带 "at position N" 或 "line L column M"，两种都认。
 *  Chromium 的 XML 错误写的是 "error on line 3 at column 9"（中间夹 at），
 *  所以分隔符不能只认逗号/空白。 */
export function positionFromMessage(text: string, message: string): { line: number; column: number } {
  const lc = /line\s+(\d+)(?:[,.\s]|\s+at\s+)+column\s+(\d+)/i.exec(message);
  if (lc) return { line: Math.max(1, Number(lc[1])), column: Math.max(0, Number(lc[2])) };
  const pos = /position\s+(\d+)/i.exec(message);
  if (pos) return offsetToLineColumn(text, Number(pos[1]));
  return { line: 1, column: 0 };
}

export function offsetToLineColumn(text: string, offset: number): { line: number; column: number } {
  const safe = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < safe; i++) {
    if (text.charCodeAt(i) === 10) { line += 1; lineStart = i + 1; }
  }
  return { line, column: safe - lineStart + 1 };
}

function report(checker: SyntaxChecker, issues: SyntaxIssue[]): SyntaxReport {
  // 三个解析器都是单遍从左到右报诊断（js-yaml / DOMParser 只给第一条），所以不再多排一次序；
  // 回归测试 ⑥ 里的「按行升序」断言就是这一假设的回归锁，哪天上游开始乱序会当场报出来。
  return { checker, issues: issues.slice(0, MAX_ISSUES), truncated: issues.length > MAX_ISSUES };
}

// ── YAML ──────────────────────────────────────────────────────────

async function checkYaml(text: string): Promise<SyntaxReport> {
  const YAML = await import('js-yaml');
  try {
    // 多文档 YAML（--- 分隔）用 loadAll 才不会在第二个文档处误报
    YAML.loadAll(text);
    return report('yaml', []);
  } catch (err: any) {
    const mark = err?.mark;
    const message = String(err?.reason || err?.message || err || 'invalid YAML');
    const line = mark && typeof mark.line === 'number' ? mark.line + 1 : 1;
    const column = mark && typeof mark.column === 'number' ? mark.column + 1 : 0;
    return report('yaml', [{ line, column, message: message.slice(0, 300), code: err?.name }]);
  }
}

// ── XML / SVG ─────────────────────────────────────────────────────

/**
 * 从 DOMParser 的 parsererror 文本里提出行列和干净消息。
 *
 * Chromium 给的是整段“错误页”文本，形如：
 *   This page contains the following errors:
 *   error on line 3 at column 9: Opening and ending tag mismatch: root line 1 and wrong
 *   Below is a rendering of the page up to the first error.
 * 直接拿原文当 tooltip 会满屏废话，行列也会丢（实测会退到第 1 行）。
 */
export function parseXmlError(raw: string): { line: number; column: number; message: string } {
  const text = (raw || '').replace(/\s+/g, ' ').trim();
  const m = /error on line\s+(\d+)\s+at\s+column\s+(\d+)\s*:?\s*([\s\S]*)/i.exec(text);
  if (m) return { line: Math.max(1, Number(m[1])), column: Math.max(0, Number(m[2])), message: cleanXmlMessage(m[3]) };
  const { line, column } = positionFromMessage('', text);
  return { line, column, message: cleanXmlMessage(text.replace(/^[\s\S]*?following errors:/i, '')) };
}

function cleanXmlMessage(s: string): string {
  const cleaned = (s || '')
    // Chromium 不同版本里这句样板话是 "Below is a/the rendering of the page …"，两种都剥掉
    .replace(/below is (?:a|the) rendering of the page[\s\S]*$/i, '')
    .trim();
  return (cleaned || 'malformed XML').slice(0, 300);
}

async function checkXml(text: string): Promise<SyntaxReport> {
  if (typeof DOMParser === 'undefined') return report('xml', []); // 非浏览器环境（node 测试）不报假错
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (!err) return report('xml', []);
  const { line, column, message } = parseXmlError(err.textContent || '');
  return report('xml', [{ line, column, message }]);
}

// ── JSON / JS / TS（统一走 typescript 包的语法诊断，公开 API） ───────

async function checkWithTs(fileName: string, text: string, checker: 'json' | 'ts'): Promise<SyntaxReport> {
  const ts = await import('typescript');
  const scriptKind = checker === 'json' ? ts.ScriptKind.JSON : scriptKindFor(ts, fileName);
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, scriptKind);
  // parseDiagnostics 是 createSourceFile 当场就填好的**语法**诊断（不含类型检查）。
  // typescript 的 .d.ts 没把它挂在 SourceFile 接口上，但运行时一直存在（tsc 自己、
  // ts-server 都读它）；回归测试里有一条「非法文件必须报错」的断言守住这个假设。
  const diags = ((sf as unknown as {
    parseDiagnostics?: readonly { code: number; start: number; messageText: string | { messageText: string } }[];
  }).parseDiagnostics) ?? [];
  const issues: SyntaxIssue[] = [];
  for (const d of diags) {
    const raw = typeof d.messageText === 'string' ? d.messageText : d.messageText?.messageText ?? '';
    const pos = sf.getLineAndCharacterOfPosition?.(d.start ?? 0);
    const message = String(
      ts.flattenDiagnosticMessageText ? ts.flattenDiagnosticMessageText(raw, ' ') : raw,
    ).replace(/\s+/g, ' ').trim().slice(0, 300);
    issues.push({
      line: (pos?.line ?? 0) + 1,
      column: (pos?.character ?? 0) + 1,
      message,
      code: `TS${d.code}`,
    });
  }
  return report(checker, issues);
}

function scriptKindFor(ts: typeof import('typescript'), fileName: string): number {
  const ext = `.${(fileName.split('/').pop() || '').split('.').pop()?.toLowerCase()}`;
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * 检查一个文件；不支持的语言 / 超大文件 / 拿不到文本时返回 null（= 不检查，
 * 调用方据此不显示任何告警，避免把「不会检查」误显示成「语法正确」）。
 */
export async function checkSyntax(relPath: string, text: string): Promise<SyntaxReport | null> {
  const checker = syntaxCheckerFor(relPath);
  if (!checker || text.length > MAX_CHECK_CHARS) return null;
  switch (checker) {
    case 'json': return await checkWithTs(relPath, text, 'json');
    case 'ts': return await checkWithTs(relPath, text, 'ts');
    case 'yaml': return await checkYaml(text);
    case 'xml': return await checkXml(text);
  }
}
