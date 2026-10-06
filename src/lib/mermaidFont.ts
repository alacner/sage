/**
 * mermaid 渲染配置里与「字体」有关的部分。
 *
 * 为什么单独抽出来：图里的字必须和图外面的正文一致，而这两件事在 mermaid 里
 * 走的是两条完全不同的路，踩过的坑都写在下面，改动时请连 scripts/test-mermaid-font.mts 一起看。
 *
 * 1. 字族：`fontFamily: 'inherit'` 有效。mermaid 会把它写进生成的样式
 *    （实测 `#id{font-family:inherit}`），于是 SVG 继承 body 的 --font-ui（外观设置里
 *    用户可换字体），图内图外同一套字。
 * 2. 字号：**顶层 config.fontSize 不生效**（实测传 12.5px 后产物仍是 `font-size:16px`），
 *    唯一有效的入口是 `themeVariables.fontSize`。mermaid 默认 16px，而正文继承
 *    body 的 12.5px → 图里的字比周围大 28%，节点框也跟着撑大。
 * 3. 所以字号必须按「这块图实际所在的容器」量出来，不能写死：
 *    文档预览、聊天气泡、全屏阅读各自的 font-size 可能不同。
 */

/** 兜底字号：与 index.css 里 body 的 font-size 保持一致（量不到容器时用）。 */
export const FALLBACK_FONT_SIZE = '12.5px';

export interface MermaidFontOptions {
  fontFamily: string;
  themeVariables: { fontSize: string };
}

/**
 * 量出 host 实际生效的字号（含继承），生成 mermaid.initialize 需要的字体配置。
 * host 还没挂上、或计算值不可用时退回 FALLBACK_FONT_SIZE，绝不退回 mermaid 的 16px。
 */
export function mermaidFontOptions(host?: HTMLElement | null): MermaidFontOptions {
  const view = host?.ownerDocument?.defaultView;
  const raw = view && host ? view.getComputedStyle(host).fontSize : '';
  const px = Number.parseFloat(raw);
  return {
    fontFamily: 'inherit',
    themeVariables: { fontSize: Number.isFinite(px) && px > 0 ? `${px}px` : FALLBACK_FONT_SIZE },
  };
}
