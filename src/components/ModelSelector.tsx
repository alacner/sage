import type { ModelProvider, SelectedModel } from '../../shared/types';
import { useT } from '../i18n';
import { ModelCombo } from './ModelCombo';
interface ModelSelectorProps {
  providers: ModelProvider[];
  /** 当前选中的模型 */
  value: SelectedModel | null;
  /** 选择回调 */
  onChange: (selected: SelectedModel | null) => void;
  /** 是否允许为空 */
  allowEmpty?: boolean;
  /** 空选项文案 */
  emptyLabel?: string;
  /** 是否只显示视觉模型 */
  visionOnly?: boolean;
  /** 标题 */
  label?: string;
  /** 帮助文案 */
  help?: string;
  /**
   * 继承值：当 `value` 为空时，显示该模型并带上继承提示图标。
   * 用于「项目默认模型跟随全局默认模型」等场景。
   */
  inheritedValue?: SelectedModel | null;
  /** 继承提示 tooltip 文案 */
  inheritedHint?: string;
}

export function ModelSelector({label,help,...props}:ModelSelectorProps) {
  const t=useT();
  return <div className="model-selector">
    {label&&<div className="model-selector-label"><span>{label}</span>{help&&<span className="muted small">{help}</span>}</div>}
    <ModelCombo {...props} followLabel={props.emptyLabel} emptyLabel={props.emptyLabel??t('fml.unselected')}/>
  </div>;
}
