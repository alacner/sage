import { PROTECTED } from '../shared/settings-protection';
/**
 * MCP-only secret environment. Values are decrypted from global settings at
 * startup and settings updates; keep them out of process.env so generic child
 * processes and shells cannot inherit MCP credentials.
 */
let stored = new Map<string, string>();

/** Merge a renderer's MCP-variable edits with the latest settings revision. */
export function mergeMcpEnvironmentVariables(
  current: Record<string, string> = {},
  submitted: Record<string, string>,
  baselineNames: string[],
): Record<string, string> {
  if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted) || !Array.isArray(baselineNames) || baselineNames.some(name => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name))) throw new Error('MCP 环境变量配置无效');
  const next = { ...current };
  const names = new Set(Object.keys(submitted));
  for (const name of baselineNames) if (!names.has(name)) delete next[name];
  for (const [name, value] of Object.entries(submitted)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) throw new Error(`环境变量名无效：${name}`);
    if (value === PROTECTED) {
      if (!next[name]) throw new Error(`MCP 环境变量 ${name} 的受保护值不存在`);
    } else if (typeof value === 'string' && value.trim()) next[name] = value;
    else throw new Error(`MCP 环境变量 ${name} 不能为空`);
  }
  return next;
}

export function loadMcpEnvironmentVariables(values?: Record<string, string>) {
  stored = new Map(Object.entries(values ?? {}).filter(([name, value]) =>
    /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) && typeof value === 'string' && !!value,
  ));
}

export function getMcpEnvironmentVariable(name: string): string | undefined {
  return stored.get(name) || process.env[name];
}
