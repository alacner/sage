/**
 * Plugin Registry
 *
 * Aggregates all built-in plugins and provides query methods for
 * Sidebar.tsx and App.tsx to discover plugin contributions.
 * 
 * Plugins are only loaded if they are enabled in the current project's
 * enabledPlugins configuration. By default, no plugins are loaded.
 */
import type { SagePlugin, SidebarTab } from './types';
import type { ComponentType } from 'react';
import { gitPlugin } from './git';
import { browserPlugin } from './browser';

/**
 * All registered plugins (built-in).
 */
export const plugins: SagePlugin[] = [gitPlugin, browserPlugin];

/**
 * Get all available plugin IDs (for UI configuration).
 */
export function getAllPluginIds(): string[] {
  return plugins.map((p) => p.id);
}

/**
 * Get all available plugins (for UI configuration).
 */
export function getAllPlugins(): SagePlugin[] {
  return plugins;
}

/**
 * Filter plugins based on enabledPlugins list.
 */
export function getEnabledPlugins(enabledPlugins: string[] = []): SagePlugin[] {
  if (enabledPlugins.length === 0) return [];
  return plugins.filter((p) => enabledPlugins.includes(p.id));
}

/**
 * Get all sidebar tabs from enabled plugins, sorted by order (if specified).
 */
export function getSidebarTabs(enabledPlugins: string[] = []): SidebarTab[] {
  const enabledPluginsList = getEnabledPlugins(enabledPlugins);
  const tabs = enabledPluginsList.flatMap((p) => p.sidebarTabs || []);
  return tabs.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
}

/**
 * Get the React component for a specific OpenTab.kind.
 * Returns null if no enabled plugin handles this kind.
 */
export function getTabRenderer(kind: string, enabledPlugins: string[] = []): ComponentType | null {
  const enabledPluginsList = getEnabledPlugins(enabledPlugins);
  for (const plugin of enabledPluginsList) {
    if (plugin.tabRenderers?.[kind]) {
      return plugin.tabRenderers[kind];
    }
  }
  return null;
}

/**
 * Get the React component for a specific main view ID.
 * Returns null if no enabled plugin provides this view.
 */
export function getMainView(id: string, enabledPlugins: string[] = []): ComponentType | null {
  const enabledPluginsList = getEnabledPlugins(enabledPlugins);
  for (const plugin of enabledPluginsList) {
    if (plugin.mainViews?.[id]) {
      return plugin.mainViews[id];
    }
  }
  return null;
}
