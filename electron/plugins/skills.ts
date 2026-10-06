import type { PluginManager } from './manager';

export interface PluginSkillSummary { name: string; description: string; plugin: string; file: string; content: string; }

/** Read enabled plugin skills without exposing the plugin package filesystem. */
export function listPluginSkills(manager: PluginManager, project: string): PluginSkillSummary[] {
  const out: PluginSkillSummary[] = [];
  for (const p of manager.packages(project).values()) {
    if (!manager.enabled(project).has(p.manifest.id)) continue;
    for (const skill of p.manifest.skills) {
      const content = p.files[skill.file];
      if (content === undefined) continue;
      out.push({ name: skill.name, description: skill.description, plugin: p.manifest.id, file: skill.file, content });
    }
  }
  return out;
}
