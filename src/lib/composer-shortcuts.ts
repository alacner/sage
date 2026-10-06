import { useEffect, useRef } from 'react';
import type { ComposerShortcutEvent } from '../../shared/composer-shortcuts';

/** Shortcut events and the visible toolbar use the same composer actions. */
export function useComposerShortcuts(conversationId: string, voice: boolean, screenshot: boolean, actions: {
  toggleVoice(): void;
  beginHold(): void;
  endHold(): void;
  captureScreenshot(): void;
}, enabled = true) {
  const latest = useRef({ conversationId, voice, screenshot, actions });
  latest.current = { conversationId, voice, screenshot, actions };
  useEffect(() => {
    if (!enabled) return;
    const blocked = () => !!document.querySelector('[data-window-overlay="true"], [data-shortcut-recording="true"]');
    const receive = (event: ComposerShortcutEvent) => {
      const current = latest.current;
      if (event.conversationId !== current.conversationId) return;
      if (event.action === 'voiceHold' && event.phase === 'stop') { current.actions.endHold(); return; }
      if (document.querySelector('[data-shortcut-recording="true"]')) return;
      if (event.action !== 'screenshot' && blocked()) return;
      if (event.action === 'screenshot') { if (current.screenshot) current.actions.captureScreenshot(); }
      else if (current.voice) {
        if (event.action === 'voiceHold') current.actions.beginHold();
        else current.actions.toggleVoice();
      }
    };
    const off = window.api.onComposerShortcut?.(receive);
    return () => { off?.(); window.api.setComposerShortcutScope?.(); actions.endHold(); };
  }, [conversationId, enabled]);
  useEffect(() => {
    if (!enabled) return;
    let previous = '';
    const update = () => {
      const blocked = !!document.querySelector('[data-window-overlay="true"], [data-shortcut-recording="true"]');
      const scope = { conversationId, voice: voice && !blocked, screenshot: screenshot && !document.querySelector('[data-shortcut-recording="true"]') };
      const key = JSON.stringify(scope);
      if (key !== previous) { previous = key; window.api.setComposerShortcutScope?.(scope); }
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-window-overlay', 'data-shortcut-recording'] });
    return () => observer.disconnect();
  }, [conversationId, voice, screenshot, enabled]);
}
