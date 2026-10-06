import type { ExpertDefinitionConfig, ExpertRole } from '../../shared/types';
import { resolveBuiltinExpertDefinition, resolveExpertDefinition } from '../../shared/expert-definitions';
import { Brain, Bug, Code2, FlaskConical, ScanEye, Search, type LucideIcon } from 'lucide-react';

/**
 * Presentation metadata for an expert role.
 *
 * The renderer used to have a hard-coded map of the built-in roles.  That
 * meant a valid custom role (for example `security`) fell through to the
 * full-stack entry in the chat UI.  The task still carried the custom
 * member's name, so the result looked like "Full-Stack Engineer Morgan" and
 * made a correct assignment appear to be wrong.  Resolve the persisted
 * definitions at render time so custom names and icons stay aligned with the
 * role id in the plan.
 */
export type ExpertMeta = {
  name: string;
  humanName: string;
  icon?: string;
  Icon: LucideIcon;
};

const BUILTIN_META: Record<string, ExpertMeta & { enName: string }> = {
  lead: { name: '项目经理', enName: 'Project Manager', humanName: 'Guangzhou', Icon: Brain },
  researcher: { name: '研究员', enName: 'Researcher', humanName: 'Xuyang', Icon: Search },
  fullstack: { name: '全栈工程师', enName: 'Full-Stack Engineer', humanName: 'Zihan', Icon: Code2 },
  qa: { name: 'QA 工程师', enName: 'QA Engineer', humanName: 'Yucong', Icon: FlaskConical },
  reviewer: { name: '代码审查员', enName: 'Code Reviewer', humanName: 'Xinyi', Icon: ScanEye },
  debug: { name: '调试工程师', enName: 'Debug Engineer', humanName: 'Baobao', Icon: Bug },
};

const FALLBACK_META: ExpertMeta & { enName: string } = {
  name: '专家',
  enName: 'Expert',
  humanName: 'Expert',
  Icon: Code2,
};

export type ExpertDefinitions = Partial<Record<string, ExpertDefinitionConfig>>;

export function resolveExpertMeta(role: ExpertRole, definitions?: ExpertDefinitions, english?: boolean): ExpertMeta {
  const builtIn = resolveBuiltinExpertDefinition(role, english);
  const persisted = definitions?.[role];
  const base = BUILTIN_META[role] ?? FALLBACK_META;
  if (!builtIn && !persisted) return { ...base };

  const definition: Partial<ExpertDefinitionConfig> = resolveExpertDefinition(role, persisted, english) ?? {};
  const name = typeof definition.name === 'string' && definition.name.trim() ? definition.name.trim() : (english ? base.enName : base.name);
  const humanName = Array.isArray(definition.humanNames) && definition.humanNames[0]?.trim()
    ? definition.humanNames[0].trim()
    : base.humanName;
  const icon = typeof definition.icon === 'string' && definition.icon.trim() ? definition.icon.trim() : undefined;
  return { name, humanName, icon, Icon: base.Icon };
}

/** Render the configured emoji/icon, with the built-in Lucide icon as fallback. */
export function ExpertGlyph({ meta, size = 14, className }: { meta: ExpertMeta; size?: number; className?: string }) {
  if (meta.icon) {
    return (
      <span
        className={className}
        aria-hidden="true"
        style={{ display: 'inline-block', fontSize: size, lineHeight: 1, verticalAlign: '-1px' }}
      >
        {meta.icon}
      </span>
    );
  }
  const Icon = meta.Icon;
  return <Icon size={size} className={className} />;
}

