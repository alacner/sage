/**
 * 上下文整理审计（ContextCompactionAudit）的界面文案。
 *
 * 审计记录里存的是机器可读的枚举与诊断串（`auto` / `manual compact requested` /
 * `code; chars=…`），落盘后不会再改；翻译只能发生在展示层，且必须兼容已经存下的
 * 老记录——所以「认得就翻、不认得原样显示」，绝不把未知档位翻成别的词。
 */
import type { ContextCompactionAudit } from '../../shared/types';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** 枚举前缀：与 i18n 里 ctxAudit.* 词条同构。 */
type EnumGroup = 'ctxAudit.mode' | 'ctxAudit.strategy' | 'ctxAudit.contentKind';

/** 枚举 → 界面词；词条缺失时退回原始值（新取值在旧语言包下也不至于空白）。 */
export function contextAuditEnumLabel(t: Translate, group: EnumGroup, value?: string | null): string {
  if (!value) return '';
  const key = `${group}.${value}`;
  const label = t(key);
  return label === key ? value : label;
}

/** 「配置档位 → 实际命中档位」，两者一致（或未记录解析结果）时只说一次。 */
export function contextAuditModeLabel(t: Translate, audit: ContextCompactionAudit): string {
  const base = contextAuditEnumLabel(t, 'ctxAudit.mode', audit.mode);
  const resolved = contextAuditEnumLabel(t, 'ctxAudit.mode', audit.resolvedMode);
  return resolved && resolved !== base ? `${base} → ${resolved}` : base;
}

export function contextAuditSummaryLabel(t: Translate, audit: ContextCompactionAudit): string {
  const base = contextAuditEnumLabel(t, 'ctxAudit.strategy', audit.summaryStrategy);
  const resolved = contextAuditEnumLabel(t, 'ctxAudit.strategy', audit.resolvedSummaryStrategy);
  return resolved && resolved !== base ? `${base} → ${resolved}` : base;
}

export function contextAuditContentLabel(t: Translate, audit: ContextCompactionAudit): string {
  return contextAuditEnumLabel(t, 'ctxAudit.contentKind', audit.contentKind);
}

/** 主进程写死的固定原因 → 词条。 */
const REASON_KEYS: Record<string, string> = {
  'manual compact requested': 'chat.contextAudit.reason.manual',
};

/**
 * 原因：只翻译认得的部分。自动策略的诊断串以内容类型开头
 * （`code; chars=1234; tools=5`），换掉首段即可，后面的量留给排查用，
 * 不该编进词条。
 */
export function contextAuditReasonLabel(t: Translate, audit: ContextCompactionAudit): string {
  const reason = audit.reason ?? '';
  const fixed = REASON_KEYS[reason];
  if (fixed) return t(fixed);
  const prefixed = /^(chat|code|writing|other)(;[\s\S]*)$/.exec(reason);
  if (prefixed) return `${contextAuditEnumLabel(t, 'ctxAudit.contentKind', prefixed[1])}${prefixed[2]}`;
  return reason;
}
