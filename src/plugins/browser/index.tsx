/**
 * Browser Plugin
 *
 * Contributions:
 *   - sidebar tab: Quick access to browser with predefined URLs
 *   - tab renderer: 'browser' OpenTab → embedded webview browser
 *   - main views: Embedded Chrome browser (webview)
 */
import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import type { SagePlugin } from '../types';
import { enabledBuiltins } from '../../../shared/builtin-plugins';
import { BrowserSidebarTab, BrowserSidebarActions } from './BrowserSidebarTab';
import { BrowserView } from './components/BrowserView';
import { useAppStore } from '../../stores/appStore';

/**
 * Browser tab wrapper — reads the active browser tab's URL from the store
 * and renders BrowserView with it as the initial URL.
 * Also listens for the tab-bar context menu's "reload" event targeting this tab.
 */
function BrowserTabView() {
  const url = useAppStore((s) => {
    const tab = s.openTabs.find((t) => t.id === s.activeTabId);
    if (tab && tab.kind === 'browser') {
      return (tab.data as { url?: string } | undefined)?.url;
    }
    return undefined;
  });
  const tabId = useAppStore((s) => {
    const tab = s.openTabs.find((t) => t.id === s.activeTabId);
    return tab && tab.kind === 'browser' ? tab.id : undefined;
  });
  const incognito = useAppStore((s) => {
    const tab = s.openTabs.find((t) => t.id === s.activeTabId);
    return tab && tab.kind === 'browser' ? !!(tab.data as { incognito?: boolean } | undefined)?.incognito : false;
  });
  const [reloadNonce, setReloadNonce] = useState(0);
  useEffect(() => {
    const handler = (e: Event) => {
      if ((e as CustomEvent).detail === tabId) setReloadNonce((n) => n + 1);
    };
    window.addEventListener('sage:browser-reload', handler);
    return () => window.removeEventListener('sage:browser-reload', handler);
  }, [tabId]);
  return <BrowserView initialUrl={url} reloadNonce={reloadNonce} tabId={tabId} incognito={incognito} />;
}

export const browserPlugin: SagePlugin = {
  id: 'browser',
  name: 'Browser',
  sidebarTabs: [
    {
      id: 'browser',
      labelKey: 'sidebar.browser',
      icon: Globe,
      order: 5,
      // Git and Browser are permanent workspace sections.
      visible: () => {
        const s = useAppStore.getState();
        return enabledBuiltins(s.settings, s.currentProject).includes('browser');
      },
      render: () => <BrowserSidebarTab />,
      headerActions: () => <BrowserSidebarActions/>,
    },
  ],
  tabRenderers: {
    browser: BrowserTabView,
  },
  mainViews: {
    browser: BrowserView,
  },
};
