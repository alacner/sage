/**
 * 模型能力推断 + Logo 识别工具。
 * 用于模型选择器中显示每个模型的功能标签和 Logo。
 */

import { modelSupportsVision } from '../../shared/model-capabilities';

// 视觉能力判定下沉到 shared/model-capabilities（主进程回退链共用），此处 re-export 保持旧引用兼容。
export { modelSupportsVision };
export const isVisionCapable = modelSupportsVision;

/**
 * 推断模型能力（基于模型名称关键词）。
 */
export function inferModelCapabilities(modelId: string) {
  const id = modelId.toLowerCase();
  
  // Vision 能力
  const vision = modelSupportsVision(id);
  
  // Reasoning 能力（推理/思维链模型）
  const reasoning = /o1|o3|reasoner|thinking|reasoning|deepseek-r|qwen.*reasoner|qwq|gemini.*thinking/.test(id);
  
  // Tool Use 能力（工具调用）
  const toolUse = /gpt-4|gpt-3\.5|claude|qwen|deepseek|glm|kimi|gemini|yi-|llama/.test(id);
  
  // Web Search 能力（联网搜索）
  const webSearch = /online|search|web|gemini.*search|gpt.*search/.test(id);
  
  // Free 能力（免费模型）
  const free = /free|flash|lite|mini|nano|turbo/.test(id) && !/pro|plus|max|ultra/.test(id);
  
  return { vision, reasoning, toolUse, webSearch, free };
}

/**
 * 获取模型的 Logo 颜色（基于模型名识别提供商）。
 * 返回 CSS 颜色值。
 */
export function getModelLogoColor(modelId: string): string {
  const id = modelId.toLowerCase();
  
  // 通义千问 (Qwen) - 紫色
  if (/qwen/.test(id)) return '#8B5CF6';
  
  // DeepSeek - 蓝色
  if (/deepseek/.test(id)) return '#3B82F6';
  
  // 智谱 GLM - 蓝色
  if (/glm/.test(id)) return '#06B6D4';
  
  // Moonshot Kimi - 黑色
  if (/kimi/.test(id)) return '#1F2937';
  
  // OpenAI GPT - 绿色
  if (/gpt|openai/.test(id)) return '#10B981';
  
  // Anthropic Claude - 橙色
  if (/claude|anthropic/.test(id)) return '#F59E0B';
  
  // Google Gemini - 蓝色
  if (/gemini/.test(id)) return '#4285F4';
  
  // Meta Llama - 紫色
  if (/llama/.test(id)) return '#A855F7';
  
  // 01.AI Yi - 蓝色
  if (/yi-/.test(id)) return '#0EA5E9';
  
  // 默认 - 灰色
  return '#6B7280';
}

/**
 * 获取模型 Logo 的首字母（用于显示在圆形图标中）。
 */
export function getModelLogoLetter(modelId: string): string {
  const id = modelId.toLowerCase();
  
  if (/qwen/.test(id)) return 'Q';
  if (/deepseek/.test(id)) return 'D';
  if (/glm/.test(id)) return 'G';
  if (/kimi/.test(id)) return 'K';
  if (/gpt|openai/.test(id)) return 'O';
  if (/claude|anthropic/.test(id)) return 'C';
  if (/gemini/.test(id)) return 'G';
  if (/llama/.test(id)) return 'L';
  if (/yi-/.test(id)) return 'Y';
  
  // 默认取第一个字母
  return modelId.charAt(0).toUpperCase();
}
