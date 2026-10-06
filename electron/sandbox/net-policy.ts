/** WebFetch rules: explicit deny first, allow matches next, unmatched URLs require approval. */

/**
 * 默认允许的域名白名单（覆盖常见开发场景）。
 * 支持三种写法：
 * - 精确：`api.anthropic.com`
 * - 通配符：`*.google.com`（匹配该域的所有子域及裸域）
 * - 正则：`/\.google\.(com|com\.hk)$/`（以 / 开头，以 / 结尾）
 * 用户可在"设置 → 安全"面板覆盖。
 */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
  // AI/模型 API（必须放行，否则对话本身无法工作）
  'api.anthropic.com',
  'api.openai.com',
  // 包管理 / 源码（构建/装依赖需要）
  'registry.npmjs.org',
  'registry.npmmirror.com',
  '*.github.com',
  'github.com',
  'codeload.github.com',
  '*.githubusercontent.com',
  'pypi.org',
  'files.pythonhosted.org',
  'proxy.golang.org',
  'sum.golang.org',
  'goproxy.cn',
  // 文档查询（AI 常用）
  'developer.mozilla.org',
  'stackoverflow.com',
  '*.stackoverflow.com',
  'nodejs.org',
  'docs.anthropic.com',
  'docs.claude.com',
  'packagist.org',
  'repo1.maven.org',
  'search.maven.org',
  // 搜索引擎（AI 查资料用；通配符匹配各域名的子域变体）
  '*.google.com',
  '*.baidu.com',
  '*.bing.com',
  '*.duckduckgo.com',
  '*.sogou.com',
  '*.so.com',
  '*.yahoo.com',
  // 常用百科
  '*.wikipedia.org',
];


import { getSandboxOverrides } from '../main';

/** 从用户配置的 modelProviders 提取 baseUrl 域名，运行时动态加入白名单。 */
export function getAllowedHosts(
  userProviderBaseUrls?: Array<string | undefined>,
): string[] {
  const settings=getSandboxOverrides();
  if(settings?.allowEnabled?.net===false)return [];
  const overrides = settings?.net;
  // 用户覆盖则完整替换，不存在则用默认值
  const baseHosts = overrides?.allowedHosts ?? [...DEFAULT_ALLOWED_HOSTS];

  const extra: string[] = [];
  for (const url of userProviderBaseUrls ?? []) {
    if (!url) continue;
    try {
      const u = new URL(url);
      extra.push(u.host);
    } catch {
      /* ignore invalid */
    }
  }
  // 去重合并
  return Array.from(new Set([...baseHosts, ...extra]));
}

/** 检查结果。 */
export interface NetCheckResult {
  ok: boolean;
  reason?: string;
  decision?: 'allow' | 'ask' | 'deny';
}

/**
 * 内网/回环/链路本地地址判定（SSRF 兵线）：默认拒绝，防止模型输出驱动
 * WebFetch 探测本机服务或云元数据端点；用户显式把主机名加入 allowedHosts
 * 可豁免（本地开发调试场景）。DNS 重绑定/重定向逐跳校验需由 fetch 侧配合。
 */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[(.*)\]$/, '$1'); // 去 IPv6 方括号
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::' || h === '::1' || h.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/i.test(h)) return true;
  if (/^127\./.test(h) || h === '0.0.0.0') return true;              // 回环
  if (/^10\./.test(h) || /^192\.168\./.test(h)) return true;         // 私网
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;             // 私网
  if (/^169\.254\./.test(h)) return true;                            // 链路本地/云元数据
  // 十进制/十六进制编码的 127.0.0.1 等变形（如 2130706433、0x7f000001）
  if (/^(0x[0-9a-f]+|\d{5,})$/i.test(h)) {
    const n = /^0x/i.test(h) ? parseInt(h, 16) : parseInt(h, 10);
    if (Number.isFinite(n) && ((n >>> 24) === 127 || (n >>> 24) === 10 || (n >>> 24) === 0)) return true;
  }
  return false;
}

/** 单个白名单条目是否命中主机（精确/通配符/正则三种语义）。 */
function matchesHostPattern(host: string, pattern: string): boolean {
  if (pattern.startsWith('/')) {
    try {
      let body = pattern.slice(1);
      if (body.endsWith('/')) body = body.slice(0, -1);
      return new RegExp(body).test(host);
    } catch { return false; }
  }
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // ".example.com"
    const base = pattern.slice(2);   // "example.com"
    return host === base || host.endsWith(suffix);
  }
  return host === pattern;
}

/**
 * 校验一个 URL 是否允许访问。
 *
 * 匹配规则（按顺序）：
 * 1. 协议必须是 http/https；
 * 2. 内网/元数据地址默认拒绝（除非 allowed 显式命中）；
 * 3. 精确匹配：`api.anthropic.com`
 * 4. 通配符：`*.google.com` 匹配 google.com 的所有子域
 * 5. 正则：以 `/` 开头的条目视为正则表达式，对 host 做 test
 *
 * @param url 待校验的完整 URL
 * @param allowed 允许的域名列表（来自 getAllowedHosts）
 */
export function checkUrl(url: string, allowed: string[]): NetCheckResult {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, decision:'deny', reason: '非法 URL' };
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, decision:'deny', reason: `协议 ${u.protocol} 不允许` };
  }

  if (getSandboxOverrides()?.runtime?.fullAccess) return {ok:true};
  const host = u.host;
  // SSRF 拦截用无端口主机名（localhost:3000 → localhost）；白名单匹配维持原有 host（含端口）语义。
  // 豁免比对时去掉条目端口：provider baseUrl 自动入白名单时带端口（localhost:5173），否则本地中继会被误封。
  const ssrfExempt = allowed.some(p => matchesHostPattern(u.hostname, p.replace(/:\d+$/, '')));
  if (isPrivateHost(u.hostname) && !ssrfExempt) {
    return { ok: false, decision:'deny', reason: `内网/本地地址 ${u.hostname} 默认拒绝（SSRF 防护）；如需访问请在 设置 → 安全 显式加入白名单` };
  }
  const deniedRule=(getSandboxOverrides()?.net?.deniedHosts ?? []).find(p=>matchesHost(host,p));
  if(deniedRule!==undefined)return {ok:false,decision:'deny',reason:`域名 ${host} 命中 net.deniedHosts：${deniedRule}`};

  for (const pattern of allowed) {
    // 精确 / 通配符 / 正则三种语义统一由 matchesHostPattern 判定
    if (matchesHostPattern(host, pattern)) {
      return { ok: true, reason: `域名 ${host} 命中 net.allowedHosts：${pattern}` };
    }
  }

  return { ok: false, decision:'ask', reason: `域名 ${host} 未命中直接允许规则，需要审核` };
}

function matchesHost(host:string, pattern:string):boolean {
  if(pattern.startsWith('/')){try{return new RegExp(pattern.slice(1,pattern.endsWith('/')?-1:undefined)).test(host)}catch{return false}}
  return pattern.startsWith('*.') ? host===pattern.slice(2)||host.endsWith(pattern.slice(1)) : host===pattern;
}
