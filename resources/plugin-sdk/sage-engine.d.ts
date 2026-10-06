/** Sage native engine API v1. engine.native grants trusted Node execution, not a sandbox. */
export interface EngineRunOptions {
  cwd: string;
  prompt: string;
  history?: string;
  images?: {name: string; mimeType: string; dataBase64: string}[];
  resume?: string;
  readOnly?: boolean;
  model?: string;
  binaryPath?: string;
  signal?: AbortSignal;
  monitor?: {source: 'conversation'|'spec'|'loop'|'wiki'|'image'|'other'; label?: string; convId?: string; messageId?: string; specId?: string; projectPath?: string};
  /** Await the host decision BEFORE side effects. Missing approval must fail closed. */
  canUseTool?: (name: string, input: any, context: {toolUseID: string; signal: AbortSignal; suggestions: any[]}) => Promise<any>;
  askUser?: (input: any) => Promise<string>;
  onText?: (chunk: string) => void;
  onSessionId?: (id: string) => void;
  onToolUse?: (info: {id: string; name: string; input: any}) => void;
  onToolResult?: (info: {id: string; result: string; isError?: boolean; fileChanges?: {path: string; added?: number; removed?: number}[]; images?: {name: string; mimeType: string; dataBase64: string}[]}) => void;
}
export interface EngineResult {
  text: string;
  sessionId?: string;
  error?: string;
  usage?: {inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number};
}
export interface EngineStatus {available: boolean; version?: string; path?: string; error?: string}
export interface EngineAdapter {
  apiVersion: 1;
  detect?: (settings: Record<string, unknown>) => Promise<EngineStatus>;
  run: (options: EngineRunOptions, settings: Record<string, unknown>) => Promise<EngineResult>;
}
/** Observational payload only: no prompts, output, credentials or tool inputs. */
export type EngineLifecycleEvent =
  | {event: 'sage/engine.started'; payload: {apiVersion: 1; runId: string; engineId: string; startedAt: number}}
  | {event: 'sage/engine.finished'; payload: {apiVersion: 1; runId: string; engineId: string; status: 'success'|'error'|'aborted'; durationMs: number}};
