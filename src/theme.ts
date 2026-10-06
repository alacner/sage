export type Theme = 'light' | 'dark' | 'system';

import {
  APPEARANCE_COLOR_TOKENS,
  deriveAccent2,
  deriveAccentSoft,
  findBuiltinTheme,
  type AppearanceColorGroup,
  type AppearanceColorToken,
} from '../shared/appearance';
import type { AppearanceColorOverrides, AppearanceSettings, ThemeDefinition } from '../shared/types';

let systemMql: MediaQueryList | null = null;
let systemListener: ((e: MediaQueryListEvent) => void) | null = null;

/**
 * 主题/外观变更事件：配色是写进 CSS 变量的，组件里那些“渲染时就定色”的东西
 * （mermaid 图）必须在事件后重渲染，否则换主题只会影响新画的图。
 */
export const THEME_CHANGE_EVENT = 'sage:theme-change';

function notifyThemeChange(): void {
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

function setAttr(t: 'light' | 'dark') {
  if (document.documentElement.dataset.theme === t) return;
  document.documentElement.dataset.theme = t;
  notifyThemeChange();
}

/**
 * 解析当前生效主题：自定义主题 id / 内置扩展主题（如养眼绿，叠加 builtinOverrides 微调层）→ { mode: base, custom }；
 * 'light'/'dark' → 自身；其余（含 'system'/缺省）→ 跟随系统偏好。
 */
export function resolveActiveTheme(
  theme: string | undefined,
  themes: ThemeDefinition[] | undefined,
  builtinOverrides?: Record<string, AppearanceColorOverrides>,
): { mode: 'light' | 'dark'; custom?: ThemeDefinition } {
  const t = theme ?? 'system';
  const user = themes?.find((d) => d.id === t);
  if (user) return { mode: user.base, custom: user };
  const builtin = findBuiltinTheme(t);
  if (builtin) {
    const overrides = builtinOverrides?.[builtin.id];
    return { mode: builtin.base, custom: overrides ? { ...builtin, colors: { ...builtin.colors, ...overrides } } : builtin };
  }
  if (t === 'light' || t === 'dark') return { mode: t };
  return { mode: window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' };
}

/**
 * Apply the chosen theme to <html data-theme="...">.
 *
 * theme 可以是 'light' | 'dark' | 'system' 或自定义主题 id（此时套用其 base 调色板）。
 *
 * For 'system', subscribes to `prefers-color-scheme` and reapplies live
 * when macOS appearance changes. Clears any previous system listener on
 * each call so switching back to a fixed theme doesn't leak handlers.
 */
export function applyTheme(theme: Theme | string, themes?: ThemeDefinition[]): void {
  if (systemMql && systemListener) {
    systemMql.removeEventListener('change', systemListener);
    systemListener = null;
    systemMql = null;
  }
  const custom = themes?.find((d) => d.id === theme) ?? findBuiltinTheme(theme);
  if (custom) {
    setAttr(custom.base);
    return;
  }
  if (theme === 'light' || theme === 'dark') {
    setAttr(theme);
  } else {
    systemMql = window.matchMedia('(prefers-color-scheme: dark)');
    setAttr(systemMql.matches ? 'dark' : 'light');
    systemListener = (e) => setAttr(e.matches ? 'dark' : 'light');
    systemMql.addEventListener('change', systemListener);
  }
}

let appearanceStyleEl: HTMLStyleElement | null = null;

/** 由覆盖表生成一段 CSS 声明（含改主色时的 --accent-2/--accent-soft 自动派生）。 */
function buildColorDecls(overrides: AppearanceColorOverrides | undefined,tokens:AppearanceColorToken[]): string[] {
  if (!overrides) return [];
  const decls: string[] = [];
  for (const token of tokens) {
    const value = overrides[token.key];
    if (value && /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\))$/.test(value)) decls.push(`${token.varName}: ${value};`);
  }
  return decls;
}

/**
 * 应用外观自定义（主题色覆盖 / 界面字体 / 代码字号）。
 *
 * 颜色覆盖按浅/深两套注入独立 <style>（选择器与主样式同特异性但后加载，
 * 因此胜出）。注意：深色覆盖只能用 [data-theme="dark"] 而不能用 :root，
 * 否则会与浅色规则同特异性、靠后加载胜出，导致深色自定义泄漏到浅色模式。
 * custom（当前选中的自定义主题）排在内置覆盖之后注入，同特异性下胜出。
 * 改主色时自动派生 --accent-soft / --accent-2，除非高级区显式覆盖。
 * 界面字号的整窗缩放在主进程落地，这里不处理。
 */
export function applyAppearance(
  appearance: AppearanceSettings | undefined,
  custom?: ThemeDefinition,
  colorGroups: AppearanceColorGroup[] = [],
): void {
  const rules: string[] = [];
  const contributed=colorGroups.flatMap(group=>group.tokens);
  const tokens=[...APPEARANCE_COLOR_TOKENS,...contributed];
  for (const mode of ['light', 'dark'] as const) {
    const overrides = appearance?.colors?.[mode];
    const decls = [...contributed.map(token=>`${token.varName}: ${token.defaults[mode]};`),...buildColorDecls(overrides,tokens)];
    const accent = overrides?.accent;
    if (accent) {
      if (!overrides?.accent2) {
        const derived = deriveAccent2(accent);
        if (derived) decls.push(`--accent-2: ${derived};`);
      }
      const soft = deriveAccentSoft(accent, mode);
      if (soft) decls.push(`--accent-soft: ${soft};`);
    }
    if (decls.length > 0) rules.push(`[data-theme="${mode}"] { ${decls.join(' ')} }`);
  }
  if (custom && Object.keys(custom.colors ?? {}).length > 0) {
    const decls = buildColorDecls(custom.colors,tokens);
    const accent = custom.colors?.accent;
    if (accent) {
      if (!custom.colors.accent2) {
        const derived = deriveAccent2(accent);
        if (derived) decls.push(`--accent-2: ${derived};`);
      }
      const soft = deriveAccentSoft(accent, custom.base);
      if (soft) decls.push(`--accent-soft: ${soft};`);
    }
    if (decls.length > 0) rules.push(`[data-theme="${custom.base}"] { ${decls.join(' ')} }`);
  }
  if (!appearanceStyleEl) {
    appearanceStyleEl = document.createElement('style');
    appearanceStyleEl.id = 'sage-appearance-overrides';
    document.head.appendChild(appearanceStyleEl);
  }
  appearanceStyleEl.textContent = rules.join('\n');

  const rootStyle = document.documentElement.style;
  if (appearance?.uiFontFamily) rootStyle.setProperty('--font-ui', appearance.uiFontFamily);
  else rootStyle.removeProperty('--font-ui');
  if (appearance?.codeFontFamily) rootStyle.setProperty('--font-mono', `${JSON.stringify(appearance.codeFontFamily)}, monospace`);
  else rootStyle.removeProperty('--font-mono');
  if (appearance?.codeFontSize) rootStyle.setProperty('--fs-code', `${appearance.codeFontSize}px`);
  else rootStyle.removeProperty('--fs-code');
  // 覆盖值写进 <style> 后通知一遍：在等 CSS 变量生效前就取色的调用方（如 mermaid）要重渲染
  notifyThemeChange();
}
