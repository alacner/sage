import { useState } from 'react';
import {
  APPEARANCE_COLOR_TOKENS,
  isHexColor,
  toPickerHex,
  type AppearanceColorKey,
  type AppearanceColorToken,
  type AppearanceColorGroup,
} from '../../shared/appearance';
import type { AppearanceColorOverrides } from '../../shared/types';

/** 接受的颜色输入：#hex / rgb() / rgba()；其余视为非法不回写配置。 */
function isAcceptableColor(value: string): boolean {
  return isHexColor(value) || /^rgba?\(\s*\d+[\s,]+\d+[\s,]+\d+\s*(,[\s\d.]+)?\)$/.test(value.trim());
}

interface ColorRowProps {
  token: AppearanceColorToken;
  mode: 'light' | 'dark';
  label: string;
  resetTitle: string;
  value: string | undefined;
  onChange: (next: string | undefined) => void;
  /** 重置/未覆盖时的目标色（内置扩展主题用自己的默认盘，而非浅/深基础盘）。 */
  themeDefault?: string;
}

/**
 * 单行主题色编辑：色块（原生取色器）+ 文本框 + 重置。
 * 文本框用本地 draft 承接中间态，只有合法颜色才回写配置，
 * 失焦时非法输入回退到已提交值，避免把半个 hex 写进设置。
 */
function ColorRow({ token, mode, label, resetTitle, value, onChange, themeDefault }: ColorRowProps) {
  const fallback = themeDefault ?? token.defaults[mode];
  const committed = value ?? fallback;
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? committed;
  const customized = value !== undefined;
  return (
    <div className="appearance-color-row">
      <span className="appearance-color-label">{label}</span>
      <span className="appearance-color-control">
        <input
          type="color"
          className="appearance-color-swatch"
          aria-label={label}
          value={toPickerHex(shown, fallback)}
          onChange={(e) => { setDraft(null); onChange(e.target.value); }}
        />
        <input
          type="text"
          className="appearance-color-hex"
          spellCheck={false}
          value={shown}
          onChange={(e) => {
            const next = e.target.value;
            setDraft(next);
            if (next.trim() === '') onChange(undefined);
            else if (isAcceptableColor(next)) onChange(next.trim());
          }}
          onBlur={() => setDraft(null)}
        />
        {/* 重置仅在该行确有覆盖改动时出现，点击恢复到该主题默认色 */}
        {customized && (
          <button
            type="button"
            className="btn-ghost btn-xs appearance-color-reset"
            title={resetTitle}
            onClick={() => { setDraft(null); onChange(undefined); }}
          >
            ↺
          </button>
        )}
      </span>
    </div>
  );
}

interface ThemeColorEditorProps {
  colorGroups?: AppearanceColorGroup[];
  colorExtensions?: React.ReactNode;
  /** 当前编辑的调色板（浅/深）。 */
  mode: 'light' | 'dark';
  /** 该调色板已有的覆盖值。 */
  overrides: AppearanceColorOverrides;
  /** token 显示名（按应用语言取 zh/en）。 */
  labelFor: (token: AppearanceColorToken) => string;
  advancedTitle: string;
  groupLabelFor?: (group: AppearanceColorGroup) => string;
  resetTitle: string;
  onChange: (next: AppearanceColorOverrides) => void;
  /** 未覆盖/重置行的目标色（内置扩展主题传入自身默认盘；缺省回浅/深基础盘）。 */
  themeDefaults?: Partial<Record<AppearanceColorKey, string>>;
}

/**
 * 主题色编辑器：基础项、高级项及已注册的插件配色插槽。
 * 只存覆盖值；重置即从覆盖表删除该 token，回退当前主题的默认调色板。
 * 插件分组默认收起，宿主不需要知道有哪些插件或颜色。
 */
export function ThemeColorEditor({ mode, overrides, labelFor, advancedTitle, groupLabelFor, resetTitle, onChange, themeDefaults, colorGroups=[], colorExtensions }: ThemeColorEditorProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<string[]>([]);
  const commit = (token: AppearanceColorToken, next: string | undefined) => {
    const nextOverrides: AppearanceColorOverrides = { ...overrides };
    if (next === undefined) delete nextOverrides[token.key];
    else nextOverrides[token.key] = next;
    onChange(nextOverrides);
  };
  const renderRow = (token: AppearanceColorToken) => (
    <ColorRow
      key={token.key}
      token={token}
      mode={mode}
      label={labelFor(token)}
      resetTitle={resetTitle}
      value={overrides[token.key]}
      themeDefault={themeDefaults?.[token.key]}
      onChange={(next) => commit(token, next)}
    />
  );
  return (
    <div className="appearance-color-editor">
      {APPEARANCE_COLOR_TOKENS.filter((t) => t.basic).map(renderRow)}
      <button
        type="button"
        className="appearance-advanced-toggle"
        aria-expanded={advancedOpen}
        onClick={() => setAdvancedOpen((v) => !v)}
      >
        <span>{advancedTitle}</span>
        <span className={`appearance-advanced-chevron ${advancedOpen ? 'open' : ''}`}>▾</span>
      </button>
      {advancedOpen ? APPEARANCE_COLOR_TOKENS.filter((t) => !t.basic && !t.group).map(renderRow) : null}
      {advancedOpen&&[{id:'mermaid',zh:'Mermaid 图表',en:'Mermaid diagrams',tokens:APPEARANCE_COLOR_TOKENS.filter(t=>t.group==='mermaid')},...colorGroups].map(group=>(
        <div className="appearance-color-group" key={group.id} data-color-contribution={group.id}>
          <button
            type="button"
            className="appearance-advanced-toggle appearance-group-toggle"
            aria-expanded={openGroups.includes(group.id)}
            onClick={() => setOpenGroups(ids=>ids.includes(group.id)?ids.filter(id=>id!==group.id):[...ids,group.id])}
          >
            <span>{groupLabelFor?.(group)??group.zh}</span>
            <span className={`appearance-advanced-chevron ${openGroups.includes(group.id) ? 'open' : ''}`}>▾</span>
          </button>
          {openGroups.includes(group.id) ? group.tokens.map(renderRow) : null}
        </div>
      ))}
      {advancedOpen&&colorExtensions}
    </div>
  );
}
