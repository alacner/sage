/**
 * Feishu / Lark — 应用机器人（双向）
 *
 * 基于飞书开放平台应用机器人，具备完整的消息收发能力：
 * - ✅ 出站：通过飞书开放 API 发消息到指定聊天 / 用户
 * - ✅ 入站：订阅 im.message.receive_v1 事件，接收用户发来的消息
 *
 * 与「飞书群机器人 (feishu-webhook)」的区别：
 * ┌──────────────────────┬─────────────────────┬──────────────────────┐
 * │                      │  飞书群机器人         │  飞书应用机器人        │
 * ├──────────────────────┼─────────────────────┼──────────────────────┤
 * │  配置复杂度            │  极低（填 Webhook）  │  中等（App ID/Secret）│
 * │  发消息               │  ✅ Webhook          │  ✅ 开放 API          │
 * │  接收消息             │  ❌                  │  ✅ 事件订阅          │
 * │  适用场景             │  定时任务推送         │  对话、双向交互        │
 * └──────────────────────┴─────────────────────┴──────────────────────┘
 *
 * 核心 API：
 * - tenant_access_token 获取：
 *   POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal
 * - 发送消息：
 *   POST https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id
 * - 事件订阅：
 *   在飞书开发者后台配置请求地址，订阅 im.message.receive_v1 事件
 *
 * 加密策略：
 * - Encrypt Key：飞书用 AES-256-CBC 加密事件/回调请求体，
 *   开发者用此 key（SHA256 后取结果）解密还原明文。
 * - Verification Token：每个事件/回调 body 中携带的 token，
 *   开发者校验其与后台配置一致，确认请求来源合法。
 *
 * 配置字段：
 * - appId           : 应用 ID（飞书开发者后台 → 应用凭证）
 * - appSecret       : 应用密钥
 * - receiveIdType   : 接收者 ID 类型（chat_id / open_id / user_id，默认 chat_id）
 * - receiveId       : 接收者 ID（群 ID 或用户 ID）
 * - encryptKey      : 事件加密密钥（可选，事件订阅 → 加密策略）
 * - verificationToken: 事件校验 Token（可选，事件订阅 → 加密策略）
 */

import * as crypto from 'node:crypto';
import type { ChannelPlugin, ChannelSendResult, InboundParseResult } from './types';
import { formatMessageMarkdown, diagnoseNetworkError } from './types';
import { channelConnectionTimeoutMs } from './runtime-config';
import { recordChannelDiag } from './diagnostics';

// ─── tenant_access_token 缓存 ───────────────────────────────────────────────
// 飞书 tenant_access_token 有效期 2 小时，缓存起来避免每次请求都申请新 token。
// key: `${appId}:${appSecret}`  value: { token, expiresAt }
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * 获取应用的 tenant_access_token。
 * 先查缓存（提前 5 分钟过期），缓存未命中时调用开放 API 申请。
 * 文档：https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal
 */
export async function getTenantAccessToken(appId: string, appSecret: string): Promise<string> {
  const cacheKey = `${appId}:${appSecret}`;
  const cached = tokenCache.get(cacheKey);
  const now = Date.now();

  if (cached && cached.expiresAt > now + 5 * 60 * 1000) {
    return cached.token;
  }

  const url = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
  const resp = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(await channelConnectionTimeoutMs()),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const json = await resp.json() as any;

  if (json.code !== 0) {
    // 凭证拿不到 = 出站链路第一环就断（App ID/Secret 错、应用被停用、网络不通）。
    // 只记 appId（cli_ 开头可公开定位），appSecret 永远不进日志。
    recordChannelDiag({ stage: 'token', ok: false, reason: 'token-failed', channelType: 'feishu-app', detail: { appId, code: json.code, msg: json.msg } });
    throw new Error(`获取 tenant_access_token 失败: ${json.msg} (code=${json.code})`);
  }
  recordChannelDiag({ stage: 'token', ok: true, reason: 'ok', channelType: 'feishu-app', detail: { appId, expire: json.expire || 7200 } });

  const token = json.tenant_access_token as string;
  // expire 单位是秒，通常 7200
  const expiresAt = now + (json.expire || 7200) * 1000;
  tokenCache.set(cacheKey, { token, expiresAt });
  return token;
}

/**
 * 飞书 AES-256-CBC 解密。
 *
 * 飞书加密策略：
 *   - key     = SHA256(encryptKey) 的 32 字节
 *   - iv      = ciphertext 的前 16 字节
 *   - payload = ciphertext[16:]
 *   - plaintext = AES-256-CBC-decrypt(key, iv, payload)
 */
function feishuDecrypt(encryptKey: string, encryptStr: string): string {
  const keyHash = crypto.createHash('sha256').update(encryptKey).digest();
  const encryptBuf = Buffer.from(encryptStr, 'base64');
  const iv = encryptBuf.subarray(0, 16);
  const payload = encryptBuf.subarray(16);

  const decipher = crypto.createDecipheriv('aes-256-cbc', keyHash, iv);
  decipher.setAutoPadding(true);
  const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
  return decrypted.toString('utf-8');
}

