# 非内置后端引擎开发手册

适用：Sage 0.6.812；Engine API v1 / SDK 1.5。本文描述已接通的接口，不是未来功能清单。

## 目录与分发

- API 直连仍为内置后端；Claude、Codex 与 Qoder 都是可选的原生插件，不随 DMG 分发，不自动安装。
- `resources/plugins-external/sage.engine-claude/`、`sage.engine-codex/`、`sage.engine-qoder/` 是各自完整工程。
- `src/` 保存 TypeScript 实现；`sage.plugin.json` 是手工维护的清单；`plugin.js` 是普通插件入口；`engine.js` 是生成的 CommonJS 引擎入口。
- `npm run build:engines` 单独编译三种外部引擎；应用 `npm run build` 不依赖它们，也不会覆盖插件清单。
- `resources/plugin-sdk/sage-engine.d.ts` 是唯一公共类型定义，`shared/engine.ts` 转出同一契约。新建 CLI 引擎工程会复制该类型文件。

开发：先编译，再在全局插件页加载包根目录，在测试项目中调试；编辑 `src/` 后需重新编译。发布：在插件开发菜单导出含依赖的包，或明确操作“提交到插件市场”。不会因编译而自动发布。

安装：通过通用离线安装或插件市场安装，审阅 `engine.native` 权限，**全局启用**，再在通用设置选择后端。引擎插件与 CLI 可执行文件分开安装；安装插件不代表已安装或登录 CLI。

保留 `sage.engine-claude` / `sage.engine-codex` ID，因此已安装包、配置与已保存会话不需要改名。迁移源码不会自动升级用户已安装的包；更新至 Claude 1.0.5 / Codex 1.0.5 / Qoder 1.0.1 需重新安装/市场升级。此前 DMG 附带但未安装的引擎现在不再提供专用按钮。

## 清单插槽

以下为清单字段片段，完整工程可从“创建 CLI 引擎插件”生成：

```json
{
  "id": "local.my-engine",
  "category": "engine",
  "scope": "global",
  "engine": {"apiVersion": 1, "entry": "engine.js"},
  "permissions": ["engine.native"],
  "settings": {
    "binaryPath": {"title": "CLI path", "type": "string", "scope": "global", "default": ""}
  }
}
```

宿主从已安装、已启用的引擎清单生成后端选项，不按 Claude/Codex 名字分支。配置从清单生成设置项，`run` / `detect` 接收已解析的该插件配置。新增引擎不需要向宿主添加枚举。

## 状态栏图标与入口

