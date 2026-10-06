/// <reference types="vite/client" />
import type { SageApi } from '../electron/preload';

declare global {
  interface Window {
    api: SageApi;
  }
}

export {};
