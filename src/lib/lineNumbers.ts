/**
 * 行号栏（gutter）纯计算逻辑。
 *
 * 抽成模块的原因：行号与代码的对齐依赖一组「字体度量常量」，
 * 它们必须与 CSS 中 .file-code-textarea / .file-code-pre 的规则严格一致，
 * 差一个像素就会整列错位。集中在这里 + 单元测试，避免改 CSS 时漏改这边。
 */

/** 代码区默认字号（px）——对应 CSS `.file-code-textarea { font-size: var(--fs-code, 12px) !important }`。 */
export const CODE_FONT_SIZE = 12;

/**
 * 代码区行高倍数——对应 CSS `line-height: 1.6 !important`。
 * 行号栏用同样的 line-height，保证逐行对齐。
 */
export const CODE_LINE_HEIGHT_RATIO = 1.6;

/** 单行像素高度 = 字号 × 行高倍数（默认 12 × 1.6 = 19.2px）。 */
export function lineHeightFor(fontSize: number = CODE_FONT_SIZE): number {
  return fontSize * CODE_LINE_HEIGHT_RATIO;
}

/** 等宽字体单字符宽度 ≈ 0.6em（JetBrains Mono / Menlo 实测比例）。 */
export function charWidthFor(fontSize: number = CODE_FONT_SIZE): number {
  return fontSize * 0.604;
}

/** 默认字号下的行高/字宽常量（保留导出，兼容既有调用与测试）。 */
export const LINE_HEIGHT = lineHeightFor();
export const CHAR_WIDTH = charWidthFor();

/** 代码区顶部内边距——对应 Editor 的 `padding.top: 16`。 */
export const GUTTER_PAD_TOP = 16;

/** 行号文字右侧留白（px），与 CSS `.file-code-gutter-text { padding-right }` 一致。 */
export const GUTTER_TEXT_PAD_RIGHT = 10;

/** 行号栏左侧留白（px）。 */
export const GUTTER_TEXT_PAD_LEFT = 8;

/** 最少按几位数字预留宽度（避免小文件时行号栏过窄、位数变化时频繁抖动）。 */
export const MIN_GUTTER_DIGITS = 3;

/** 内容里的换行数 → 总行数（空内容算 1 行）。 */
export function countLines(content: string): number {
  let n = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) n++;
  }
  return n;
}

/**
 * 生成行号文本：用「单个文本节点 + \n 分隔」而非 N 个 DOM 元素，
 * 这样万行级文件的 DOM 节点数恒定（只有 1 个 span），滚动/渲染都不卡。
 * 配合 CSS `white-space: pre` + 相同行高即可与代码逐行对齐。
 */
export function buildLineNumbers(lineCount: number): string {
  if (lineCount <= 0) return '';
  const out: string[] = new Array(lineCount);
  for (let i = 0; i < lineCount; i++) out[i] = String(i + 1);
  return out.join('\n');
}

/** 行号栏宽度（px）：按最大行号的位数计算，至少 MIN_GUTTER_DIGITS 位。 */
export function gutterWidthFor(lineCount: number, fontSize: number = CODE_FONT_SIZE): number {
  const digits = Math.max(MIN_GUTTER_DIGITS, String(Math.max(1, lineCount)).length);
  return Math.ceil(GUTTER_TEXT_PAD_LEFT + digits * charWidthFor(fontSize) + GUTTER_TEXT_PAD_RIGHT);
}

/** 第 line 行（1 起）的行号基线顶部偏移（px），用于定位「当前行号」高亮块。 */
export function lineTopOffset(line: number, fontSize: number = CODE_FONT_SIZE): number {
  return GUTTER_PAD_TOP + (Math.max(1, line) - 1) * lineHeightFor(fontSize);
}
