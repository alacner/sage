/** AI 翻译浮窗共享逻辑：提示词模板、模型调用与输出解析。
 *  文件内与对话内右键「AI 翻译」共用，保证两处体验与输出结构一致。 */

export interface AiTranslationItem {
  lang: string;
  text: string;
}

export interface AiTranslationResult {
  /** 模型自动识别的源语言名（如 Chinese / English / Japanese） */
  detected?: string;
  items: AiTranslationItem[];
}

/**
 * 解析翻译模型输出：优先按 JSON 提取（容忍代码块包裹与前后杂散文本）；
 * 解析失败返回空列表，调用方把原文整体回落为单条译文展示。
 */
export function parseTranslation(raw: string): AiTranslationResult {
  const cleaned = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(cleaned.slice(start, end + 1));
      const items = Array.isArray(obj?.translations)
        ? obj.translations
          .filter((t: any) => t && typeof t.text === 'string' && t.text.trim())
          .map((t: any) => ({ lang: String(t.lang ?? '译文'), text: String(t.text) }))
        : [];
      return { detected: typeof obj?.detected === 'string' && obj.detected ? obj.detected : undefined, items };
    } catch { /* 非 JSON：回落为纯文本单条 */ }
  }
  return { items: [] };
}

/** 调用模型做多语言翻译：自动识别源语言、跳过与源语言相同的目标语言；
 *  返回译文列表为空时把模型原始输出回落为单条译文。 */
export async function requestAiTranslation(text: string, projectPath?: string): Promise<AiTranslationResult> {
  const prompt = [
    '你是专业翻译引擎。先自动识别用户文本的语言，再翻译为以下目标语言：简体中文、English、日本語。',
    '规则：',
    '- 与识别出的源语言相同的目标语言跳过；',
    '- 代码、标识符、占位符与格式保持原样；',
    '- 只输出 JSON，不要代码块与解释，格式：',
    '{"detected":"<源语言名，如 Chinese / English / Japanese / French>","translations":[{"lang":"<目标语言名，如 简体中文 / English / 日本語>","text":"<译文>"}]}',
    '',
    '原文：',
    '"""',
    text,
    '"""',
  ].join('\n');
  const raw = String(await window.api.llmComplete({ prompt, projectPath }));
  const parsed = parseTranslation(raw);
  const items = parsed.items.length ? parsed.items : [{ lang: parsed.detected ?? '译文', text: raw.trim() }];
  return { detected: parsed.detected, items };
}
