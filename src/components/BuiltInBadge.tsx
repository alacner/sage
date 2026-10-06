import { Package } from 'lucide-react';
import { resolveLanguage } from '../../shared/language';
import { useAppStore } from '../stores/appStore';

/**
 * 统一的"内置"标记：内置角色 / 内置审批方案 / 内置插件共用同一图标。
 * 仅呈现图标（文字通过 title/aria-label 提供，悬停可见），避免列表行文字冗余。
 */
export function BuiltInBadge({ label }: { compact?: boolean; label?: string } = {}) {
  const english = resolveLanguage(useAppStore((s) => s.settings?.language),useAppStore.getState().settings?._systemLocale) === 'en';
  const text = label ?? (english ? 'Built-in' : '内置');
  return (
    <span className="builtin-badge compact" title={text} aria-label={text}>
      <Package size={11} aria-hidden="true" />
    </span>
  );
}
