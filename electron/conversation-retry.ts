import { createHash } from 'node:crypto';
import type { ChatMessage, ConversationMeta } from '../shared/types';

/** Exact identities captured by the failed attempt; never infer a retry from equal text. */
export type FailedTurnAnchor =
  | { state: 'before-user'; historyMessageIds: string[] }
  | { state: 'messages'; userMessageId: string; userFingerprint: string; assistantMessageId?: string };

function userFingerprint(user: ChatMessage): string {
  return createHash('sha256').update(JSON.stringify({
    content: user.content, images: user.images, inbound: user.inbound,
    interjection: user.interjection, visionContent: user.visionContent,
  })).digest('hex');
}

export function retryUserMessage(meta: ConversationMeta, messageId: string): ChatMessage {
  const user = meta.messages.find(message => message.id === messageId);
  if (!user || user.role !== 'user' || user.interjection) throw Error('原始提问已变化，请刷新后使用消息上的重试');
  return user;
}

export function captureFailedTurnAnchor(
  meta: ConversationMeta, initialMessageIds: string[], userMessageId?: string, assistantMessageId?: string,
): FailedTurnAnchor | undefined {
  if (userMessageId) {
    const user = meta.messages.find(message => message.id === userMessageId && message.role === 'user');
    if (user && !user.interjection) return { state: 'messages', userMessageId, userFingerprint: userFingerprint(user), assistantMessageId };
    return;
  }
  // Hooks / project validation can fail before a user is inserted. Expert orchestration,
  // continuations and accepted interjections change history and cannot take this shortcut.
  if (initialMessageIds.length === meta.messages.length && initialMessageIds.every((id, index) => meta.messages[index].id === id))
    return { state: 'before-user', historyMessageIds: initialMessageIds };
}

/** Reject ambiguous or destructive retries; a message-row retry retains its own confirmed semantics. */
export function planFailedConversationRetry(meta: ConversationMeta, anchor?: FailedTurnAnchor): {
  retryUserMessageId?: string; removeAssistantMessageId?: string;
} {
  if (!anchor) throw Error('无法定位这次失败的原始消息，请刷新后使用消息上的重试；历史已保留');
  if (meta.messages.some(message => message.pending)) throw Error('对话正在执行，请稍后重试');
  if (anchor.state === 'before-user') {
    if (meta.messages.length !== anchor.historyMessageIds.length || anchor.historyMessageIds.some((id, index) => meta.messages[index].id !== id))
      throw Error('失败后对话已有新消息，请补充消息继续；历史已保留');
    return {};
  }
  const user = retryUserMessage(meta, anchor.userMessageId);
  if (userFingerprint(user) !== anchor.userFingerprint) throw Error('原始提问已变化，请使用消息上的重试；历史已保留');
  const userIndex = meta.messages.indexOf(user);
  if (!anchor.assistantMessageId) {
    if (userIndex !== meta.messages.length - 1) throw Error('失败后对话已有新消息，请补充消息继续；历史已保留');
    return { retryUserMessageId: user.id };
  }
  const assistant = meta.messages[userIndex + 1];
  if (!assistant || assistant.id !== anchor.assistantMessageId || assistant.role !== 'assistant' || !assistant.error)
    throw Error('失败消息已变化，请刷新后使用消息上的重试；历史已保留');
  if (assistant.content?.trim() || assistant.toolCalls?.length || assistant.images?.length || assistant.experts || assistant.contextCompaction)
    throw Error('该轮已有输出或工具操作，请使用消息上的重试或补充消息继续；历史已保留');
  if (userIndex + 1 !== meta.messages.length - 1) throw Error('失败后对话已有新消息或插话，请补充消息继续；历史已保留');
  return { retryUserMessageId: user.id, removeAssistantMessageId: assistant.id };
}
