import type {MonitorContext,ClaudeBridgeStatus} from '../shared/types';
export interface RunClaudeOptions {
  cwd: string;
  prompt: string;
  permissionMode?: 'plan' | 'default' | 'acceptEdits' | 'bypassPermissions';
  model?: string;
  /** 显式 API 凭证（来自模型档案）。传入时 plan 模式强制走 API 直连。 */
  apiKey?: string;
  baseUrl?: string;
  relayTransport?: import("./relay-tls").RelayTransport;
  /** true = 凭证来自模型档案，plan 模式强制 API 直连。 */
  forceApi?: boolean;
  /** API 协议：anthropic（默认）或 openai。仅在 forceApi / API 直连时生效。 */
  protocol?: 'anthropic' | 'openai';
  resumeSessionId?: string;
  signal?: AbortSignal;
  onText?: (chunk: string) => void;
  onTool?: (info: {
    id?: string;
    name: string;
    input?: any;
    result?: any;
    phase: 'use' | 'result';
  }) => void;
  onLog?: (line: string) => void;
  onSessionId?: (id: string) => void;
  /** 请求监控元数据（不影响行为）。 */
  monitor?: MonitorContext;
}

export interface RunClaudeResult {
  text: string;
  exitCode: number | null;
  error?: string;
  sessionId?: string;
}


export function setBinaryOverride(_p?:string){}
export async function detectClaude(_force=false):Promise<ClaudeBridgeStatus>{return {available:false,error:'Install a CLI engine plugin in Global → Plugins'};}
export async function runClaude(opts:RunClaudeOptions):Promise<RunClaudeResult>{return (await import('./claude-api-bridge')).runPlanMode(opts);}
export async function ensureDir(p:string){await (await import('node:fs/promises')).mkdir(p,{recursive:true});}
