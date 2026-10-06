/** Plugin hooks only. Legacy hooks.json files are never read or executed. */
import { type HookDecision, type HookEvent, type HookTextLang, emptyHookDecision, mergeHookDecisions } from '../shared/hooks';
import { resolveLanguage } from '../shared/language';
let lastTextLang: HookTextLang = 'zh';
export function hookLangOf(language?: string): HookTextLang { return resolveLanguage(language) === 'en' ? 'en' : 'zh'; }
export function hookTextLang(): HookTextLang { return lastTextLang; }
/** Plugin enablement and hooks.respond replace the obsolete file-hook switch. */
export async function hooksEnabled(): Promise<boolean> {
  try { const { readSettings } = await import('./main'); lastTextLang = hookLangOf((await readSettings()).language); }
  catch { /* Keep the last known language. */ }
  return true;
}
export async function runHooks(
  event: HookEvent,
  ctx: { projectPath: string; convId?: string; enabled: boolean; subject?: string; payloadExtra?: Record<string, unknown> },
): Promise<HookDecision> {
  const acc = emptyHookDecision();
  if (!ctx.enabled || !ctx.projectPath) return acc;
  let bridge;
  try {
    const [{ pluginManager }, api] = await Promise.all([import('./plugins'), import('./plugins/hooks')]);
    bridge = { manager: pluginManager(), api };
  } catch { return acc; }
  const targets = bridge.api.matchPluginHooks(bridge.api.listPluginHooks(bridge.manager, ctx.projectPath, hookTextLang()), event, ctx.subject).filter(target => target.granted);
  const payload = { ...(ctx.payloadExtra ?? {}), hook_event_name: event, session_id: ctx.convId ?? '', cwd: ctx.projectPath };
  for (const target of targets) {
    try {
      mergeHookDecisions(acc, await bridge.api.callPluginHook(bridge.manager, ctx.projectPath, target, payload));
      acc.ran++;
    } catch (err) { acc.errors.push(`${event}<${target.plugin}#${target.id}>: ${String((err as Error).message ?? err)}`); }
    if (acc.permission === 'deny') break;
  }
  return acc;
}
