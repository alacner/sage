import { contextBridge, ipcRenderer } from 'electron';
import type { ScreenshotEditorApi } from '../shared/screenshot';

// The independent editor has no conversation, file-reading or network API.
const api: ScreenshotEditorApi = {
  state: () => ipcRenderer.invoke('screenshot-editor:state'),
  retry: displayId => ipcRenderer.invoke('screenshot-editor:retry', displayId),
  ready: revision => ipcRenderer.invoke('screenshot-editor:ready', revision),
  export: (kind, png) => ipcRenderer.invoke('screenshot-editor:export', kind, png),
  close: () => ipcRenderer.invoke('screenshot-editor:close'),
  privacy: () => ipcRenderer.invoke('screenshot-editor:privacy'),
};
contextBridge.exposeInMainWorld('screenshotEditor', api);
