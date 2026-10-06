/**
 * Telegram Bot Channel
 *
 * 文档: https://core.telegram.org/bots/api
 *
 * 双向能力：
 * - 出站：通过 Bot API 的 sendMessage 推送消息到指定 chat
 * - 入站：通过用户调用 setWebhook 配置的回调 URL 接收 Update 对象
 *
 * 配置字段：
 * - bot_token: BotFather 给的 token（格式 数字:字符串）
 * - chat_id:   接收消息的目标 chat（群 ID、用户 ID 或 @channel_username）
 * - parse_mode: 消息格式 HTML / Markdown / MarkdownV2（默认 HTML，最稳妥）
 * - api_base:  可选，自定义 API 地址（大陆用户通常填反代地址）
 *
 * 入站接入方式：
 * 1. 在 Sage 新建 Telegram 渠道，复制界面上显示的「入站 URL」
 * 2. 在终端执行：
 *    curl "https://api.telegram.org/bot<bot_token>/setWebhook?url=<入站 URL>"
 *    （大陆用户需把 api.telegram.org 换成反代域名）
 * 3. 在 Telegram 群里 @bot 或私聊 bot，消息会通过 webhook 流入 Sage
 */

import type { ChannelPlugin, ChannelSendResult, InboundParseResult } from './types';
import { diagnoseNetworkError } from './types';
import { channelConnectionTimeoutMs } from './runtime-config';

const DEFAULT_API_BASE = 'https://api.telegram.org';
const MAX_MESSAGE_LENGTH = 4096;

function getApiBase(config: Record<string, string>): string {
  return (config.api_base || DEFAULT_API_BASE).replace(/\/+$/, '');
}

function getBotToken(config: Record<string, string>): string {
  return config.bot_token || '';
}

