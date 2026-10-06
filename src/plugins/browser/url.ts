/**
 * 浏览器 URL 规范化（补协议；不含域名的输入视为搜索词）。
 * 模块级纯函数：BrowserView 初始 src / 地址栏提交 / 侧边栏收藏添加共用。
 */
const KNOWN_SCHEMES = /^(?:https?|about|file|data):/i;
export function normalizeUrlInput(input: string): string {
  // 新建标签页/主页均为空白页：不再内置任何默认站点
  const text = input.trim();
  if (!text) return 'about:blank';
  // 已带协议（含 file://）原样放行：旧版只认 http(s)/about，
  // 导致 file:///… 被误补成 https://file:///… 而报 ERR_NAME_NOT_RESOLVED
  if (KNOWN_SCHEMES.test(text)) return text;
  // 本地绝对路径直接输入（/Users/…/dashboard.html）→ 转 file:// URL
  if (text.startsWith('/')) return `file://${text}`;
  if (text.includes('.') && !text.includes(' ')) return `https://${text}`;
  // Treat as search query
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}
