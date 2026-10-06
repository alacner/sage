import { modelLabel } from '../../shared/model-label';
/**
 * 扁平模型列表组件：按 provider 分组显示所有模型，支持搜索和标签过滤。
 * 参考 LobeChat 风格：每个模型显示渠道商｜模型名称 + 功能标签。
 */
import { useState } from 'react';
import type { ModelProvider } from '../../shared/types';
import { translate } from '../i18n';
import { MODEL_TYPES, type ModelTypeCaps } from '../../shared/model-types';
import { useModelTypes } from '../lib/useModelTypes';
import { ModelTypeIcons, modelTypeIcons, modelTypeLabel } from './ModelTypeIcons';
import { Search, X, Layers, Radio } from 'lucide-react';

interface FlatModelListProps {
  providers: ModelProvider[];
  selected?: { providerId: string; modelId: string } | null;
  onSelect: (providerId: string, modelId: string) => void;
  /** 是否允许为空（设置界面用） */
  allowEmpty?: boolean;
  /** 空选项文案 */
  emptyLabel?: string;
  /** 是否只显示视觉模型（设置界面用） */
  visionOnly?: boolean;
  /**
   * 继承值：列表顶部「跟随」选项中展示的默认模型。
   * 用于标识「当前跟随的默认模型」，模型条目本身不再附加图标。
   */
  inheritedValue?: { providerId: string; modelId: string } | null;
  /** 继承提示 tooltip 文案 */
  inheritedHint?: string;
  /** 当前选中值是否为继承值（true 表示未显式选择，正在跟随 inheritedValue） */
  isInherited?: boolean;
  /**
   * 跟随选项文案。若提供，会在列表顶部渲染一个「跟随全局/项目默认模型」的选项，
   * 点击后调用 onSelect('', '') 以清除显式选择。
   * 支持 %s 占位符，会替换为「提供商｜模型」名称。
   */
  followLabel?: string;
  /** 关闭回调（可选）：提供后会在搜索栏右侧显示 × 按钮 */
  onClose?: () => void;
}

export function FlatModelList({
  providers,
  selected,
  onSelect,
  allowEmpty = false,
  emptyLabel = translate('fml.unselected'),
  visionOnly = false,
  inheritedValue,
  inheritedHint = translate('fml.followDefault'),
  isInherited = false,
  followLabel,
  onClose,
}: FlatModelListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const enabledProviders = providers.filter(p => p.enabled);
  const capsOf = useModelTypes(providers);

  // 构建扁平模型列表（按 provider 分组）
  const groupedModels: Array<{
    provider: ModelProvider;
    models: Array<{ modelId: string; caps: ModelTypeCaps }>;
  }> = [];

  for (const provider of enabledProviders) {
    const models: Array<{ modelId: string; caps: ModelTypeCaps }> = [];
    
    for (const modelId of provider.models) {
      // 能力（启发式 + 探测缓存合并）：视觉/过滤/图标均基于合并后的真实能力
      const caps = capsOf(provider, modelId);
      // 视觉模型过滤
      if (visionOnly && !caps.vision) continue;

      // 搜索过滤
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        if (!(modelLabel(provider, modelId)).toLowerCase().includes(query) && !provider.name.toLowerCase().includes(query)) {
          continue;
        }
      }

      // 标签过滤
      if (filterTag && caps[filterTag as keyof ModelTypeCaps] !== true) continue;

      models.push({ modelId, caps });
    }
    
    if (models.length > 0) {
      groupedModels.push({ provider, models });
    }
  }

  // 跟随选项显示名称
  const inheritedProvider = inheritedValue
    ? enabledProviders.find((p) => p.id === inheritedValue.providerId)
    : null;
  const inheritedDisplayName = inheritedValue
    ? `${inheritedProvider?.name ?? inheritedValue.providerId}｜${modelLabel(inheritedProvider, inheritedValue.modelId)}`
    : '';
  const followOptionLabel = followLabel
    ? inheritedDisplayName
      ? followLabel.replace('%s', inheritedDisplayName)
      : followLabel.replace(/\s*[（(]%s[）)]?/g, '').trim()
    : undefined;

  return (
    <div className="flat-model-list">
      {/* 搜索栏（含可选的关闭按钮） */}
      <div className="flat-model-list-search">
        <Search size={12} className="flat-model-list-search-icon" />
        <input
          type="text"
          placeholder={translate('fml.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="flat-model-list-search-input"
        />
        {onClose ? (
          <button
            type="button"
            className="flat-model-list-close"
            onClick={onClose}
            title={translate('common.close')}
          >
            <X size={14} />
          </button>
        ) : null}
      </div>

      {/* 标签过滤 */}
      <div className="flat-model-list-filters" role="group" aria-label={translate('fml.filterLabel')}>
        {MODEL_TYPES.map(type => {
          const Icon = modelTypeIcons[type];
          return <button key={type} type="button" className={`flat-model-list-filter-btn ${filterTag === type ? 'active' : ''}`} onClick={() => setFilterTag(filterTag === type ? null : type)} title={modelTypeLabel(type)} aria-label={modelTypeLabel(type)} aria-pressed={filterTag === type}><Icon size={15} aria-hidden="true"/></button>;
        })}
      </div>

      {/* 模型列表（按 provider 分组） */}
      <div className="flat-model-list-content">
        {followOptionLabel ? (
          <div
            className={`flat-model-list-follow-option ${isInherited ? 'selected' : ''}`}
            onClick={() => onSelect('', '')}
            title={inheritedHint}
          >
            {followOptionLabel}
          </div>
        ) : allowEmpty ? (
          <div
            className={`flat-model-list-empty-option ${!selected ? 'selected' : ''}`}
            onClick={() => onSelect('', '')}
          >
            {emptyLabel}
          </div>
        ) : null}

        {groupedModels.length === 0 ? (
          <div className="flat-model-list-empty">
            {enabledProviders.length === 0
              ? translate('fml.emptyNoProviders')
              : searchQuery || filterTag
                ? translate('fml.emptyNoMatch')
                : translate('fml.emptyNoModels')}
          </div>
        ) : (
          groupedModels.map(({ provider, models }) => (
            <div key={provider.id} className="flat-model-list-group">
              <div className="flat-model-list-group-header">
                {provider.kind === 'relay' && (
                  <span className="flat-model-list-relay-icon" title={translate('fml.relayTitle')}>
                    <Radio size={12} />
                  </span>
                )}
                {provider.kind === 'composite' && (
                  <span className="flat-model-list-composite-icon" title={translate('fml.compositeTitle')}>
                    <Layers size={12} />
                  </span>
                )}
                {provider.name}
              </div>
              <ul className="flat-model-list-items">
                {models.map(({ modelId, caps }) => {
                  const isSelected =
                    !isInherited && selected?.providerId === provider.id && selected?.modelId === modelId;

                  return (
                    <li
                      key={modelId}
                      className={`flat-model-list-item ${isSelected ? 'selected' : ''}`}
                      onClick={() => onSelect(provider.id, modelId)}
                    >
                      {/* 模型名称 */}
                      <span className="flat-model-list-item-name">
                        {modelLabel(provider, modelId)}
                      </span>

                      {/* 功能标签 */}
                      <ModelTypeIcons caps={caps} />
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
