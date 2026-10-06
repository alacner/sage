/**
 * WeChat Work (企业微信) Group Robot Channel
 *
 * 文档: https://developer.work.weixin.qq.com/document/path/91770
 *
 * 企业微信群机器人用 Webhook 方式接收消息。
 * 支持文本消息和 Markdown 消息。
 *
 * 配置:
 * - webhook: 完整的 Webhook URL（含 key 参数）
 * - mentionedMobile: 可选 @ 手机号（逗号分隔）
 */

import type { ChannelPlugin, ChannelSendResult, InboundParseResult } from './types';
import { formatMessageMarkdown, diagnoseNetworkError } from './types';

export const wechatChannel: ChannelPlugin = {
  type: 'wechat',
  label: '企业微信',
  fields: [
    {
      key: 'webhook',
      label: 'Webhook URL',
      type: 'url',
      required: true,
      placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx',
      help: '在群聊中添加机器人，复制 Webhook 地址',
    },
    {
      key: 'mentionedMobile',
      label: '@手机号（可选，逗号分隔）',
      type: 'text',
      required: false,
      placeholder: '13800000001,13800000002',
    },
    {
      key: 'msgType',
      label: '消息格式',
      type: 'text',
      required: false,
      defaultValue: 'markdown',
      help: 'text 或 markdown（留空用 markdown）',
    },
  ],
  validate(c) {
    if (!c.webhook || !c.webhook.startsWith('https://qyapi.weixin.qq.com/')) {
      return '请填写正确的企业微信 Webhook URL';
    }
    return null;
  },
  async send(c, message): Promise<ChannelSendResult> {
    const msgType = (c.msgType || 'markdown').toLowerCase();
    let body: any;
    if (msgType === 'markdown') {
      body = {
        msgtype: 'markdown',
        markdown: {
          content: formatMessageMarkdown(message),
        },
      };
    } else {
      const mentionedList = c.mentionedMobile
        ? c.mentionedMobile.split(',').map((s: string) => s.trim()).filter(Boolean)
        : [];
      body = {
        msgtype: 'text',
        text: {
          content: `${message.title}\n${message.content}`,
          mentioned_mobile_list: mentionedList,
        },
      };
    }
    try {
      const resp = await fetch(c.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await resp.json() as any;
      if (json.errcode !== 0) {
        return { ok: false, error: `企业微信返回错误: ${json.errmsg || json.errcode}` };
      }
      return { ok: true };
    } catch (err: any) {
      const host = (() => { try { return new URL(c.webhook).hostname; } catch { return ''; } })();
      return { ok: false, error: diagnoseNetworkError(err, host) };
    }
  },
  async test(c): Promise<ChannelSendResult> {
    return this.send(c, {
      title: 'Sage 测试消息',
      content: '这是一条来自 Sage 定时任务系统的测试消息，说明企业微信渠道配置正确！',
      taskName: '测试',
      timestamp: Date.now(),
    });
  },
  parseInbound(body: any, _headers: Record<string, string>): InboundParseResult | null {
    // 企业微信回调格式
    // https://developer.work.weixin.qq.com/document/path/90930
    if (!body || typeof body !== 'object') return null;

    // URL 验证（企业微信首次配置回调时发送 GET，但 POST 也会收到 echostr）
    if (body.echostr) {
      return { text: '', isMessage: false, response: { echostr: body.echostr } };
    }

    // 普通消息
    if (body.MsgType === 'text' && body.Content) {
      return {
        text: String(body.Content),
        senderId: body.FromUserName ? String(body.FromUserName) : undefined,
        senderName: body.FromUserName ? String(body.FromUserName) : undefined,
        isMessage: true,
        response: { errcode: 0, errmsg: 'ok' },
      };
    }

    // 事件推送（非消息）
    if (body.MsgType === 'event' || body.Event) {
      return { text: '', isMessage: false, response: { errcode: 0, errmsg: 'ok' } };
    }

    return null;
  },
};