export const feishuAppChannel: ChannelPlugin = {
  type: 'feishu-app',
  label: '飞书应用机器人',
  // send / 长连接自己埋了诊断（token / outbound / ws / inbound / match / inject），
  // 注册表不要再兑一条笼统的 outbound
  reportsOwnDiagnostics: true,
  fields: [
    {key:'connectionMode',label:'消息接收方式',type:'select',required:false,defaultValue:'webhook',options:[{value:'webhook',label:'Webhook 回调'},{value:'websocket',label:'WebSocket 长连接'}],help:'长连接需在飞书开发者后台选择长连接订阅事件；无需公网回调地址。'},
    {key:'streamReplies',label:'回答发送方式',type:'select',required:false,defaultValue:'false',options:[{value:'false',label:'完成后发送'},{value:'true',label:'实时更新回答卡片'}],help:'生成过程中约每秒更新同一张卡片，完成后显示最终回答。'},
    {
      key: 'appId',
      label: 'App ID',
      type: 'text',
      required: true,
      placeholder: 'cli_xxxxxxxxx',
      help: '飞书开发者后台 → 应用 → 凭证与基础信息 → App ID',
    },
    {
      key: 'appSecret',
      label: 'App Secret',
      type: 'password',
      required: true,
      placeholder: 'xxxxxxxxxxxxxxxx',
      help: '飞书开发者后台 → 应用 → 凭证与基础信息 → App Secret',
    },
    {
      key: 'receiveIdType',
      label: '接收者 ID 类型',
      type: 'text',
      required: false,
      defaultValue: 'chat_id',
      placeholder: 'chat_id / open_id / user_id',
      help: '发消息时的接收者 ID 类型，默认 chat_id（群聊 ID）。单聊用 open_id 或 user_id',
    },
    {
      key: 'receiveId',
      label: '接收者 ID',
      type: 'text',
      required: true,
      placeholder: 'oc_xxxxxxxx（群聊）或 ou_xxxxxxxx（用户）',
      help: '消息发到哪里。群聊填 chat_id，单聊填 open_id 或 user_id（取决于上一项）',
    },
    // ── 入站加密策略 ──
    {
      key: 'encryptKey',
      label: 'Encrypt Key（可选）',
      type: 'password',
      required: false,
      placeholder: '飞书开发者后台 → 事件订阅 → 加密策略',
      help: '事件/回调加密密钥。启用"加密策略"后，回调请求体会被 AES-256-CBC 加密，填此字段以解密',
    },
    {
      key: 'verificationToken',
      label: 'Verification Token（可选）',
      type: 'password',
      required: false,
      placeholder: '飞书开发者后台 → 事件订阅 → 加密策略',
      help: '事件校验 Token。用于验证回调请求来源是否为飞书服务器（非必填，但建议启用）',
    },
  ],
  validate(c) {
    if (!c.appId || !c.appId.startsWith('cli_')) {
      return '请填写正确的 App ID（以 cli_ 开头，从飞书开发者后台复制）';
    }
    if (!c.appSecret || c.appSecret.length < 10) {
      return 'App Secret 至少 10 位';
    }
    if (!c.receiveId) {
      return '请填写接收者 ID（chat_id / open_id / user_id）';
    }
    const idType = c.receiveIdType || 'chat_id';
    if (!['chat_id', 'open_id', 'user_id', 'union_id', 'email'].includes(idType)) {
      return `不支持的接收者 ID 类型: ${idType}，支持 chat_id / open_id / user_id`;
    }
    return null;
  },
  async send(c, message): Promise<ChannelSendResult> {
    const receiveIdType = c.receiveIdType || 'chat_id';
    // 诊断事件带上 config，主/渲染两侧能算出同一个 channelKey（面板才能按渠道分组）
    const diag = { channelType: 'feishu-app', config: c } as const;
    try {
      const token = await getTenantAccessToken(c.appId, c.appSecret);
      const url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`;

      // 用 interactive 卡片发 Markdown 内容（飞书 API 不直接支持 Markdown）
      const title = message.title;
      const content = formatMessageMarkdown(message);

      // 构造卡片：标题为空时不渲染 header（用户只想要纯内容）
      const cardObj: any = {
        elements: [
          { tag: 'markdown', content },
        ],
      };
      
      // 只有标题非空时才添加 header
      if (title && title.trim()) {
        cardObj.header = {
          template: message.runStatus === 'success' ? 'green'
            : message.runStatus === 'failed' ? 'red'
            : 'blue',
          title: { tag: 'plain_text', content: title },
        };
      }

      const cardPayload = JSON.stringify(cardObj);

      const body = {
        receive_id: c.receiveId,
        msg_type: 'interactive',
        content: cardPayload,
      };

      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const json = await resp.json() as any;
      const data = json?.data ?? {};

      if (json.code !== 0) {
        // 平台拒收：把 code / msg / HTTP 状态一并留下（“测试失败”背后可能是权限、机器人不在群里、ID 类型错）
        recordChannelDiag({ ...diag, stage: 'outbound', ok: false, reason: 'api-error', detail: { receiveIdType, receiveId: c.receiveId, httpStatus: resp.status, code: json.code, msg: json.msg } });
        return { ok: false, error: `飞书 API 返回错误: ${json.msg} (code=${json.code})` };
      }
      if (!data.message_id) {
        // code=0 却没给回执：无法证明消息落在哪个会话，不能当成“正常”
        recordChannelDiag({ ...diag, stage: 'outbound', ok: false, reason: 'no-message-id', detail: { receiveIdType, receiveId: c.receiveId, dataKeys: Object.keys(data).join(',') || '-' } });
        return { ok: true };
      }
      // chat_id 是“消息实际落在哪个会话”的权威回执：配置看起来对、消息却看不到时，对一眼这个值就能定位
      recordChannelDiag({ ...diag, stage: 'outbound', ok: true, reason: 'ok', detail: { receiveIdType, receiveId: c.receiveId, chatId: data.chat_id ?? '', messageId: data.message_id, contentLen: content.length } });
      return { ok: true, receipt: { messageId: data.message_id, chatId: data.chat_id, receiveIdType } };
    } catch (err: any) {
      recordChannelDiag({ ...diag, stage: 'outbound', ok: false, reason: 'network', detail: { receiveIdType, receiveId: c.receiveId, error: err?.message ?? String(err) } });
      return { ok: false, error: diagnoseNetworkError(err, 'open.feishu.cn') };
    }
  },
  async test(c): Promise<ChannelSendResult> {
    return this.send(c, {
      title: 'Sage 测试消息',
      content: '这是一条来自 Sage 的测试消息，说明飞书应用机器人配置正确 ✅\n\n消息将通过开放 API 发送到配置的接收者。',
      taskName: '测试',
      timestamp: Date.now(),
    });
  },
  parseInbound(body: any, headers: Record<string, string>, config: Record<string, string>): InboundParseResult | null {
    // 飞书事件订阅回调格式
    // https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive
    if (!body || typeof body !== 'object') return null;

    // ── 加密策略处理 ─────────────────────────────────────────────────────
    // 启用"加密策略"后，飞书会把整个事件 JSON 加密后放在 body.encrypt 字段：
    //   { "encrypt": "<base64-encoded-ciphertext>" }
    // 需要先解密还原为明文 JSON，再按正常流程解析。
    const encryptKey = config?.encryptKey;
    if (body.encrypt && typeof body.encrypt === 'string') {
      if (!encryptKey) {
        console.error('[feishu-app] 收到加密事件但渠道未配置 encryptKey，丢弃');
        return null;
      }
      try {
        const decrypted = feishuDecrypt(encryptKey, body.encrypt);
        body = JSON.parse(decrypted);
      } catch (err: any) {
        console.error('[feishu-app] 事件解密失败:', err?.message);
        return null;
      }
    }

    // ── Verification Token 校验 ──────────────────────────────────────────
    const verificationToken = config?.verificationToken;
    if (verificationToken) {
      const token = body.token || body.header?.token;
      if (token && token !== verificationToken) {
        console.error('[feishu-app] verification token 不匹配，拒绝请求');
        return null;
      }
    }

    // ── 飞书 URL 验证（首次配置回调时） ──────────────────────────────────
    // 飞书开发者后台保存回调 URL 时会发一次 url_verification，
    // 开发者必须原样返回 challenge 字段才能通过校验。
    if (body.type === 'url_verification' && body.challenge) {
      return { text: '', isMessage: false, response: { challenge: body.challenge } };
    }

    // ── 消息事件 v2 (im.message.receive_v1) ──────────────────────────────
    const event = body.event;
    if (event && body.header && body.header.event_type === 'im.message.receive_v1') {
      const msg = event?.message;
      if (msg && msg.message_type === 'text') {
        // content 是 JSON 字符串: {"text": "xxx"}
        let text = '';
        try {
          const content = JSON.parse(msg.content);
          text = content.text || '';
        } catch {
          text = '';
        }
        if (text) {
          return {
            text,
            senderId: event.sender?.sender_id?.open_id,
            senderName: event.sender?.sender_id?.name,
            isMessage: true,
            response: { code: 0 }, // 飞书要求返回 { code: 0 } 表示处理成功
          };
        }
      }
      // 非文本消息（图片/文件/富文本等）暂时忽略
      return null;
    }

    // ── 旧版事件格式（v1）────────────────────────────────────────────────
    if (body.MsgType === 'text' && body.Text && body.Text.Content) {
      return {
        text: String(body.Text.Content),
        senderId: body.FromUserId,
        senderName: body.FromUserId,
        isMessage: true,
        response: { ok: true },
      };
    }

    // 其他事件（如 URL 验证重试、其他事件类型）→ 直接 ACK
    if (body.header?.event_type) {
      return { text: '', isMessage: false, response: { code: 0 } };
    }

    return null;
  },
};
