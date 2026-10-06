import { AnchoredPopover } from './AnchoredPopover';
import { modelLabel } from '../../shared/model-label';
/**
 * 模型选择器：显示当前选中的模型，点击弹出选择面板。
 * 用于对话界面底部工具栏。
 */
import { useState, useRef, useEffect } from 'react';
import type { ModelProvider, SelectedModel } from '../../shared/types';
import { translate } from '../i18n';
import { FlatModelList } from './FlatModelList';
import { Layers } from 'lucide-react';

interface ModelPickerProps {
  providers: ModelProvider[];
  selected: SelectedModel | null;
  onSelect: (selected: SelectedModel) => void;
}

export function ModelPicker({ providers, selected, onSelect }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  // 获取当前选中的模型信息
  const currentProvider = selected
    ? providers.find((p) => p.id === selected.providerId)
    : null;
  const currentModelId = selected?.modelId ?? '';

  // 当前显示名称
  const displayName = currentProvider
    ? modelLabel(currentProvider, currentModelId)
    : translate('modelpicker.unselected');

  const handleSelect = (providerId: string, modelId: string) => {
    if (providerId && modelId) {
      onSelect({ providerId, modelId });
    }
    setOpen(false);
  };

  return (
    <div className="model-picker" ref={pickerRef}>
      <button
        type="button"
        className="model-picker-trigger"
        onClick={() => setOpen(!open)}
      >
        <span className="model-picker-display">
          {currentProvider?.kind === 'composite' && (
            <span className="model-picker-composite-icon" title={translate('fml.compositeTitle')}>
              <Layers size={12} />
            </span>
          )}
          {displayName}
        </span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points={open ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
        </svg>
      </button>

      {open && (
        <AnchoredPopover className="model-picker-dropdown">
          <FlatModelList
            providers={providers}
            selected={selected}
            onSelect={handleSelect}
            onClose={() => setOpen(false)}
          />
        </AnchoredPopover>
      )}
    </div>
  );
}
