/** Project file-tool approval only. Bash uses command-decision; network tools never auto-approve here. */
import { checkUrl, getAllowedHosts } from './sandbox/net-policy';
import { resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { commandPolicy } from './sandbox/command-decision';

/** 展开 ~ 前缀。 */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

/** 路径是否在项目目录内（支持相对路径 / ~ / .. 规范化）。 */
export function isPathInsideProject(p: string, projectPath: string): boolean {
  if (!p || !p.trim()) return false;
  const root = resolve(projectPath);
  const expanded = expandHome(p.trim());
  // 绝对路径直接规范化；相对路径按项目根解析
  const abs = expanded.startsWith('/') ? resolve(expanded) : resolve(root, expanded);
  return abs === root || abs.startsWith(root + sep);
}

/**
 * 判断一次工具调用是否完全落在当前项目目录内。
 * 只有能明确判定的工具才返回 true；未知/网络类工具保守返回 false。
 */
export function isProjectScopedToolCall(toolName: string, input: any, projectPath: string): boolean {
  if (!projectPath) return false;
  const name = toolName.replace(/^mcp__sage__/, '');

  switch (name) {
    // 文件读写类：目标路径必须在项目内
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const p = input?.file_path ?? input?.notebook_path;
      return typeof p === 'string' && isPathInsideProject(p, projectPath);
    }
    // 搜索类：path 参数可选，缺省 = 项目根；指定时须在项目内
    case 'Glob':
    case 'Grep': {
      const p = input?.path;
      return p === undefined || p === null || p === '' ||
        (typeof p === 'string' && isPathInsideProject(p, projectPath));
    }
    default:
      // WebFetch / WebSearch / Task（子代理）/ 未知工具：保守，不自动批准
      return false;
  }
}

/** Shared by ordinary and expert sessions; legacy conversation bypass flags are ignored. */
export async function autoApproveProjectTool(toolName: string, input: any, projectPath: string, readSettings: () => Promise<any>): Promise<boolean> {
  const current = await commandPolicy(projectPath);
  if (current.runtime?.fullAccess) return true;
  if (toolName === 'WebFetch') return checkUrl(String(input?.url ?? ''),getAllowedHosts()).ok;
  if (!isProjectScopedToolCall(toolName, input, projectPath)) return false;
  if (['Read', 'Glob', 'Grep'].includes(toolName.replace(/^mcp__sage__/, ''))) return true;
  const policy = await commandPolicy(projectPath);
  if (typeof policy.review?.projectFiles === 'boolean') return policy.review.projectFiles;
  // Read old global setting only until this project's wizard saves an explicit choice.
  try { return (await readSettings())?.autoApproveProjectScope !== false; }
  catch { return false; }
}
