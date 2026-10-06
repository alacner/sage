/**
 * Anthropic 协议调用的统一默认请求头。
 *
 * 部分订阅制 Anthropic 兼容网关（典型如阿里云百炼 Coding Plan，
 * coding.dashscope.aliyuncs.com/apps/anthropic）会依据请求头校验调用方
 * 是否为受支持的 Coding Agent，否则直接返回
 * HTTP 405 "Coding Plan is currently only available for Coding Agents"。
 *
 * 统一携带 Claude Code 的特征请求头可保证这类网关放行。
 *（已实测：coding.dashscope 不带该头返回 405，带上后返回 200。）
 * 对官方 Anthropic API 与其它 Anthropic 兼容网关携带该头无副作用。
 */
export const CLAUDE_CODE_HEADERS: Record<string, string> = {
  'User-Agent': 'claude-cli/2.0.14 (external, cli)',
  'x-app': 'cli',
};
