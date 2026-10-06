/**
 * Inbound Webhook Server + Relay Client 共享处理逻辑
 *
 * 入站消息有两条通路：
 * 1. 本地 HTTP 服务器（POST /inbound/:path）— 需要公网可达，适合部署在公网的场景
 * 2. Relay 长连接（relay-client.ts）— 客户端主动外连公网中继，适合本地无公网 IP
 *
 * 两条通路最终都调用 processInboundWebhook()：解析消息 → ACK 外部平台 → 注入对话。
 * 本文件导出 processInboundWebhook 供两者共用，并保留本地 HTTP 服务器实现。
 */

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChannelConfig, InboundMessage } from '../../shared/types';
import { listChannels } from '../store';
import { getChannel } from './registry';
import { recordChannelDiag } from './diagnostics';
import type { InboundParseResult } from './types';

export type InboundHandler = (message: InboundMessage, channel: ChannelConfig) => Promise<void>;

/** processInboundWebhook 的返回：需要回给外部平台的 HTTP 响应。 */
export interface InboundResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * 处理一条入站 webhook 请求（本地 HTTP 与 relay 透传共用）。
 *
 * @param webhookPath 渠道路径标识（对应 channel.inboundWebhookPath）
 * @param method      HTTP 方法（GET/POST）
 * @param headers     请求头（小写 key）
 * @param body        请求体原文
 * @param handler     消息处理回调（注入对话）
 * @returns 需要回给外部平台的响应
 */
export async function processInboundWebhook(
  webhookPath: string,
  method: string,
  headers: Record<string, string>,
  body: string,
  handler: InboundHandler | null,
): Promise<InboundResponse> {
  // 查找此 webhookPath 对应的渠道
  const channel = await findChannelByWebhookPath(webhookPath);
  if (!channel) {
    return { status: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'channel not found' }) };
  }

  // websocket 模式的飞书渠道：事件由官方长连接推给客户端，走 HTTP 透传进来的这一条是重复投递，直接 ACK 丢掉。
  // 丢掉必须留痕 —— 否则「配了 relay 又开了 websocket」的用户在 relay 侧翻不到任何日志，问题看起来像凭空消失。
  if (channel.type === 'feishu-app' && channel.config.connectionMode === 'websocket') {
    recordChannelDiag({
      stage: 'inbound', ok: false, reason: 'dropped-mode-mismatch',
      channelType: channel.type, config: channel.config as Record<string, string>, channelName: channel.name,
      projectPath: channel.projectPath,
      // 不记 webhookPath：它本身就是访问凭证（拿到就能往这个地址推消息），只记它确实到了
      detail: { mode: 'websocket', bytes: body.length },
    });
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 0 }) };
  }

  // 调用插件的 parseInbound
  const plugin = getChannel(channel.type);
  if (!plugin || !plugin.parseInbound) {
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'channel does not support inbound' }) };
  }

  // 解析请求体
  let parsedBody: any = null;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    parsedBody = body; // 非 JSON（钉钉有时用 form-urlencoded / XML）
  }

  let parseResult: InboundParseResult;
  try {
    parseResult = plugin.parseInbound(parsedBody, headers, channel.config) ?? { text: '', isMessage: false };
  } catch (err: any) {
    return { status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'parse failed', detail: err?.message }) };
  }

  const ackResponse = (): InboundResponse => ({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: parseResult.response
      ? (typeof parseResult.response === 'string' ? parseResult.response : JSON.stringify(parseResult.response))
      : JSON.stringify({ ok: true }),
  });

  // 非消息（URL 验证、事件推送）→ 直接返回插件指定的响应
  if (!parseResult.isMessage) {
    return ackResponse();
  }

  // 构造 InboundMessage 并异步处理（不等 Claude 处理完就先 ACK 外部平台）
  const message: InboundMessage = {
    channelId: channel.id,
    channelType: channel.type,
    senderId: parseResult.senderId,
    senderName: parseResult.senderName,
    text: parseResult.text,
    raw: parsedBody,
    ts: Date.now(),
  };

  if (handler) {
    handler(message, channel).catch((err) => {
      console.error('[inbound] handler failed:', err);
    });
  }

  return ackResponse();
}

// ─── 本地 HTTP 服务器（可选通路） ───────────────────────────────────────────

let server: http.Server | null = null;
let currentPort = 19527;
let inboundHandler: InboundHandler | null = null;

/**
 * 启动本地入站 webhook 服务器（仅当本机有公网可达性时使用）。
 */
export function startInboundServer(port: number, handler: InboundHandler): Promise<{ ok: boolean; port?: number; error?: string }> {
  return new Promise((resolve) => {
    if (server) {
      server.close();
      server = null;
    }

    currentPort = port;
    inboundHandler = handler;

    server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '', `http://localhost:${port}`);
      const pathParts = url.pathname.split('/').filter(Boolean);

      if (pathParts.length !== 2 || pathParts[0] !== 'inbound') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      // 读取请求体
      let bodyStr = '';
      req.setEncoding('utf-8');
      for await (const chunk of req) {
        bodyStr += chunk;
        if (bodyStr.length > 5 * 1024 * 1024) break; // 5MB 上限
      }

      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v;
      }

      const resp = await processInboundWebhook(pathParts[1], req.method ?? 'POST', headers, bodyStr, inboundHandler);
      res.writeHead(resp.status, resp.headers);
      res.end(resp.body);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      console.error('[inbound-server] server error:', err);
      server = null;
      resolve({ ok: false, error: err.message });
    });

    server.listen(port, () => {
      console.log(`[inbound-server] listening on port ${port}`);
      resolve({ ok: true, port });
    });
  });
}

/** 停止本地入站 webhook 服务器。 */
export function stopInboundServer(): Promise<void> {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => {
        server = null;
        inboundHandler = null;
        resolve();
      });
      setTimeout(() => {
        server = null;
        inboundHandler = null;
        resolve();
      }, 1000);
    } else {
      resolve();
    }
  });
}

/** 检查本地服务器是否正在运行。 */
export function isServerRunning(): boolean {
  return server !== null && server.listening;
}

/** 获取当前监听端口。 */
export function getServerPort(): number {
  return currentPort;
}

/**
 * 在所有项目渠道中查找匹配 webhookPath 的渠道。
 */
async function findChannelByWebhookPath(webhookPath: string): Promise<ChannelConfig | null> {
  const { listProjects } = await import('../store');
  const projects = await listProjects();
  for (const proj of projects) {
    const channels = await listChannels(proj.path);
    const found = channels.find((c) => c.inboundWebhookPath === webhookPath && c.enabled);
    if (found) return found;
  }
  return null;
}
