import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { NativeFnInput } from '../shared/composer-shortcuts';
import type { ParsedAccelerator } from '../shared/shortcuts';

export type PriorityState = 'ready' | 'limited' | 'permission-required' | 'unavailable';
export interface NativeApplicationState {
  available: boolean; policy?: 'regular' | 'accessory' | 'prohibited'; hidden?: boolean; active?: boolean;
  iconWidth?: number; iconHeight?: number; iconRepresentations?: number; tileView?: string;
  tileWidth?: number; tileHeight?: number; tileViewWidth?: number; tileViewHeight?: number; tileImageWidth?: number; tileImageHeight?: number; dockPid?: number;
  tileDrawCount?: number; tileDrawContextValid?: boolean; tileRenderVisiblePixels?: number; tileRenderWidth?: number; tileRenderHeight?: number;
  windows?: { number: number; visible: boolean; occluded: boolean; activeSpace: boolean; miniaturized: boolean; level: number; collectionBehavior: number }[];
}
export interface FnKeyMonitor {
  start(callback: (event: NativeFnInput) => boolean): boolean;
  stop(): void;
  priority(enabled: boolean, bindings: ParsedAccelerator[]): { state: PriorityState; unsupported: string[] };
  status(): PriorityState;
  requestScreenCaptureAccess?(): boolean;
  applicationState?(): NativeApplicationState;
  setDockTileIcon?(file: string): NativeApplicationState;
}
export function loadFnKeyMonitor(): FnKeyMonitor | undefined {
  if (process.platform !== 'darwin') return;
  const file = app.isPackaged
    ? path.join(process.resourcesPath, 'native', 'sage-shortcuts.node')
    : path.join(app.getAppPath(), 'resources', 'native', 'sage-shortcuts.node');
  if (!fs.existsSync(file)) return;
  try { return require(file) as FnKeyMonitor; }
  catch { console.warn('[shortcuts] Native Fn key listener is unavailable'); return; }
}
