/**
 * Skills（专业技能）加载器。
 *
 * Skill 是 markdown 文件，采用渐进式披露：
 *   L1 元数据（name + description）在每次对话时注入 system prompt；
 *   L2 正文由模型在任务匹配时通过 `Skill` 工具按需读取。
 *
 * 作用域（两档）：
 *   - **项目级**（project）：`<project>/.sage/skills/` —— 仅当前项目生效
 *   - **全局级**（global）：`<userData>/skills/` —— 所有项目共享（客户端级）
 *   同名时项目级优先。
 *
 * 兼容两种文件格式：
 *   1. YAML frontmatter：`---\nname: ...\ndescription: ...\n---`
 *   2. loop-engine.exportLoopAsSkill 导出的旧格式：`# Skill: 标题` + `## 描述`
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { shell } from 'electron';
import { app } from 'electron';
import { PROJECT_DIR } from './store';

export interface SkillSummary {
  /** 展示名（frontmatter name 或文件标题）。 */
  name: string;
  /** 一句话描述，注入 system prompt 用。 */
  description: string;
  /** 磁盘上的文件名（读取时按名字反查）。 */
  fileName: string;
  /** 作用域：'project' 仅当前项目，'global' 所有项目共享。 */
  scope: 'project' | 'global';
  /** 文件绝对路径（读取时避免重复搜索）。 */
  absPath: string;
}

const MAX_SKILL_READ_BYTES = 128 * 1024; // 128KB —— 单个 skill 正文上限
const MAX_DESCRIPTION_LEN = 200;

export function skillsDir(projectPath: string): string {
  return path.join(projectPath, PROJECT_DIR, 'skills');
}

/** 全局 skill 目录路径。 */
export function globalSkillsDir(): string {
  return path.join(app.getPath('userData'), 'skills');
}

/** 列出指定目录的所有 skill（内部函数）。 */
async function listSkillsInDir(
  dir: string,
  scope: 'project' | 'global',
): Promise<SkillSummary[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return []; // 目录不存在 = 没有 skill
  }

  const out: SkillSummary[] = [];
  for (const file of entries) {
    if (!file.endsWith('.md')) continue;
    try {
      const abs = path.join(dir, file);
      const st = await fs.stat(abs);
      if (!st.isFile()) continue;
      // 只读头部 4KB 解析元数据，避免大文件全量读盘
      const buf = Buffer.alloc(Math.min(4096, st.size));
      const fh = await fs.open(abs, 'r');
      try {
        await fh.read(buf, 0, buf.length, 0);
      } finally {
        await fh.close();
      }
      const head = buf.toString('utf-8');
      const meta = parseSkillMeta(head, file);
      if (meta) {
        out.push({ ...meta, scope, absPath: abs });
      }
    } catch {
      /* 跳过解析失败的文件 */
    }
  }
  return out;
}

/** 扫描项目 skills 目录，返回所有项目级 skill。 */
export async function listSkills(projectPath: string): Promise<SkillSummary[]> {
  return listSkillsInDir(skillsDir(projectPath), 'project');
}

/** 扫描全局 skills 目录，返回所有全局 skill。 */
export async function listGlobalSkills(): Promise<SkillSummary[]> {
  return listSkillsInDir(globalSkillsDir(), 'global');
}

/** Runtime skills ship with the app; user/project definitions may override them. */
export async function listBuiltinSkills(): Promise<SkillSummary[]> {
  try {
    const dir = app.isPackaged
      ? path.join(process.resourcesPath, 'skills')
      : path.join(app.getAppPath(), 'resources', 'skills');
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const groups = await Promise.all(entries.filter(entry => entry.isDirectory() && /^[a-z0-9-]+$/.test(entry.name)).map(async entry => {
      const skills = await listSkillsInDir(path.join(dir, entry.name), 'global');
      return skills.filter(skill => skill.fileName === 'SKILL.md').map(skill => ({ ...skill, fileName: `${entry.name}/SKILL.md` }));
    }));
    return groups.flat();
  } catch { return []; }
}

/** 列出项目、用户、插件和内置技能，同名按此顺序覆盖。 */
export async function listAllSkills(projectPath: string): Promise<SkillSummary[]> {
  const [projectSkills, globalSkills, builtinSkills] = await Promise.all([
    listSkills(projectPath),
    listGlobalSkills(),
    listBuiltinSkills(),
  ]);
  // 项目级同名覆盖全局（按 name 小写比较）
  const projectNames = new Set(projectSkills.map((s) => s.name.toLowerCase()));
  const deduped = globalSkills.filter((s) => !projectNames.has(s.name.toLowerCase()));
  const pluginSkills = await import('./plugins').then(({listEnabledPluginSkills}) => listEnabledPluginSkills(projectPath)).catch(() => [] as Array<{name:string;description:string;plugin:string;file:string;content:string}>);
  const pluginSummaries: SkillSummary[] = pluginSkills.map((s) => ({name:s.name, description:s.description, fileName:`${s.plugin}/${s.file}`, scope:'global', absPath:`plugin://${s.plugin}/${s.file}`}));
  const names = new Set([...projectSkills, ...deduped].map((s) => s.name.toLowerCase()));
  const unseen = (s: SkillSummary) => { const key = s.name.toLowerCase(); if (names.has(key)) return false; names.add(key); return true; };
  return [...projectSkills, ...deduped, ...pluginSummaries.filter(unseen), ...builtinSkills.filter(unseen)];
}

