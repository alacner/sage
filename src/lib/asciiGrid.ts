/**
 * CJK ASCII 图栅格计算（0.6.442）：
 * 制表符图（┌─│└…）在终端按「中文=2 半角=1」的栅格绘制，但浏览器里
 * 回退 CJK 字体（如 PingFang）的字宽 ≈1.67 个等宽半角，导致竖线参差。
 * 这里按 Unicode East Asian Width 把每行切成「全角/半角」游程，渲染层
 * （src/components/AsciiDiagram.tsx）用 width:Nch 强制落到精确栅格上。
 */

const CJK_RE = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFF60]/;
const BOX_RE = /[\u2500-\u259F]/g; // box drawing + block elements + geometric shapes

/** East Asian Wide / Fullwidth 码点区间（常见子集，覆盖中日韩与 emoji）。 */
const WIDE_RANGES: ReadonlyArray<[number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe52], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f000, 0x1faff], [0x20000, 0x3fffd],
];

export function charCols(ch: string): 1 | 2 {
  const cp = ch.codePointAt(0) ?? 0;
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return 2;
    if (cp < lo) break;
  }
  return 1;
}

/** 代码块内容是否为「含中文的制表符图」：多行 box 字符 + 出现 CJK 才需要网格化。 */
export function looksLikeCjkDiagram(text: string): boolean {
  if (!text || text.length < 50 || !CJK_RE.test(text)) return false;
  const boxLines = text.split('\n').filter((l) => (l.match(BOX_RE) ?? []).length >= 2);
  return boxLines.length >= 2;
}

export interface GridRun { s: string; cols: number; wide: boolean; }

/** 按显示宽度把一行切成全角/半角游程（合并相邻同宽字符，控制 DOM 规模）。 */
export function splitRuns(line: string): GridRun[] {
  const runs: GridRun[] = [];
  for (const ch of line) {
    const cols = charCols(ch);
    const last = runs[runs.length - 1];
    if (last && last.wide === (cols === 2)) {
      last.s += ch;
      last.cols += cols;
    } else {
      runs.push({ s: ch, cols, wide: cols === 2 });
    }
  }
  return runs;
}

/** 行内是否含全角字符（纯半角行等宽天然对齐，无需网格化）。 */
export function hasWide(line: string): boolean {
  for (const ch of line) if (charCols(ch) === 2) return true;
  return false;
}
