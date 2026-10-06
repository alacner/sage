/**
 * mermaid 图表配色：全部从应用主题 token 推导。
 *
 * 为什么要自己算：mermaid 的 'default' / 'dark' 主题自带一整套调色板（深色下节点底
 * #1f1f1f、文字 #ccc 那类），用户在「主题配色」里改了前景/背景/主色，图里一点不动，
 * 看起来就像贴了张别人家的截图。改成 theme:'base' + themeVariables 后，
 * 颜色全部来自背景 / 前景 / 主色 / 边框这一整套 CSS 变量，跟随主题且能被高级配色覆盖。
 *
 * 三条实测出来的口径（mermaid 11.15，改动前请先跑 scripts/test-mermaid-theme.mts）：
 * 1. theme:'base' 下 themeVariables 里给的键**优先于**它的派生规则（源码是 `x = x || 派生值`），
 *    所以只需给一组"种子色"，actor/state/task/label 等几十个键会自动跟着变。
 * 2. 但有两类键给了也没用：cScale0..11 会被强制 darken(…,75%)、git0..7 会被强制
 *    加减 25% 亮度 —— 后者我们仍给车道色，因为偏移后仍是同一套色相，只是不那么"精确"。
 * 3. 颜色必须是**实色 hex**：rgba 交给 mermaid 的亮度函数会算出 NaN 色。而 --border、
 *    --accent-soft 在界面里恰好是 rgba，所以进门先合成（compositeOver / tint）。
 */

import {
  APPEARANCE_COLOR_TOKENS,
  bestContrastColor,
  compositeOver,
  deriveAccentSoft,
  tint,
} from '../../shared/appearance';
import {GIT_BRANCH_LANES, GIT_BRANCH_LANES_LIGHT} from '../../shared/plugins/git-colors';

/** 图表用到的 token（已全部合成为实色）。 */
export interface MermaidThemeColors {
  dark: boolean;
  accent: string;
  accentSoft: string;
  bg0: string;
  bg1: string;
  bg2: string;
  bg3: string;
  text: string;
  textDim: string;
  textMute: string;
  border: string;
  ok: string;
  warn: string;
  err: string;
  info: string;
  /** 分类调色板（与 Git 插件分支车道线同一份）。 */
  lanes: ReadonlyArray<string>;
}

/** 读一个 CSS 变量的原始值（可能是 rgba / hex / 空串）。 */
export type CssColorReader = (varName: string) => string;

const TOKEN_DEFAULT_BY_VAR: Record<string, { light: string; dark: string }> = Object.fromEntries(
  APPEARANCE_COLOR_TOKENS.map((t) => [t.varName, t.defaults]),
);

/**
 * 把界面上的 CSS 变量解析成一组实色。
 * 读不到（宿主还没挂载、或运行环境不支持自定义属性）就退回 token 内置默认值：
 * 默认值与 index.css 同源（有测试守着），所以退回来的颜色和界面底色仍然一致。
 */
export function resolveMermaidColors(read: CssColorReader, mode: 'light' | 'dark'): MermaidThemeColors {
  const dark = mode === 'dark';
  const raw = (varName: string): string => {
    const value = read(varName);
    if (value && value.trim()) return value.trim();
    return TOKEN_DEFAULT_BY_VAR[varName]?.[mode] ?? '';
  };
  const bg1 = raw('--bg-1');
  const solid = (varName: string): string => compositeOver(raw(varName), bg1);
  const accent = solid('--accent');
  // --accent-soft 是派生变量（不是可调 token）：读得到就用，读不到按同样规则现算。
  const softRaw = read('--accent-soft');
  return {
    dark,
    accent,
    accentSoft: softRaw && softRaw.trim() ? compositeOver(softRaw.trim(), bg1)
      : tint(accent, bg1, dark ? 0.12 : 0.08),
    bg0: solid('--bg-0'),
    bg1,
    bg2: solid('--bg-2'),
    bg3: solid('--bg-3'),
    text: solid('--text'),
    textDim: solid('--text-dim'),
    textMute: solid('--text-mute'),
    border: tint(solid('--text-dim'), bg1, 0.55),
    ok: solid('--ok'),
    warn: solid('--warn'),
    err: solid('--err'),
    info: solid('--info'),
    lanes: (dark ? GIT_BRANCH_LANES : GIT_BRANCH_LANES_LIGHT).map((hex) => compositeOver(hex, bg1)),
  };
}

