import { useEffect, useRef, useState } from 'react';
import { Copy, Download, ExternalLink, Globe } from 'lucide-react';
import { parseHttpLink } from '../../shared/link-download';
import { enabledBuiltins } from '../../shared/builtin-plugins';
import { getTabRenderer } from '../plugins';
import { useT, translate } from '../i18n';
import { useAppStore } from '../stores/appStore';
import { copyMarkdown } from '../lib/clipboard';
import { CursorMenu } from './CursorMenu';

type LinkMenu = { x: number; y: number; url: string; anchor: HTMLAnchorElement };

/** One menu host for HTTP links in chat, document previews and other main-window views. */
export function LinkContextMenu() {
  const t = useT();
  const settings = useAppStore(state => state.settings);
  const project = useAppStore(state => state.currentProject);
  const activeTabId = useAppStore(state => state.activeTabId);
  const [menu, setMenu] = useState<LinkMenu | null>(null);
  const [saving, setSaving] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const currentMenu = useRef(menu);
  const mounted = useRef(true);
  const savePending = useRef(false);
  currentMenu.current = menu;
  const internalBrowser = !!getTabRenderer('browser', enabledBuiltins(settings, project));

  const close = (restoreFocus = false) => {
    const anchor = currentMenu.current?.anchor;
    setMenu(null);
    if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
  };

  useEffect(() => {
    mounted.current = true;
    const onContextMenu = (event: MouseEvent) => {
      // Preserve more specific menus (selected text, project files, browser page contents).
      if (event.defaultPrevented || !(event.target instanceof Element)) return;
      const anchor = event.target.closest<HTMLAnchorElement>('a[href]');
      const raw = anchor?.getAttribute('href');
      if (!anchor || !parseHttpLink(raw)) return;
      event.preventDefault();
      const bounds = anchor.getBoundingClientRect();
      const keyboard = event.clientX === 0 && event.clientY === 0;
      setMenu({ x: keyboard ? bounds.left : event.clientX, y: keyboard ? bounds.bottom : event.clientY,
        url: raw!, anchor });
    };
    const outside = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      close();
    };
    const blur = () => close();
    window.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('pointerdown', outside);
    window.addEventListener('scroll', outside, true);
    window.addEventListener('blur', blur);
    return () => {
      mounted.current = false;
      window.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('scroll', outside, true);
      window.removeEventListener('blur', blur);
    };
  }, []);

  useEffect(() => { close(); }, [activeTabId, project?.path]);

  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      } else if (event.key === 'Tab') close(true);
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) &&
        menuRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        const buttons = [...menuRef.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
        buttons[next]?.focus();
      }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [menu]);

  const open = async (external: boolean) => {
    if (!menu) return;
    const url = menu.url;
    close();
    try {
      const state = useAppStore.getState();
      if (!external && getTabRenderer('browser', enabledBuiltins(state.settings, state.currentProject)))
        state.openBrowserTab(url);
      else await window.api.openExternal(url);
    } catch {
      useAppStore.getState().setBanner(translate('linkMenu.openFailed'));
    }
  };
  const copy = async () => {
    if (!menu) return;
    const url = menu.url;
    close(true);
    if (!await copyMarkdown(url)) useAppStore.getState().setBanner(translate('common.copyFailed'));
  };
  const save = async () => {
    if (!menu || savePending.current) return;
    savePending.current = true;
    const url = menu.url;
    close();
    setSaving(true);
    try {
      const result = await window.api.saveLink(url);
      if (!result.ok && !result.canceled) useAppStore.getState().setBanner(result.error || translate('linkMenu.saveFailed'));
    } catch {
      useAppStore.getState().setBanner(translate('linkMenu.saveFailed'));
    } finally {
      savePending.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  if (!menu) return null;
  return <CursorMenu x={menu.x} y={menu.y} className="file-tab-context-menu" onMouseDown={event => event.stopPropagation()}>
    <div ref={menuRef} role="menu" aria-label={t('linkMenu.title')}>
      <button type="button" role="menuitem" className="ftcm-item" disabled={!internalBrowser} onClick={() => void open(false)}><Globe size={14}/>{t('linkMenu.openInternal')}</button>
      <button type="button" role="menuitem" className="ftcm-item" onClick={() => void open(true)}><ExternalLink size={14}/>{t('browser.openExternal')}</button>
      <div className="ftcm-sep" role="separator"/>
      <button type="button" role="menuitem" className="ftcm-item" onClick={() => void copy()}><Copy size={14}/>{t('browser.copyLink')}</button>
      <button type="button" role="menuitem" className="ftcm-item" disabled={saving} onClick={() => void save()}><Download size={14}/>{t('linkMenu.save')}</button>
    </div>
  </CursorMenu>;
}
