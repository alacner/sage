/**
 * 反馈提交（客户端侧）
 *
 * 反馈固定使用已连接中继的 /feedback，携带对应 Client Token。
 * 自定义反馈地址已废弃；客户端标识不能替代 Token 鉴权。
 */
import { app, screen, type WebContents } from 'electron';
import os from 'node:os';
import { readSettings } from './main';
import { readAuditLog } from './sandbox/audit-log';
import { probeHttp, type ProbeResult } from './net-probe';
import { isPrivateHost } from './sandbox/net-policy';
import { relayService } from './relay-services';

/** 渲染层提交的原始反馈表单。 */
export interface FeedbackSubmission {
  type: string;
  details: string;
  email?: string;
  /** base64 附件（截图），单张 ≤20MB、最多 5 张（界面与服务端同口径约束）。 */
  attachments: Array<{ name: string; mime: string; data: string }>;
  includeSessionLog: boolean;
  includeSystemInfo: boolean;
  includeConfig: boolean;
  /** 渲染层提供的会话摘要（主进程不持有对话内存态）。 */
  session?: {
    projectPath?: string;
    conversationTitle?: string;
    recentMessages?: Array<{ role: string; ts?: number; text: string }>;
  };
}

export interface FeedbackResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export async function captureFeedbackScreenshot(sender: WebContents): Promise<string> {
  const image = await sender.capturePage();
  if (image.isEmpty()) throw new Error('Window screenshot is empty');
  const png = image.toPNG();
  if (png.length > 20 * 1024 * 1024) throw new Error('Window screenshot exceeds the attachment size limit');
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** 生效的反馈服务器地址（未配置返回 undefined）。 */
export async function effectiveFeedbackUrl(): Promise<string | undefined> {
  const settings = await readSettings();
  const src = settings.relayUrl?.trim();
  if (src) {
    // 与更新同源策略：公网 ws:// 不推导明文 http 反馈通道（反馈正文可能含审计日志）；局域网自托管除外。
    if (/^ws:/i.test(src)) {
      try {
        if (!isPrivateHost(new URL(src).hostname)) return undefined;
      } catch { return undefined; }
    }
    const base = src.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:').replace(/\/+$/, '');
    return `${base}/feedback`;
  }
  return undefined;
}

/**
 * 反馈服务自检：携带当前中继 Token 请求 /feedback/status。
 * 旧 urlOverride 参数仅为调用兼容保留，不再允许覆盖中继地址。
 */
export async function probeFeedbackService(urlOverride?: string): Promise<ProbeResult> {
  try {
    const service = relayService(await readSettings());
    return await probeHttp(`${service.base}/feedback/status`, 8000, service.headers, service.request);
  } catch { return {ok:false,url:'',error:'relay-unavailable'}; }
}

/** 非敏感配置摘要：只取排障有用的开关类字段，不含任何密钥/Token。 */
function configSummary(settings: Record<string, any>): Record<string, unknown> {
  return {
    language: settings.language,
    theme: settings.theme,
    preferredBackend: settings.preferredBackend,
    markdownDefaultView: settings.markdownDefaultView,
    showLineNumbers: settings.showLineNumbers,
    preventSleep: !!settings.preventSleep,
    autoCheckUpdates: settings.autoCheckUpdates,
    updateServerUrl: settings.updateServerUrl ? '(custom)' : undefined,
    relayEnabled: !!settings.relayEnabled,
    contextStrategy: settings.contextStrategy,
    expertsMaxParallel: settings.expertsMaxParallel,
    maxImageMB: settings.maxImageMB,
    maxTextFileMB: settings.maxTextFileMB,
    modelProviders: Array.isArray(settings.modelProviders)
      ? settings.modelProviders.map((p: any) => ({ id: p?.id, protocol: p?.protocol }))
      : undefined,
    selectedModel: settings.selectedModel,
  };
}

/** 提交反馈：拼装客户端/系统/会话上下文后 POST 到反馈服务器。 */
export async function submitFeedback(sub: FeedbackSubmission): Promise<FeedbackResult> {
  const settings = (await readSettings()) as unknown as Record<string, any>;
  // 用户可见错误串按应用语言返回（与服务端 x-lang 口径一致）
  const en = settings.language === 'en';
  let service: ReturnType<typeof relayService>;
  try { service = relayService(settings); }
  catch { return {ok:false,error:en?'Connect the relay with a valid Client Token first':'请先连接中继并配置有效客户端 Token'}; }
  const url = `${service.base}/feedback`;
  // 反馈正文可能含审计日志/系统信息：公网强制 https，仅私网/回环允许 http（本地测试）。
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' && !isPrivateHost(u.hostname)) {
      return {
        ok: false,
        error: en
          ? 'Feedback over plaintext http to a public host is not allowed; use an https feedback server URL'
          : '不允许向公网明文 http 反馈服务器提交（可能含会话日志）：请改用 https 地址',
      };
    }
  } catch {
    return { ok: false, error: en ? 'Invalid feedback server URL' : '反馈服务器地址无效' };
  }
  // 详情与附件二选一：任一有内容即可提交
  if (!sub.details?.trim() && (sub.attachments?.length ?? 0) === 0) {
    return {
      ok: false,
      error: en
        ? 'Feedback details and attachments cannot both be empty (either one is enough)'
        : '反馈详情与附件不能都为空（二选一即可）',
    };
  }

  const context: Record<string, unknown> = {};
  if (sub.includeSessionLog) {
    const audit = readAuditLog(200);
    context.sessionLog = {
      auditTail: audit.error ? undefined : audit.entries,
      auditError: audit.error,
      conversation: sub.session ?? null,
    };
  }
  if (sub.includeSystemInfo) {
    context.systemInfo = {
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      locale: app.getLocale(),
      screen: (() => {
        try {
          const b = screen.getPrimaryDisplay().bounds;
          return `${b.width}x${b.height}`;
        } catch {
          return undefined;
        }
      })(),
    };
  }
  if (sub.includeConfig) {
    context.config = configSummary(settings);
  }

  const body = {
    ts: Date.now(),
    type: sub.type,
    details: sub.details.trim(),
    email: sub.email?.trim() || undefined,
    attachments: sub.attachments,
    context,
    client: { name: 'sage-desktop', version: app.getVersion(), platform: process.platform },
  };

  try {
    const res = await service.request(`${url.replace(/\/+$/, '')}/submit`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        // Resolve the current credential in the main process. The server persists its stable client ID.
        ...service.headers,
        'content-type': 'application/json',
        // 与更新请求同口径的客户端标识：服务端据此验证来自 Sage 客户端
        'x-sage-client': 'sage-desktop',
        // 服务端按此头返回对应语言的错误/警示消息
        'x-lang': en ? 'en' : 'zh',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      // 服务端结构化错误（黑名单拦截/限频警示等）原样透出供界面提示；非 JSON 回落状态码
      try {
        const j = JSON.parse(text) as { error?: string };
        if (j?.error) return { ok: false, error: j.error };
      } catch {
        /* 忽略非 JSON 响应体 */
      }
      return { ok: false, error: en ? `Server returned ${res.status}: ${text.slice(0, 200)}` : `服务器返回 ${res.status}：${text.slice(0, 200)}` };
    }
    let id: string | undefined;
    try {
      id = (JSON.parse(text) as { id?: string }).id;
    } catch {
      /* 忽略非 JSON 响应体 */
    }
    return { ok: true, id };
  } catch (err: any) {
    return { ok: false, error: en ? `Request failed: ${err?.message ?? String(err)}` : `请求失败：${err?.message ?? String(err)}` };
  }
}
