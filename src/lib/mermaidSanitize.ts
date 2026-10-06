/**
 * Mermaid 源码自动修正（纯函数模块，无 React / DOM 依赖，便于单测）。
 *
 * 为什么需要：AI 生成的 mermaid 图表经常踩到词法器不接受的字符（中文括号、
 * 斜杠、冒号等出现在未加引号的标签里），渲染直接报 Lexical error。
 * Wiki / 对话里的图表用户无法手改源码，只能在渲染层做容错。
 *
 * 修正原则：**只在原样渲染失败后调用**，给本来合法的标签加引号不改变
 * 渲染结果（无损修正）；对语义敏感的形状语法（平行四边形等）宁可不动。
 */

/**
 * mermaid 词法器在「未加引号」的 subgraph 标题 / 节点标签里不接受的字符。
 * 含全角括号：AI 生成的中文图表里两种括号都常见，一律加引号最稳妥。
 */
export const UNSAFE_LABEL_CHARS = /[(){}\[\]<>|;:@#$%^&*+=~`\\/,!?（）【】《》]/;

/**
 * 节点标签：三种形状各自匹配到自己的闭合符（单趟扫描）。
 * 关键：用一条带分支的正则一次扫完，String.replace 不会重扫替换结果，
 * 因此不会出现「先加引号、后一趟又把引号里的括号当标签」的二次破坏。
 * 字符类排除同类括号与引号，所以 A[["子程序"]] / F(("圆形")) 等特殊形状匹配不到，原样保留。
 */
export const NODE_LABEL_RE = /([A-Za-z_][\w-]*)\s*(?:\[([^\[\]"]*)\]|\(([^\(\)"]*)\)|\{([^\{\}"]*)\})/g;

/** 边标签 A -->|文本| B：排除引号，避免匹配到已加引号的节点标签内部。 */
export const EDGE_LABEL_RE = /\|([^|\n"]*)\|/g;

/** 给含特殊字符的标签补引号（已带引号 / 无特殊字符的原样返回）。 */
export function quoteIfNeeded(label: string, open: string, close: string, id: string, whole: string): string {
  const t = label.trim();
  if (!t || /^["']/.test(t) || !UNSAFE_LABEL_CHARS.test(t)) return whole;
  // 特殊形状保护：[/文本/] [\文本\] 是平行四边形/梯形，斜杠属于形状语法而非标签内容。
  // 加引号会把它降级成「显示字面斜杠的矩形」，属于语义破坏，宁可原样保留。
  if (open === '[' && /^[/\\][\s\S]*[/\\]$/.test(t)) return whole;
  return `${id}${open}"${t}"${close}`;
}

/**
 * 自动修正 AI 生成图表里的高发语法错误。
 *
 * 典型病例：
 *   subgraph 加密器插件 (dsc-app)                    → Lexical error: Unrecognized text
 *   REMOTE[远程加密服务 (ws://xxx/encrypt)]          → 同样炸在括号上
 *   INFRA[dsc-infrastructure KMS/DEW/WS 客户端]      → 斜杠也会炸
 *   A -->|WebSocket (wss)| B                        → 边标签同理
 *
 * 修正规则（仅在原样渲染失败后才应用，不动本来就合法的图表）：
 *   1. subgraph <标题>          → subgraph "<标题>"
 *   2. subgraph <id> [<标题>]   → subgraph <id> ["<标题>"]
 *   3. 节点标签 A[文本 (说明)]   → A["文本 (说明)"]（() {} 形状同理）
 *   4. 边标签 -->|文本 (x)|     → -->|"文本 (x)"|
 */
export function sanitizeMermaidSource(src: string): string {
  return src
    .split(/\r?\n/)
    .map((rawLine) => {
      // 注释行不动
      if (/^\s*%%/.test(rawLine)) return rawLine;

      // ── 规则 1 / 2：subgraph 标题 ──
      const sg = /^(\s*)subgraph\s+(.+?)\s*$/.exec(rawLine);
      if (sg) {
        const [, indent, rest] = sg;
        if (/^["']/.test(rest)) return rawLine; // 已加引号
        // subgraph <id> [<title>]
        const withId = /^([A-Za-z_][\w-]*)\s*\[(.*)\]$/.exec(rest);
        if (withId) {
          const title = withId[2].trim();
          if (!title || /^["']/.test(title) || !UNSAFE_LABEL_CHARS.test(title)) return rawLine;
          return `${indent}subgraph ${withId[1]} ["${title}"]`;
        }
        if (!UNSAFE_LABEL_CHARS.test(rest)) return rawLine;
        return `${indent}subgraph "${rest}"`;
      }

      // ── 规则 3：节点标签（必须先于边标签，边标签正则排除了引号才不会被误伤）──
      let line = rawLine.replace(
        NODE_LABEL_RE,
        (m: string, id: string, sq?: string, pa?: string, br?: string) => {
          if (sq !== undefined) return quoteIfNeeded(sq, '[', ']', id, m);
          if (pa !== undefined) return quoteIfNeeded(pa, '(', ')', id, m);
          if (br !== undefined) return quoteIfNeeded(br, '{', '}', id, m);
          return m;
        },
      );

      // ── 规则 4：边标签 ──
      line = line.replace(EDGE_LABEL_RE, (m: string, label: string) => {
        const t = label.trim();
        if (!t || !UNSAFE_LABEL_CHARS.test(t)) return m;
        return `|"${t}"|`;
      });

      return line;
    })
    .join('\n');
}
