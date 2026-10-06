/**
 * 插件钩子桥接：把 manifest.hooks 声明的“事件 → 服务方法”订阅暴露给 Hooks 执行器与
 * 设置页（设置 → 插件 → 插件包 → 钩子插槽）。钩子是插件体系的一类扩展点，与 skills 贡献同构：
 * 清单声明、宿主按项目启用状态列出、事件发生时由宿主调用，插件永远拿不到本机命令通道。
 *
 * 安全边界（与 engine.native 同一思路）：
 *  - 必须显式声明并获授予 hooks.respond 权限，否则订阅被列入面板但不执行；
 *  - 只能指向该插件自己已声明的 service/method，走 manager.call() 的启用/依赖/schema
 *    校验与审计，不能借钩子调用别人的内部函数；
 *  - 钩子跑在对话关键路径上，每次调用都有独立的 timeoutMs（上限 20s），超时/抛错只
 *    记进决策 errors，绝不阻断主流程。
 */
import type { PluginManager } from './manager';
import { HOOK_PERMISSION } from '../../shared/plugins/contract';
import { localizePluginManifest } from '../../shared/plugins/i18n';
import { matchesHookMatcher, parseHookDecision, type HookDecision, type HookEvent, type PluginHookTarget } from '../../shared/hooks';

// 视图模型定义在 shared/hooks.ts（设置页与执行器共用），桥接层直接透传出去。
export type { PluginHookTarget };

/** 已安装且项目内启用的插件钩子订阅，按执行顺序排列（order → 插件 → 钩子）。 */
export function listPluginHooks(manager: PluginManager, project: string, locale?: string): PluginHookTarget[] {
  const out: PluginHookTarget[] = [];
  for (const package_ of manager.packages(project).values()) {
    if (!package_.manifest.hooks.length || !manager.enabled(project).has(package_.manifest.id)) continue;
    // 名称与钩子标题都可以走清单 i18n（%key%）；缺 locale 时保持原文。
    const manifest = locale ? localizePluginManifest(package_.manifest, locale) : package_.manifest;
    const granted = manager.grantedPermissions(project, manifest.id).includes(HOOK_PERMISSION);
    for (const hook of manifest.hooks) {
      out.push({
        plugin: manifest.id, pluginName: manifest.name, id: hook.id, event: hook.event,
        ...(hook.title ? { title: hook.title } : {}), ...(hook.matcher ? { matcher: hook.matcher } : {}),
        service: hook.service, method: hook.method, order: hook.order, timeoutMs: hook.timeoutMs, granted,
      });
    }
  }
  return out.sort((a, b) => a.order - b.order || a.plugin.localeCompare(b.plugin) || a.id.localeCompare(b.id));
}

/** 某个事件当前应触发的插件钩子（matcher 语义与 hooks.json 共用 matchesHookMatcher）。 */
export function matchPluginHooks(targets: PluginHookTarget[], event: HookEvent, subject?: string): PluginHookTarget[] {
  return targets.filter((t) => t.event === event && matchesHookMatcher(t.matcher, subject));
}

/**
 * 调用单个插件钩子，返回已经过统一决策解释的片段。抛错交由调用方（hooks-runner）隔离，
 * 因此这里只负责“要么拿到决策、要么失败”，不做顺序与合并。
 */
export async function callPluginHook(
  manager: PluginManager,
  project: string,
  target: PluginHookTarget,
  payload: Record<string, unknown>,
): Promise<Partial<HookDecision>> {
  if (!target.granted) throw new Error(`missing ${HOOK_PERMISSION} permission`);
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      manager.call(project, { plugin: target.plugin, service: target.service, method: target.method, args: payload }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`hook timed out after ${target.timeoutMs}ms`)), target.timeoutMs); }),
    ]);
    return parseHookDecision(value);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
