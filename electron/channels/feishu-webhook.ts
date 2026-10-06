/**
 * Feishu / Lark — 自定义 Webhook 机器人（单向出站）
 *
 * 这是飞书最轻量的集成方式：在群里添加自定义机器人即可获得一个 Webhook URL，
 * 任何服务都可以 POST JSON 到此 URL 把消息推送到群里。
 *
 * 能力：
 * - ✅ 出站：通过 Webhook 发消息到群（text / markdown / interactive 卡片）
 * - ❌ 入站：无法接收群消息或事件回调（群机器人没有"听"的能力）
 *
 * 可选开启"签名校验"以验证请求来源。
 *
 * 文档：
 * - 自定义机器人：https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
 *
 * 配置字段：
 * - webhook : Webhook URL（必填）
 * - secret  : 签名密钥（可选，开启"签名校验"后需要）
 * - msgType : 消息格式 text / markdown（默认 markdown）
 *
 * 如果你需要双向通信（收消息），请使用「飞书应用机器人」(feishu-app) 渠道。
 */

import * as crypto from 'node:crypto';
import type { ChannelPlugin, ChannelSendResult } from './types';
import { formatMessageMarkdown, diagnoseNetworkError } from './types';

/**
 * 生成飞书签名。
 * 飞书官方算法（https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot）：
 *   timestamp      = 当前秒级时间戳
 *   string_to_sign = timestamp + "\n" + secret
 *   sign           = base64( HmacSHA256(key=string_to_sign, msg="") )
 */
function feishuSign(secret: string): { timestamp: string; sign: string } {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = crypto.createHmac('sha256', stringToSign).update('').digest('base64');
  return { timestamp, sign };
}

export const feishuWebhookChannel: ChannelPlugin = {
  type: 'feishu-webhook',
  label: '飞书群机器人（单向）',
  fields: [
    {
      key: 'webhook',
      label: 'Webhook URL',
      type: 'url',
      required: true,
      placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx',
      help: '飞书群设置 → 群机器人 → 添加机器人（自定义机器人）→ 复制 Webhook',
    },
    {
      key: 'secret',
      label: '签名密钥（可选）',
      type: 'password',
      required: false,
      placeholder: 'xxx',
      help: '机器人设置中开启"签名校验"后，把密钥填到这里',
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
    if (!c.webhook || !c.webhook.startsWith('https://open.feishu.cn/')) {
      return '请填写正确的飞书 Webhook URL（https://open.feishu.cn/open-apis/bot/v2/hook/...）';
    }
    return null;
  },
  async send(c, message): Promise<ChannelSendResult> {
    const msgType = (c.msgType || 'markdown').toLowerCase();
    const title = message.title;
    const content = formatMessageMarkdown(message);
    let body: any;

    if (msgType === 'text') {
      body = {
        msg_type: 'text',
        content: { text: `${title}\n${message.content}` },
      };
    } else {
      // markdown：用 interactive 卡片承载
      body = {
        msg_type: 'interactive',
        card: {
          elements: [
            {
              tag: 'markdown',
              content: content,
            },
          ],
          header: {
            template: message.runStatus === 'success' ? 'green'
              : message.runStatus === 'failed' ? 'red'
              : 'blue',
            title: {
              tag: 'plain_text',
              content: title,
            },
          },
        },
      };
    }

    // 签名（如配置了 secret）
    if (c.secret) {
      const { timestamp, sign } = feishuSign(c.secret);
      body.timestamp = timestamp;
      body.sign = sign;
    }

    try {
      const resp = await fetch(c.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await resp.json() as any;
      if (json.StatusCode !== 0 && json.code !== 0) {
        const errMsg = json.StatusMessage || json.msg || `code=${json.code ?? json.StatusCode}`;
        return { ok: false, error: `飞书返回错误: ${errMsg}` };
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
      content: '这是一条来自 Sage 的测试消息，说明飞书群机器人 Webhook 配置正确 ✅',
      taskName: '测试',
      timestamp: Date.now(),
    });
  },
  // 群机器人单向，不支持接收消息
};