/** mermaid 自带的 base 调色板里这些值与界面无关，逐个换成 token。 */
export function mermaidThemeVariables(c: MermaidThemeColors): Record<string, string | number | boolean> {
  const lane = (i: number): string => c.lanes[i % c.lanes.length];
  // darkMode / useGradient 必须是真布尔：mermaid 内部直接当条件用，给字符串 'false' 是假话。
  const vars: Record<string, string | number | boolean> = {
    darkMode: c.dark,
    background: c.bg1,
    // 界面里没有渐变质感，节点用平色 + 主色描边
    useGradient: false,
    dropShadow: 'none',
    // 节点底色压一层淡淡的主色，既跟卡片区分得开，又不会跳出配色体系
    primaryColor: c.accentSoft,
    primaryBorderColor: c.accent,
    primaryTextColor: c.text,
    secondaryColor: c.bg2,
    secondaryBorderColor: c.border,
    secondaryTextColor: c.text,
    tertiaryColor: c.bg3,
    tertiaryBorderColor: c.border,
    tertiaryTextColor: c.textDim,
    textColor: c.text,
    nodeTextColor: c.text,
    lineColor: c.textDim,
    arrowheadColor: c.textDim,
    defaultLinkColor: c.textDim,
    edgeLabelBackground: c.bg1,
    clusterBkg: c.bg0,
    clusterBorder: c.border,
    titleColor: c.text,
    // 备注：淡染的警告色（保留"这是条备注"的语义，又不抄 mermaid 的 #fff5ad）
    noteBkgColor: tint(c.warn, c.bg1, 0.16),
    noteTextColor: c.text,
    noteBorderColor: tint(c.warn, c.bg1, 0.45),
    // 时序图
    actorBkg: c.accentSoft,
    actorBorder: c.accent,
    actorTextColor: c.text,
    actorLineColor: c.border,
    signalColor: c.textDim,
    signalTextColor: c.text,
    labelBoxBkgColor: c.bg2,
    labelBoxBorderColor: c.border,
    labelTextColor: c.text,
    loopTextColor: c.text,
    activationBkgColor: tint(c.accent, c.bg1, 0.22),
    activationBorderColor: c.accent,
    // 序号画在主色圆点上 → 取前景/卡片里对比度更高的那个当反白字
    sequenceNumberColor: bestContrastColor(c.accent, [c.text, c.bg1]),
    // 状态图 / 类图 / 需求图
    stateBkg: c.accentSoft,
    stateLabelColor: c.text,
    transitionColor: c.textDim,
    transitionLabelColor: c.text,
    labelBackgroundColor: c.bg1,
    compositeBackground: c.bg0,
    compositeTitleBackground: c.bg1,
    compositeBorder: c.border,
    altBackground: c.bg2,
    classText: c.text,
    requirementBackground: c.bg1,
    requirementBorderColor: c.border,
    requirementTextColor: c.text,
    relationColor: c.textDim,
    relationLabelBackground: c.bg1,
    relationLabelColor: c.text,
    // 甘特图：mermaid 写死的 lightgrey / white / red / navy 全部换掉
    sectionBkgColor: c.bg2,
    sectionBkgColor2: c.bg1,
    altSectionBkgColor: c.bg1,
    excludeBkgColor: tint(c.textMute, c.bg1, 0.18),
    taskBkgColor: tint(c.accent, c.bg1, 0.45),
    taskBorderColor: c.accent,
    activeTaskBkgColor: c.accent,
    activeTaskBorderColor: c.accent,
    doneTaskBkgColor: tint(c.textMute, c.bg1, 0.35),
    doneTaskBorderColor: c.border,
    critBkgColor: tint(c.err, c.bg1, 0.35),
    critBorderColor: c.err,
    gridColor: c.border,
    todayLineColor: c.info,
    vertLineColor: c.info,
    taskTextColor: c.text,
    taskTextOutsideColor: c.text,
    taskTextLightColor: bestContrastColor(c.accent, [c.text, c.bg1]),
    taskTextDarkColor: c.text,
    taskTextClickableColor: c.info,
    rowOdd: c.bg1,
    rowEven: c.bg2,
    personBkg: c.accentSoft,
    personBorder: c.accent,
    errorBkgColor: tint(c.err, c.bg1, 0.2),
    errorTextColor: c.err,
    // 分类图（饼图 / 象限 / 维恩 / git 图）：与 Git 插件分支车道线同一套调色板
    scaleLabelColor: c.text,
    pieTitleTextColor: c.text,
    pieSectionTextColor: c.text,
    pieLegendTextColor: c.text,
    pieStrokeColor: c.bg1,
    pieOuterStrokeColor: c.bg1,
    vennTitleTextColor: c.text,
    vennSetTextColor: c.text,
    branchLabelColor: c.text,
    commitLabelColor: c.text,
    commitLabelBackground: c.bg1,
    tagLabelColor: c.text,
    tagLabelBackground: c.bg1,
    tagLabelBorder: c.border,
    archEdgeColor: c.textDim,
    archEdgeArrowColor: c.textDim,
    archGroupBorderColor: c.border,
    quadrant1Fill: c.bg1,
    quadrant2Fill: c.bg2,
    quadrant3Fill: c.bg2,
    quadrant4Fill: c.bg3,
    quadrantTitleFill: c.text,
    quadrantPointFill: c.accent,
    quadrantPointTextFill: c.text,
    quadrantXAxisTextFill: c.textDim,
    quadrantYAxisTextFill: c.textDim,
    quadrantInternalBorderStrokeFill: c.border,
    quadrantExternalBorderStrokeFill: c.border,
    wardleyEvolutionColor: c.err,
  };
  for (let i = 0; i < 12; i++) vars[`pie${i + 1}`] = lane(i);
  for (let i = 0; i < 8; i++) {
    vars[`venn${i + 1}`] = lane(i);
    vars[`git${i}`] = lane(i);
    // git 分支标签的文字压在分支色上；mermaid 会先把分支色加减 25% 亮度，
    // 所以对比色按"原始车道色"算就够（偏移后明暗关系不会反转）。
    vars[`gitInv${i}`] = bestContrastColor(lane(i), [c.text, c.bg1]);
    vars[`gitBranchLabel${i}`] = vars[`gitInv${i}`];
  }
  return vars;
}

