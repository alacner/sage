import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/appStore';

/** A reply is read only when its actual message intersects the visible chat viewport. */
export function useConversationReadReceipts() {
  const conversation = useAppStore(state => state.currentConversation);
  const activeTabId = useAppStore(state => state.activeTabId);
  const attempts = useRef(new Set<string>());
  useEffect(() => {
    if (!conversation?.unread || !conversation.activityRevision || !conversation.lastReplyId || activeTabId !== `conv:${conversation.id}`) return;
    let disposed = false, pending = false;
    const key = `${conversation.id}:${conversation.activityRevision}`;
    const visibleWindow = () => document.visibilityState === 'visible' && document.hasFocus();
    const stillSelected = () => !disposed && useAppStore.getState().activeTabId === activeTabId && useAppStore.getState().currentConversation?.id === conversation.id;
    const read = async () => {
      if (!stillSelected() || !visibleWindow() || pending) return;
      const latest = useAppStore.getState().currentConversation;
      if (!latest?.messages.some(message => message.id === conversation.lastReplyId && !message.pending)) {
        if (attempts.current.has(key)) return;
        attempts.current.add(key);
        if (attempts.current.size > 128) attempts.current.delete(attempts.current.values().next().value!);
        pending = true;
        try { if (stillSelected()) await useAppStore.getState().selectConversation(conversation.id); }
        catch (error) { console.warn('[read-receipt] Cannot refresh visible reply', error); attempts.current.delete(key); }
        finally { pending = false; }
        return;
      }
      const element = document.getElementById(`chat-msg-${conversation.lastReplyId}`)
        ?? document.querySelector<HTMLElement>(`[data-source-message-id="${CSS.escape(conversation.lastReplyId!)}"]`);
      if (!element) return;
      const rect = element.getBoundingClientRect();
      // Also check the clipping scroll container; offscreen history must remain unread.
      const scroller = element.closest('.chat-scroller');
      if (!scroller) return;
      const viewport = scroller.getBoundingClientRect();
      const top = Math.max(0, viewport.top), bottom = Math.min(window.innerHeight, viewport.bottom);
      const left = Math.max(0, viewport.left), right = Math.min(window.innerWidth, viewport.right);
      if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= top || rect.top >= bottom || rect.right <= left || rect.left >= right) return;
      pending = true;
      try {
        const state = await window.api.markConversationRead(conversation.id, conversation.activityRevision!);
        if (stillSelected()) await useAppStore.getState().syncConvListChanged({ projectPath: conversation.projectPath,
          convId: conversation.id, reason: 'read-state', readState: state });
      } catch (error) { console.warn('[read-receipt] Cannot save receipt', error); }
      finally { pending = false; }
    };
    const invoke = () => { void read(); };
    const frame = requestAnimationFrame(invoke);
    window.addEventListener('focus', invoke);
    document.addEventListener('visibilitychange', invoke);
    document.addEventListener('scroll', invoke, true);
    window.addEventListener('resize', invoke);
    return () => { disposed = true; cancelAnimationFrame(frame); window.removeEventListener('focus', invoke);
      document.removeEventListener('visibilitychange', invoke); document.removeEventListener('scroll', invoke, true); window.removeEventListener('resize', invoke); };
  }, [conversation?.id, conversation?.unread, conversation?.activityRevision, conversation?.lastReplyId, conversation?.messages, activeTabId]);
}