API 直连显示单色鼠尾草图标；CLI 引擎优先使用清单顶层 `icon`。图标只包含固定 24×24 坐标的 SVG 路径，颜色、尺寸和线条由宿主统一控制，填充图形使用 even-odd 规则，格式见[插件手册](PLUGIN_MANUAL.md#41-插件自带单色图标sdk-15)。

Claude、Codex、Qoder 的新包携带各自的徽标；宿主为已安装的旧包保留同样的兼容图标，其他未声明图标的插件显示终端图标。插件清单里的图标优先，因此第三方引擎可以自行提供图形，无需修改宿主代码。

状态栏引擎图标打开「通用」，中继图标打开「中继连接」，心电图图标打开监控器。悬停时显示具体引擎和状态；未启用的 CLI 引擎图标降低透明度，仍能点击进入通用设置。

徽标来源：[Claude Code 官方文档标志](https://mintcdn.com/claude-code/c5r9_6tjPMzFdDDT/logo/light.svg)、[OpenAI 官方静态图标](https://cdn.oaistatic.com/assets/favicon-o20kmmos.svg)、[Qoder 官方图标](https://qoder.com/favIcon.svg)。提取品牌图形并归一化为 24×24，不保留背景或字标；Qoder 路径以约 0.02 坐标误差简化，保证小尺寸清晰和清单大小受限。官方插件清单与宿主兼容图形应同步维护。

## Engine API v1

`engine.js` 必须导出 `apiVersion = 1` 和异步 `run(options, settings)`；`detect(settings)` 可选。引擎运行入口、检测入口均检查包启用状态与原生授权，并在读取配置后复核包摘要。

| 接口 | 输入 / 输出与责任 |
| --- | --- |
| `detect` | 返回 `{available, path?, version?, error?}`；探测 CLI，不开始对话或自动授权；适配器必须给外部探测命令设置超时 |
| `run` | 接收 cwd、prompt、history、images、resume、readOnly、model、binaryPath、signal、monitor 和回调；返回 `{text, sessionId?, error?, usage?}` |
| `onText(chunk)` | 流式文本增量，不重复发送已有全文；最终 `text` 仍须完整 |
| `onSessionId(id)` | CLI 会话建立/恢复时报告，最终结果也可带 sessionId |
| `canUseTool(name,input,context)` | 执行工具前等待宿主审批；context 包含 toolUseID、signal、suggestions；拒绝或缺少审批入口时不能偷偷执行 |
| `askUser(input)` | 向宿主发起需要用户回答的问题；适配器把 CLI 的问题协议转换成宿主协议 |
| `onToolUse` / `onToolResult` | 用同一个工具 ID 关联开始与结果；这是观测回调，不是授权 |
| `signal` | 监听用户取消与插件停用/更新失效；结束子进程、RPC 和监听器，在 finally 清理 |

`usage` 字段见 SDK：inputTokens、outputTokens、cacheReadTokens、cacheCreationTokens、costUsd。未获得真实用量时不要编造。`error` 为可显示的失败说明，取消统一返回 `aborted`。宿主校验结果至少有字符串 `text`。

`history` 与 `resume` 不能重复注入：已有 CLI 会话恢复时应避免再发送全部历史。尊重 readOnly，不允许通过 CLI 自带工具绕过 Sage。原生代码可忽略信号，因此取消是适配器必须遵守的契约，不是强制进程隔离保证。

## Hooks 与事件

普通会话入口已有 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`。引擎经宿主的审批与工具回调参与这些链路，不能在适配器内再次触发相同 hook。Spec 等其他执行入口不等同于完整会话 hook 链，不能假定每个 run 都触发全部会话 hooks。压缩 hooks 属于压缩流程，不因 CLI 内部整理上下文而自动产生。

新增的跨引擎观测事件在 `electron/engine-registry.ts` 实际派发：

| 事件 | payload |
| --- | --- |
| `sage/engine.started` | `{apiVersion:1, runId, engineId, startedAt}` |
| `sage/engine.finished` | `{apiVersion:1, runId, engineId, status, durationMs}`；status 为 success / error / aborted |

通过清单 `events` 声明订阅，申请 `events.subscribe`，服务方法收到 `{event,payload}`。同一次运行 start/finish 顺序保持；不同运行可交错。只在进入合法适配器 run 时发 start，已开始的 run 在成功、报错或取消后发 finish；未安装、未授权、入口无效的启动拒绝不产生运行事件。

事件异步派发，不延迟模型执行；订阅失败不改变执行结果。事件不含 prompt、输出、工具输入、配置或密钥。它们不具有阻断/批准语义，不能替代 `canUseTool`。订阅者若在运行中停用，结束时可能收不到通知，不能将它当作持久化任务队列。

其他引擎特有扩展点可通过包的 `extensionPoints` 与 `events` 机制暴露；消费者声明包依赖与版本范围。Engine API 不额外提供一个可绕过权限的跨插件调用通道。

## 宿主桥与限制

官方适配器显式导入以下 `@sage/engine-host/` 模块，由注册器解析，不再用构建器猜测相对路径：

| 模块 | 用途 |
| --- | --- |
| `api-tool-defs` | getToolDefinitions；Claude 的提问输入归一化与重试提示 |
| `api-tool-executor` | executeTool：共用 Sage 工具实现及安全检查 |
| `sandbox/env` | buildSandboxEnv：构造子进程环境 |
| `skills` | buildSkillIndex / readSkill：读取启用技能 |
| `request-monitor` | beginRecord：记录、完成、失败的请求监控 |

从 Sage 0.6.524 开始，原生引擎通过此桥调用 beginRecord 时，宿主自动附加真实 engineId 与 engineName，随监控记录广播和持久化。监控模式会展示具体引擎，旧记录缺少来源时显示未知，不根据当前后端反推。

这些桥当前传递宿主模块的实现，不是独立 npm 包；具体参数参考对应 `electron/` 源码和适配器调用。第三方优先采用 SDK Engine API 回调；需要使用桥时应针对目标 Sage 版本回归，不能假定每个内部导出都稳定。未知桥模块会报错。

原生入口是信任边界：它在主进程具有 Node 权限，不是普通插件沙箱。依赖应尽量打进单个 engine.js；未打包的 Node 依赖必须在宿主可解析。目前 Claude、Qoder 适配器依赖宿主提供的各自官方 Agent SDK；本轮没有声称它已成为完全独立的 npm 分发物。

## 验收

运行 `npm run test:engines`：验证第三方引擎无宿主改动接入、权限与全局启用、设置、流式文本、会话、用户取消、停用取消、卸载拒绝、生命周期状态，以及 Claude/Codex/Qoder 工具审批、会话恢复、取消隔离与协议。测试还断言应用构建和 DMG 资源列表不包含外部引擎。

真实 CLI 联调需单独完成安装和账号登录，检查普通对话、续聊、图片、拒绝工具、子进程退出、超时及取消。本地模拟协议测试不代表已联网调用所有 CLI 版本。

具体使用：[Qoder CLI](QODER_CLI.md)、[Codex CLI](CODEX_CLI.md)、[内置与随包依赖检查](BUILTIN_DEPENDENCIES.md)。
