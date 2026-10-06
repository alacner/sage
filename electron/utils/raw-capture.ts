/**
 * HTTP 原始数据捕获：向 SDK client 注入自定义 fetch，录制真实请求
 * （URL / method / headers / body）与响应（status / headers / body），
 * 供请求监控器排查鉴权、网关行为等问题。
 *
 * 安全与体积约束：
 * - 鉴权类 header 的值脱敏（保留前缀便于排查"发错了哪把 key"）；
 * - 请求 / 响应 body 均截断到 MAX_RAW_BODY；
 * - 响应体随 SDK 拉取而捕获，保留背压，不提前读取整条响应；
 * - 捕获自身任何异常都静默吞掉，绝不影响真实请求。
 */

import type { MonitorRawRequest, MonitorRawResponse } from '../../shared/types';

const MAX_RAW_BODY = 50_000; // 与监控录制的大字段截断上限保持一致
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'set-cookie',
  'proxy-authorization',
]);

function maskHeader(name: string, value: string): string {
  if (!SENSITIVE_HEADERS.has(name.toLowerCase())) return value;
  return '[redacted]';
}

function capBody(s: string): string {
  if (s.length <= MAX_RAW_BODY) return s;
  const prefix = new TextDecoder().decode(new TextEncoder().encode(s.slice(0, MAX_RAW_BODY)));
  return prefix + `…(truncated ${s.length - MAX_RAW_BODY} chars)`;
}

/** 一次 HTTP 请求的捕获结果。 */
export interface RawCapture {
  request?: MonitorRawRequest;
  response?: MonitorRawResponse;
  /** 响应体捕获结束（流读完 / 取消 / 出错）时 resolve，永不 reject。 */
  bodyDone: Promise<void>;
}

/**
 * 捕获中枢：每次调用 begin() 开启一次捕获，包装后的 fetch 把结果写入
 * 当前活跃的 RawCapture。agentic 循环里每次迭代 begin() 一次即可。
 */
export class RawCaptureHub {
  constructor(private readonly delegate?: typeof fetch) {}
  private active: RawCapture | null = null;

  /** 开启一次新的捕获并返回结果容器。 */
  begin(): RawCapture {
    const cap: RawCapture = { bodyDone: Promise.resolve() };
    this.active = cap;
    return cap;
  }

  /** 传给 SDK client 的 fetch（Anthropic / OpenAI 均支持 fetch 选项）。 */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const cap = this.active;
    if (cap) {
      try {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        const headers: Record<string, string> = {};
        if (input instanceof Request) {
          input.headers.forEach((v, k) => (headers[k] = maskHeader(k, v)));
        }
        new Headers(init?.headers).forEach((v, k) => (headers[k] = maskHeader(k, v)));
        const body = typeof init?.body === 'string' ? capBody(init.body) : undefined;
        cap.request = { url, method, headers, body };
      } catch {
        /* 捕获失败不影响真实请求 */
      }
    }

    const res = await (this.delegate ?? fetch)(input, init);

    if (cap) {
      try {
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => (headers[k] = maskHeader(k, v)));
        const resp: MonitorRawResponse = {
          status: res.status,
          statusText: res.statusText,
          headers,
          body: '',
        };
        cap.response = resp;

        if (res.body) {
          // Read only on SDK demand. A draining tee would buffer the entire response
          // for a slow/aborted SDK consumer even after the diagnostic prefix is full.
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let total = 0, finished = false;
          const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
          let onAbort: (() => void) | undefined;
          let finish!: () => void;
          cap.bodyDone = new Promise<void>(resolve => { finish = resolve; });
          const complete = () => {
            if (finished) return;
            finished = true;
            resp.body = (resp.body ?? '') + decoder.decode();
            if (total >= MAX_RAW_BODY) resp.body += '…(capture limit reached)';
            if (onAbort) signal?.removeEventListener('abort', onAbort);
            reader.releaseLock();
            finish();
          };
          const main = new ReadableStream<Uint8Array>({
            start(controller) {
              onAbort = () => {
                if (finished) return;
                void reader.cancel(signal?.reason).catch(() => {}).finally(complete);
                controller.error(signal?.reason ?? new Error('Request aborted'));
              };
              signal?.addEventListener('abort', onAbort, {once:true});
              if (signal?.aborted) onAbort();
            },
            async pull(controller) {
              try {
                const {done, value} = await reader.read();
                if (done) { complete(); controller.close(); return; }
                const take = Math.min(value.byteLength, Math.max(0, MAX_RAW_BODY - total));
                if (take) resp.body = (resp.body ?? '') + decoder.decode(value.subarray(0, take), {stream:true});
                total += take;
                controller.enqueue(value);
              } catch (error) { complete(); controller.error(error); }
            },
            async cancel(reason) {
              try { await reader.cancel(reason); } finally { complete(); }
            },
          }, {highWaterMark: 0});
          return new Response(main, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          });
        }
      } catch {
        /* 捕获失败不影响真实响应 */
      }
    }
    return res;
  };
}
