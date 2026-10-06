import {BoundedCache} from '../../shared/bounded-cache';
/**
 * 主题瓷砖预览色解析（0.6.429）：
 * - base    = 该配色的「卡片」色（bg1），瓷砖底色；
 * - surface = 该配色的「背景」色（bg0），瓷砖顶栏/内容条颜色；
 * - text    = 该配色的「前景」色（text），瓷砖内「字体」样张文字颜色；
 * - border  = 该配色的「边框」色，瓷砖外框颜色。
 * 解析结果按 (mode + overrides) 缓存：颜色不变直接命中缓存，不重复计算。
 */
import { APPEARANCE_COLOR_TOKENS } from '../../shared/appearance';
import type { AppearanceColorOverrides } from '../../shared/types';

export interface ThemeThumbColors {
  base: string;
  surface: string;
  text: string;
  border: string;
}

const DEFAULTS = Object.fromEntries(
  APPEARANCE_COLOR_TOKENS.map((token) => [token.key, token.defaults]),
) as Record<string, { light: string; dark: string }>;

const cache = new BoundedCache<string, ThemeThumbColors>(64);
const CACHE_LIMIT = 64;

export function resolveThemeThumb(
  mode: 'light' | 'dark',
  overrides?: AppearanceColorOverrides,
): ThemeThumbColors {
  const key = `${mode}:${overrides ? JSON.stringify(overrides) : ''}`;
  let thumb = cache.get(key);
  if (!thumb) {
    thumb = {
      base: overrides?.bg1 ?? DEFAULTS.bg1[mode],
      surface: overrides?.bg0 ?? DEFAULTS.bg0[mode],
      text: overrides?.text ?? DEFAULTS.text[mode],
      border: overrides?.border ?? DEFAULTS.border[mode],
    };
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, thumb);
  }
  return thumb;
}