/** 按名字读取 skill 全文（同时查项目级和全局，同名项目优先）。 */
export async function readSkill(
  projectPath: string,
  name: string,
): Promise<{ ok: boolean; content?: string; error?: string }> {
  const skills = await listAllSkills(projectPath);
  const wanted = name.trim().toLowerCase();
  const hit = skills.find((s) => s.name.toLowerCase() === wanted);
  if (!hit) {
    const available = skills.map((s) => `${s.name} [${s.scope}]`).join(', ') || '(none)';
    return { ok: false, error: `Skill not found: ${name}. Available skills: ${available}` };
  }
  if (hit.absPath.startsWith('plugin://')) {
    const [plugin, file] = hit.fileName.split(/\/(.+)/, 2);
    const skill = await import('./plugins').then(({listEnabledPluginSkills}) => listEnabledPluginSkills(projectPath).find((s) => s.plugin === plugin && s.file === file));
    return skill ? { ok: true, content: skill.content } : { ok: false, error: `Skill unavailable: ${name}` };
  }
  const st = await fs.stat(hit.absPath);
  const buf = Buffer.alloc(Math.min(MAX_SKILL_READ_BYTES, st.size));
  const fh = await fs.open(hit.absPath, 'r');
  try {
    await fh.read(buf, 0, buf.length, 0);
  } finally {
    await fh.close();
  }
  let content = buf.toString('utf-8');
  const truncated = st.size > MAX_SKILL_READ_BYTES;
  if (truncated) content += '\n\n[skill content truncated at 128KB]';
  return { ok: true, content };
}

/**
 * 构建注入 system prompt 的 skill 索引段。
 * 同时包含项目级和全局 skill；无 skill 时返回空串（不占 token）。
 * `toolName` 是读取 skill 的工具名：Sage 模式是内置 `Skill`，
 * CLI 原生模式是 MCP 别名（如 mcp__sage__Skill）。
 */
export async function buildSkillIndex(projectPath: string, toolName = 'Skill'): Promise<string> {
  const skills = await listAllSkills(projectPath);
  if (skills.length === 0) return '';
  const lines = skills.map((s) => {
    const scopeTag = s.scope === 'global' ? ' [global]' : '';
    return `- ${s.name}: ${s.description}${scopeTag}`;
  });
  return [
    'Available skills (project-specific and global expertise). When the current task matches a skill,',
    `call the ${toolName} tool with that skill's name to load its full instructions, then follow them.`,
    ...lines,
  ].join('\n');
}

/** 获取全局 skills 目录路径，并确保目录存在。 */
export async function ensureGlobalSkillsDir(): Promise<string> {
  const dir = globalSkillsDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** 在系统文件管理器中打开全局 skills 目录。 */
export async function openGlobalSkillsDir(): Promise<string> {
  const dir = await ensureGlobalSkillsDir();
  shell.openPath(dir);
  return dir;
}

/** 在系统文件管理器中打开项目 skills 目录（不存在则先创建）。 */
export async function openProjectSkillsDir(projectPath: string): Promise<string> {
  const dir = skillsDir(projectPath);
  await fs.mkdir(dir, { recursive: true });
  shell.openPath(dir);
  return dir;
}

// ─── Meta parsing ─────────────────────────────────────────────────────────

interface ParsedSkillMeta {
  name: string;
  description: string;
  fileName: string;
}

export function parseSkillMeta(head: string, fileName: string): ParsedSkillMeta | null {
  // 1) YAML frontmatter
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
  if (fm) {
    const name = frontmatterField(fm[1], 'name');
    const description = frontmatterField(fm[1], 'description');
    if (name) {
      return {
        name,
        description: truncate1(description || '(no description)'),
        fileName,
      };
    }
  }

  // 2) Loop 导出格式：`# Skill: 标题`，描述取 `## 描述` 后第一段
  const titleMatch = /^#\s+(?:Skill:\s*)?(.+)$/m.exec(head);
  if (!titleMatch) return null;
  const name = titleMatch[1].trim();
  let description = '';
  const descSection = /##\s*描述\s*\r?\n([\s\S]*?)(?:\r?\n##|\r?\n---|$)/.exec(head);
  if (descSection) {
    description = descSection[1].split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
  } else {
    // 兜底：取第一个非标题、非引用的正文行
    const body = head.replace(fm ? fm[0] : '', '');
    const firstLine = body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('---'));
    description = firstLine ?? '';
  }
  return { name, description: truncate1(description || '(no description)'), fileName };
}

function frontmatterField(fm: string, key: string): string {
  const m = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'mi').exec(fm);
  if (!m) return '';
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function truncate1(s: string): string {
  const t = s.trim();
  return t.length <= MAX_DESCRIPTION_LEN ? t : t.slice(0, MAX_DESCRIPTION_LEN) + '…';
}
