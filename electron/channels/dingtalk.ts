/**
 * DingTalk (钉钉) Group Robot Channel
 *
 * 文档: https://open.dingtalk.com/document/robots/custom-robot-access
 *
 * 钉钉群机器人用 Webhook 方式接收消息。
 * 支持 text / markdown 消息类型。
 * 如果启用了"加签"安全设置，需要提供 secret 进行签名。
 *
 * 配置:
 * - webhook: Webhook URL（含 access_token）
 * - secret: 可选的加签密钥
 * - atMobiles: 可选 @ 手机号
 * - isAtAll: 是否 @ 全体（默认 false）
 */

import * as crypto from 'node:crypto';
import type { ChannelPlugin, ChannelSendResult, InboundParseResult } from './types';
import { formatMessageMarkdown, diagnoseNetworkError } from './types';
import { channelConnectionTimeoutMs } from './runtime-config';

/**
 * 生成钉钉加签所需的 timestamp 和 sign。
 * sign = HmacSHA256(timestamp + "\n" + secret, secret)，Base64 编码后 URL 编码。
 */
function sign(secret: string): { timestamp: string; sign: string } {
  const timestamp = Date.now().toString();
  const stringToSign = `${timestamp}\n${secret}`;
  const hmac = crypto.createHmac('sha256', secret).update(stringToSign).digest('base64');
  const sign = encodeURIComponent(hmac);
  return { timestamp, sign };
}

export const dingtalkChannel: ChannelPlugin = {
  type: 'dingtalk',
  label: '钉钉',
  fields: [
    {
      key: 'webhook',
      label: 'Webhook URL',
      type: 'url',
      required: true,
      placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=xxx',
      help: '钉钉群设置 → 智能群助手 → 添加机器人，复制 Webhook',
    },
    {
      key: 'secret',
      label: '加签密钥（可选）',
      type: 'password',
      required: false,
      placeholder: 'SECxxx',
      help: '如启用"加签"安全设置，填此字段',
    },
    {
      key: 'msgType',
      label: '消息格式',
      type: 'text',
      required: false,
      defaultValue: 'markdown',
      help: 'text 或 markdown（留空用 markdown）',
    },
    {
      key: 'atMobiles',
      label: '@手机号（逗号分隔，可选）',
      type: 'text',
      required: false,
      placeholder: '13800000001,13800000002',
    },
    {
      key: 'isAtAll',
      label: '@全体',
      type: 'text',
      required: false,
      defaultValue: 'false',
      help: 'true 或 false（默认 false）',
    },
  ],
  validate(c) {
    if (!c.webhook || !c.webhook.startsWith('https://oapi.dingtalk.com/robot/')) {
      return '请填写正确的钉钉 Webhook URL';
    }
    return null;
  },
  async send(c, message): Promise<ChannelSendResult> {
    const msgType = (c.msgType || 'markdown').toLowerCase();
    let url = c.webhook;
    // 加签
    if (c.secret) {
      const { timestamp, sign: signVal } = sign(c.secret);
      const sep = url.includes('&') ? '&' : '&';
      url += `${sep}timestamp=${timestamp}&sign=${signVal}`;
    }
    const atMobiles = c.atMobiles
      ? c.atMobiles.split(',').map((s: string) => s.trim()).filter(Boolean)
      : [];
    const isAtAll = (c.isAtAll || 'false').toLowerCase() === 'true';

    let body: any;
    if (msgType === 'text') {
      body = {
        msgtype: 'text',
        text: {
          content: `${message.title}\n${message.content}`,
        },
        at: { atMobiles, isAtAll },
      };
    } else {
      body = {
        msgtype: 'markdown',
        markdown: {
          title: message.title,
          text: formatMessageMarkdown(message),
        },
        at: { atMobiles, isAtAll },
      };
    }
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(await channelConnectionTimeoutMs()),
      });
      const json = await resp.json() as any;
      if (json.errcode !== 0) {
        return { ok: false, error: `钉钉返回错误: ${json.errmsg || json.errcode}` };
      }
      return { ok: true };
    } catch (err: any) {
      const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
      return { ok: false, error: diagnoseNetworkError(err, host) };
    }
  },
  async test(c): Promise<ChannelSendResult> {
    return this.send(c, {
      title: 'Sage 测试消息',
      content: '这是一条来自 Sage 定时任务系统的测试消息，说明钉钉渠道配置正确！',
      taskName: '测试',
      timestamp: Date.now(),
    });
  },
  parseInbound(body: any, headers: Record<string, string>): InboundParseResult | null {
    // 钉钉回调格式
    // https://open.dingtalk.com/document/robots/receive-message
    if (!body || typeof body !== 'object') return null;

    // 检查签名（如果配置了 secret）
    // 钉钉的 timestamp 在 header 中
    const timestamp = headers['timestamp'] as string;
    if (timestamp) {
      // 签名验证由 inbound-server 统一处理（需要 secret）
      // 这里只做消息提取
    }

    // 文本消息
    if (body.msgtype === 'text' && body.text && body.text.content) {
      return {
        text: String(body.text.content),
        senderId: body.senderStaffId ? String(body.senderStaffId) : undefined,
        senderName: body.senderNick ? String(body.senderNick) : undefined,
        isMessage: true,
        response: { msgtype: 'text', text: { content: 'ok' } },
      };
    }

    // 钉钉的 URL 验证（checkurl）
    if (body.encrypt) {
      return { text: '', isMessage: false, response: body };
    }

    return null;
  },
};