/** Telegram HTML parse_mode 需要转义三个保留字符。 */
function escapeHtmlForTelegram(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 把长文本按字符长度分片，每片不超过 maxLen，并尽量在换行处切分。
 * Telegram 单条消息最大 4096 字符，超长要分片发送。
 */
function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LENGTH - 200): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxLen, text.length);
    if (end < text.length) {
      // 优先在换行处切分（至少保留 maxLen/2 的内容，否则直接按长度切）
      const newlineIdx = text.lastIndexOf('\n', end);
      if (newlineIdx > i + maxLen / 2) end = newlineIdx + 1;
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

/** 构造要发送的消息正文（根据 parse_mode 选择转义策略）。 */
function buildMessageText(message: {
  title: string;
  content?: string;
  taskName?: string;
  projectName?: string;
  runStatus?: string;
  timestamp?: number;
}, parseMode: string): string {
  const lines: string[] = [];
  const statusEmoji = message.runStatus === 'success' ? '✅'
    : message.runStatus === 'failed' ? '❌'
    : '⏳';

  const wrap = (raw: string) => (parseMode === 'HTML' ? escapeHtmlForTelegram(raw) : raw);
  const boldTitle = parseMode === 'HTML'
    ? `<b>${escapeHtmlForTelegram(message.title)}</b>`
    : `*${message.title}*`;

  lines.push(boldTitle);
  lines.push('');
  if (message.taskName) {
    lines.push(`任务: ${message.taskName} ${statusEmoji}`);
  }
  if (message.projectName) {
    lines.push(`项目: ${message.projectName}`);
  }
  if (message.timestamp) {
    lines.push(`时间: ${new Date(message.timestamp).toLocaleString('zh-CN')}`);
  }
  lines.push('');
  if (message.content) {
    lines.push(wrap(message.content));
  }
  return lines.join('\n');
}

export const telegramChannel: ChannelPlugin = {
  type: 'telegram',
  label: 'Telegram',
  fields: [
    {
      key: 'bot_token',
      label: 'Bot Token',
      type: 'password',
      required: true,
      placeholder: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
      help: '从 @BotFather 创建机器人后获取，格式：数字:字符串',
    },
    {
      key: 'chat_id',
      label: 'Chat ID',
      type: 'text',
      required: true,
      placeholder: '123456789 或 @channel_username',
      help: '接收消息的 chat（群 ID、用户 ID 或频道用户名 @xxx）',
    },
    {
      key: 'parse_mode',
      label: '消息格式',
      type: 'text',
      required: false,
      defaultValue: 'HTML',
      help: 'HTML / Markdown / MarkdownV2（推荐 HTML，转义简单）',
    },
    {
      key: 'api_base',
      label: 'API Base URL（可选）',
      type: 'text',
      required: false,
      placeholder: 'https://api.telegram.org',
      help: '默认 https://api.telegram.org；大陆用户可填反代地址',
    },
  ],
  validate(config): string | null {
    if (!config.bot_token) return '缺少 Bot Token';
    if (!/^\d+:[\w-]+$/.test(config.bot_token)) {
      return 'Bot Token 格式错误（应为 数字:字符串，例如 123456:ABC-DEF...）';
    }
    if (!config.chat_id) return '缺少 Chat ID';
    return null;
  },
  async send(config, message): Promise<ChannelSendResult> {
    const apiBase = getApiBase(config);
    const botToken = getBotToken(config);
    const chatId = config.chat_id;
    const parseMode = (config.parse_mode || 'HTML').trim();
    const url = `${apiBase}/bot${botToken}/sendMessage`;

    const text = buildMessageText(message, parseMode);
    const chunks = splitMessage(text);

    try {
      for (const chunk of chunks) {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: chunk,
            parse_mode: parseMode,
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(await channelConnectionTimeoutMs()),
        });
        const json = await resp.json() as any;
        if (!json.ok) {
          return { ok: false, error: `Telegram 返回错误: ${json.description || json.error_code || 'unknown'}` };
        }
      }
      return { ok: true };
    } catch (err: any) {
      const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
      return { ok: false, error: diagnoseNetworkError(err, host) };
    }
  },
  async test(config): Promise<ChannelSendResult> {
    return this.send(config, {
      title: 'Sage 测试消息',
      content: '🤖 这是一条来自 Sage 的测试消息，说明 Telegram 渠道配置正确！',
      taskName: '测试',
      timestamp: Date.now(),
    });
  },
  parseInbound(body: any): InboundParseResult | null {
    if (!body || typeof body !== 'object') return null;

    // Telegram Update 对象：
    // - message: 普通消息
    // - edited_message: 编辑后的消息
    // - channel_post: 频道发布的消息
    // - callback_query: 用户点击 inline button（忽略）
    const msg = body.message || body.edited_message || body.channel_post;
    if (!msg || typeof msg !== 'object') {
      // 非消息类型的 update（如 callback_query、my_chat_member 等），忽略
      return null;
    }

    const text = msg.text || msg.caption;
    if (typeof text !== 'string' || text.length === 0) {
      // 无文本内容（贴纸、图片无 caption 等），忽略
      return null;
    }

    const from = msg.from || {};
    const senderId = from.id !== undefined ? String(from.id) : undefined;
    const senderName = from.username
      ? `@${from.username}`
      : [from.first_name, from.last_name].filter(Boolean).join(' ') || undefined;

    return {
      text: String(text),
      senderId,
      senderName,
      isMessage: true,
      response: { ok: true },
    };
  },
};

/**
 * 通过 Bot API 设置 webhook（供 UI 按钮调用）。
 * 把 webhook URL 注册到 Telegram，后续该 bot 收到的消息会 POST 到此 URL。
 */
export async function setTelegramWebhook(
  config: Record<string, string>,
  webhookUrl: string,
): Promise<ChannelSendResult> {
  const apiBase = getApiBase(config);
  const botToken = getBotToken(config);
  const url = `${apiBase}/bot${botToken}/setWebhook`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ['message', 'edited_message', 'channel_post'],
        drop_pending_updates: true,
      }),
      signal: AbortSignal.timeout(await channelConnectionTimeoutMs()),
    });
    const json = await resp.json() as any;
    if (!json.ok) {
      return { ok: false, error: `Telegram 返回错误: ${json.description || json.error_code || 'unknown'}` };
    }
    return { ok: true };
  } catch (err: any) {
    const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
    return { ok: false, error: diagnoseNetworkError(err, host) };
  }
}

/**
 * 删除 webhook（供 UI 按钮调用）。
 */
export async function deleteTelegramWebhook(
  config: Record<string, string>,
): Promise<ChannelSendResult> {
  const apiBase = getApiBase(config);
  const botToken = getBotToken(config);
  const url = `${apiBase}/bot${botToken}/deleteWebhook`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drop_pending_updates: false }),
      signal: AbortSignal.timeout(await channelConnectionTimeoutMs()),
    });
    const json = await resp.json() as any;
    if (!json.ok) {
      return { ok: false, error: `Telegram 返回错误: ${json.description || json.error_code || 'unknown'}` };
    }
    return { ok: true };
  } catch (err: any) {
    const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
    return { ok: false, error: diagnoseNetworkError(err, host) };
  }
}