/** 当前界面模式：以 <html data-theme> 为准（theme.ts 维护）。 */
export function currentThemeMode(): 'light' | 'dark' {
  return typeof document !== 'undefined' && document.documentElement?.dataset?.theme === 'dark' ? 'dark' : 'light';
}

/**
 * 给 mermaid.initialize 用的配色配置（字体部分见 mermaidFont.ts，两边各自返回
 * themeVariables，调用方合并，别互相覆盖）。
 */
export function mermaidThemeOptions(host?: HTMLElement | null): { theme: 'base'; themeVariables: Record<string, string | number | boolean> } {
  // 没挂载完（host 为空）时退到文档根节点：CSS 变量在 <html> 上同样能读到，
  // 两者都读不到时 resolveMermaidColors 会退回 token 默认色。
  const doc = host?.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
  const view = doc?.defaultView;
  const el = host ?? doc?.documentElement;
  const read: CssColorReader = (varName) => {
    if (!view || !el) return '';
    try {
      return view.getComputedStyle(el).getPropertyValue(varName) ?? '';
    } catch {
      return '';
    }
  };
  const colors = resolveMermaidColors(read, currentThemeMode());
  const vars = mermaidThemeVariables(colors);
  const overrides: Record<string, string[]> = {
    '--mermaid-background': ['background', 'edgeLabelBackground', 'labelBackgroundColor'],
    '--mermaid-node': ['primaryColor', 'actorBkg', 'stateBkg', 'classBackground', 'requirementBackground'],
    '--mermaid-text': ['primaryTextColor', 'textColor', 'nodeTextColor', 'actorTextColor', 'stateLabelColor', 'classText'],
    '--mermaid-border': ['primaryBorderColor', 'actorBorder', 'requirementBorderColor'],
    '--mermaid-line': ['lineColor', 'defaultLinkColor', 'signalColor', 'signalTextColor'],
  };
  for (const [name, keys] of Object.entries(overrides)) {
    const color = read(name).trim();
    if (color) for (const key of keys) vars[key] = compositeOver(color, colors.bg1);
  }
  return { theme: 'base', themeVariables: vars };
}
