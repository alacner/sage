/**
 * Plugin System Types
 *
 * Minimal plugin contract. Each plugin contributes:
 *   - sidebarTabs:  entries that appear in the Sidebar tab bar (files / specs / docs / git …)
 *   - tabRenderers:   React components that render main-content tabs for specific OpenTab.kind values
 *   - mainViews:      full-area views the plugin can show (e.g. wiki detail, git diff)
 *
 * Plugins live in src/plugins/<id>/ and are registered in src/plugins/registry.ts.
 */
import type { ComponentType } from 'react';

export interface SidebarTab {
  /** Stable identifier (also used as the Sidebar "sideTab" key). */
  id: string;
  /** i18n key (looked up by the Sidebar via useT). */
  labelKey: string;
  /** Icon shown in the tab bar (any React component, typically a lucide icon). */
  icon: any;
  /** Render function for the sidebar tab body. */
  render: () => React.ReactNode;
  /** Optional compact actions beside the section title. */
  headerActions?: () => React.ReactNode;
  /** Optional predicate — when false, the tab is hidden. */
  visible?: () => boolean;
  /** Tab order hint (lower = earlier in the tab bar). */
  order?: number;
}

/**
 * Maps an OpenTab.kind (from shared/types.ts) to a React component.
 * The component receives no props — it reads state from useAppStore.
 */
export type TabRendererMap = Record<string, ComponentType>;

/**
 * Full-area main views a plugin can own (e.g. wiki detail, git diff).
 * These are shown by App.tsx when a corresponding state flag is set.
 */
export type MainViewMap = Record<string, ComponentType>;

export interface SagePlugin {
  /** Unique plugin id (also used as namespace for store slots, if any). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Sidebar tab contributions. */
  sidebarTabs?: SidebarTab[];
  /** OpenTab.kind → component renderers. */
  tabRenderers?: TabRendererMap;
  /** Named main views this plugin can show. */
  mainViews?: MainViewMap;
}
