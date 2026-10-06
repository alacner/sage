/**
 * 通用 HTTP 探针（主进程侧，不受浏览器 CORS 限制）。
 * 用于反馈 / 更新服务器地址自检：GET 一次，res.ok 视为服务正常。
 * 超时 / 网络错误 / 非 2xx 一律返回 ok:false，绝不抛异常（自检不得影响主流程）。
 */
export interface ProbeResult {
  ok: boolean;
  /** 实际探测的地址（未配置时为空串），供界面展示与排障。 */
  url: string;
  status?: number;
  /** 失败原因短文案：HTTP 状态 / timeout / not-configured / 网络错误信息。 */
  error?: string;
}

const PROBE_TIMEOUT_MS = 8000;

export async function probeHttp(
  url: string,
  timeoutMs = PROBE_TIMEOUT_MS,
  headers?: Record<string, string>,
  request: typeof fetch = fetch,
): Promise<ProbeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await request(url, { method: 'GET', redirect: headers?.authorization ? 'error' : 'follow', signal: ctrl.signal, headers });
    return res.ok
      ? { ok: true, url, status: res.status }
      : { ok: false, url, status: res.status, error: `HTTP ${res.status}` };
  } catch (e: any) {
    const error = e?.name === 'AbortError' ? 'timeout' : String(e?.message || e).slice(0, 120);
    return { ok: false, url, error };
  } finally {
    clearTimeout(timer);
  }
}

/** 校验是否合法 http(s) 地址（设置页传入的自定义地址覆盖用）。 */
export function isHttpUrl(u: string): boolean {
  return /^https?:\/\/.+/i.test(u.trim());
}
