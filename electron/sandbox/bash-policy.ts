/**
 * Bash 命令沙箱：危险模式黑名单 + 路径强制约束。
 *
 * 现状：api-tool-executor.ts 的 execBash 直接 execFile('/bin/sh', ['-c', cmd])，
 * 仅靠 project-scope.ts 做"是否自动放行"判断，项目外命令仍可经审批执行。
 *
 * 方案：三层防御——
 *   1. 危险模式硬拒（sudo/mkfs/launchctl/crontab/curl|sh 等）
 *   2. 敏感路径硬拒，疑似项目外路径进入预审/人工审批
 *   3. 网络类子命令交由 net-policy 二次校验
 */

import { resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { isDeniedRead, isDeniedWrite, isPathInsideProject, isSafeSystemPath } from './fs-policy';
import { getSandboxOverrides } from '../main';
import { commandForPolicy, isSimpleCommand } from './shell-content';
import type { SandboxOverrides } from '../../shared/types';

/** 检查结果。 */
export interface BashCheckResult {
  ok: boolean;
  reason?: string;
  /** A heuristic finding requires review, never an unconditional rejection. */
  review?: boolean;
}

/**
 * 绝对禁止清单（硬拒，不进审批）。
 * 复用并扩展 project-scope.ts 的 DANGEROUS_BASH_PATTERNS，新增持久化后门路径。
 * 借鉴 Claude Code 的破坏性命令分类器（destructive-target-scope）。
 * 用户可在"设置 → 安全"面板覆盖（正则字符串数组）。
 */
export const DEFAULT_HARD_DENIED_PATTERNS: string[] = [
  // 提权 / 系统破坏
  String.raw`\bsudo\b`,
  String.raw`\bmkfs\b`,
  String.raw`\bdd\s+[^|;&]*\bof=`,
  String.raw`\bdiskutil\b`,
  String.raw`\bchmod\s+(-R\s+)?[0-7]*777`,
  String.raw`\bchown\b`,
  String.raw`\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b`,
  String.raw`\bkillall\b`,
  // 持久化后门
  String.raw`\blaunchctl\b`,
  String.raw`\bdefaults\s+write\b`,
  String.raw`\bcrontab\b`,
  String.raw`\bcp\s+[^|;&]*~\/\.zshrc\b`,
  String.raw`\bcp\s+[^|;&]*~\/\.bashrc\b`,
  String.raw`\bcp\s+[^|;&]*~\/\.zprofile\b`,
  String.raw`\bcp\s+[^|;&]*~\/\.bash_profile\b`,
  // 远程执行（管道执行脚本内容：curl x | sh）
  String.raw`\|\s*(sudo\s+)?(ba|z|da)?sh\b`,
  // 写非常规设备
  String.raw`>\s*\/dev\/(?!null|zero|std)`,
  // 破坏性 git 操作（force push / reset --hard 会造成不可逆的代码丢失）
  String.raw`\bgit\s+push\b[^|;&\n]*(?:\s-f\b|\s--force\b|\s--force-with-lease\b)`,
  String.raw`\bgit\s+reset\s+--hard\b`,
  // 注意：rm -rf 不在此硬拒——项目内 rm -rf 是正常操作（如清理构建产物）。
  // 项目外路径由第 2 层送审，禁止未经授权执行。
  // 仅 rm -rf /（根目录）在此硬拒，因为这是不可恢复的系统破坏。
  String.raw`\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f\s+)?\/(?:\s|$)`,
];

/**
 * 从 Bash 命令里提取所有路径 token（以 / 或 ~/ 开头的独立 token）。
 *
 * ⚠️ 已知局限：无法解析 shell 变量展开（如 $HOME/.ssh）、命令替换（$(echo ~/.ssh)）、
 * base64 编码等间接构造。这是应用级沙箱的固有局限——正则解析无法覆盖所有
 * shell 语义。P3 阶段的 OS 进程沙箱（seatbelt）提供内核级兜底，绕不过。
 */
function extractPathTokens(cmd: string): string[] {
  // 去掉 URL（https://... 不是文件系统路径）
  const noUrls = cmd.replace(/https?:\/\/[^\s'"`]+/g, ' ');

  // 按重定向符/管道/分号/环境变量赋值符/PATH 分隔符两侧补空格，使各成为拆分边界
  const tokens = noUrls
    .replace(/([<>|;&]{1,2}|=|:)/g, ' $1 ')
    .split(/[\s'"`]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && (t.startsWith('/') || t.startsWith('~/')));

  return tokens;
}

/**
 * 检查一条 Bash 命令是否可执行。
 * @param cmd 完整 shell 命令
 * @param projectPath 当前项目路径
 */
export function checkBashCommand(cmd: string, projectPath: string, policy?: SandboxOverrides): BashCheckResult {
  const command = commandForPolicy((cmd || '').trim());
  if (!command) return { ok: false, reason: 'command is required' };

  // 从 sandboxOverrides 读取用户配置，不存在则用默认值
  const overrides = (policy ?? getSandboxOverrides())?.bash;
  const simple = isSimpleCommand(cmd);
  const patternStrings = overrides?.hardDenied ?? DEFAULT_HARD_DENIED_PATTERNS;

  // 第 1 层：危险模式硬拒（动态编译正则）
  for (const pattern of patternStrings) {
    try {
      const re = new RegExp(pattern);
      if (re.test(command)) {
        return { ok: false, review: overrides?.hardDenied ? undefined : !simple || undefined, reason: `命令命中拒绝规则：${pattern}` };
      }
    } catch {
      // 非法正则跳过，不影响其他检查
    }
  }

  // 第 2 层：路径强制约束
  const tokens = extractPathTokens(command);
  let reviewReason: string | undefined;
  for (const t of tokens) {
    // 跳过通配符模式（如 */node_modules/*）
    if (t.includes('*') || t.includes('?')) { reviewReason = '通配路径需要审核'; continue; }

    if (isDeniedRead(t, policy?.fs, projectPath)) {
      return { ok: false, review: !simple || undefined, reason: `敏感路径命中: ${t}` };
    }
    if (isDeniedWrite(t, policy?.fs, projectPath)) {
      return { ok: false, review: !simple || undefined, reason: `受保护路径命中: ${t}` };
    }
    if (!isPathInsideProject(t, projectPath) && !isSafeSystemPath(t, policy?.fs)) {
      reviewReason = `疑似项目外路径，需要确认用途: ${t}`;
    }
  }

  if (!simple && !reviewReason) reviewReason = '复杂 shell 或脚本内容需要审核';
  return reviewReason ? { ok: false, review: true, reason: reviewReason } : { ok: true };
}

/**
 * 从 Bash 命令里提取所有 URL（供 net-policy 校验）。
 * 匹配 curl/wget 等网络命令后的 URL 参数。
 */
export function extractUrls(cmd: string): string[] {
  const command = commandForPolicy(cmd || '');
  const urls: string[] = [];
  // 标准 URL 正则
  const urlRe = /https?:\/\/[^\s'"`<>|;&]+/g;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(command)) !== null) {
    urls.push(m[0]);
  }
  return urls;
}
