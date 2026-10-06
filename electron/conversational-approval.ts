import type { ChatMessage, ConversationMeta, ImageAttachment } from '../shared/types';

/** Only a complete, explicit human reply qualifies; quoted/instructional text is ordinary input. */
export function approvalReplyDecision(text: string): 'allow' | 'deny' | undefined {
  const reply = text.trim().replace(/[。！!.,，\s]+$/g, '').toLowerCase();
  if (/^(?:允许(?:本次)?|同意(?:本次)?|批准(?:本次)?|继续执行|允许继续(?:执行)?|同意继续(?:执行)?|可以执行|那(?:你)?(?:就)?允许(?:吧)?|请继续执行|allow(?: once)?|approve(?: once)?|i approve|go ahead|please proceed|proceed)$/.test(reply)) return 'allow';
  if (/^(?:拒绝(?:本次)?|不同意|不允许|不要执行|取消本次(?:操作)?|deny|reject|do not proceed)$/.test(reply)) return 'deny';
}

type Request = { requestId: string; convId: string; request?: unknown };
export interface ApprovalReplyContext {
  meta: ConversationMeta;
  text: string;
  images?: ImageAttachment[];
  clientMessageId?: string;
  requests: Request[];
  competingQuestionOrPlan: boolean;
  updateInstalling: boolean;
  mobile: boolean;
  resolve: (requestId: string, decision: 'allow' | 'deny', message: string) => { ok: boolean };
  newId: () => string;
  accepted: (message: ChatMessage) => void;
}

export function handleApprovalReply(ctx: ApprovalReplyContext): { ok: boolean; error?: string; authorization?: boolean; msgId?: string } | undefined {
  const decision = approvalReplyDecision(ctx.text);
  if (!decision || ctx.images?.length) return;
  const previous = ctx.clientMessageId && ctx.meta.messages.find(message =>
    message.role === 'user' && message.clientMessageId === ctx.clientMessageId);
  if (previous) return previous.approvalResponse ? { ok: true, authorization: true, msgId: previous.id } : undefined;
  const requests = ctx.requests.filter(request => request.convId === ctx.meta.id);
  if (!requests.length) return;
  if (ctx.meta.archived || ctx.updateInstalling) return { ok: false, error: '当前不能处理授权，请稍后重试。' };
  if (requests.length !== 1 || ctx.competingQuestionOrPlan) {
    return { ok: false, error: '有多项待确认请求，请在对应卡片中明确选择；本条消息未批准任何操作。' };
  }
  const request = requests[0];
  if (ctx.mobile && JSON.stringify(request.request ?? {}).length > 100000) {
    return { ok: false, error: '请求超出手机显示范围，请在桌面端查看后授权。' };
  }
  // Consume the exact live request synchronously. Never create a conversation-wide grant.
  const result = ctx.resolve(request.requestId, decision,
    `用户通过对话${decision === 'allow' ? '允许' : '拒绝'}本次操作：${ctx.text.trim()}`);
  if (!result.ok) return { ok: false, error: '授权请求已失效，请刷新后重试。' };
  const message: ChatMessage = {
    id: ctx.newId(), clientMessageId: ctx.clientMessageId, role: 'user', content: ctx.text,
    ts: new Date().toISOString(), approvalResponse: { requestId: request.requestId, decision },
  };
  ctx.meta.messages.push(message);
  ctx.meta.updatedAt = message.ts;
  ctx.accepted(message);
  return { ok: true, authorization: true, msgId: message.id };
}
