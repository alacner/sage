import type {CanUseTool} from '@anthropic-ai/claude-agent-sdk';
import type {UsageStats,MonitorContext} from '../shared/types';
export interface RunChatOptions {
  cwd: string;
  prompt: string | AsyncIterable<any>;
  resume?: string;
  pathToClaudeCodeExecutable?: string;
  canUseTool?: CanUseTool;
  signal?: AbortSignal;
  onText?: (chunk: string) => void;
  onToolUse?: (info: { id: string; name: string; input: any }) => void;
  onToolResult?: (info: import('../shared/types').ToolResultInfo) => void;
  onSessionId?: (id: string) => void;
  /**
   * 澄清管道：提供时注册自定义 MCP 工具 AskUser（对外名
   * mcp__sage__AskUser），模型调用后挂起等待用户回答。
   */
  askUser?: (input: any) => Promise<string>;
  monitor?: MonitorContext;
}

export interface RunChatResult {
  text: string;
  sessionId?: string;
  error?: string;
  /** 本轮 token 用量（从 SDK result 消息提取） */
  usage?: UsageStats;
}
