# 插件扩展点清单与接入约定

本清单描述当前实现，不把规划中的能力当作已经支持。开发入口为
[插件手册](PLUGIN_MANUAL.md)、[API 参考](PLUGIN_API_REFERENCE.md)、
[场景示例](EXTENSION_COOKBOOK.md)、[引擎契约](BACKEND_ENGINES.md)。

## 四类扩展点

| 类别 | 清单字段 | 调用方向 | 返回值用途 |
| --- | --- | --- | --- |
| 流程钩子 hook | `hooks` | 宿主在指定流程节点调用插件自己的服务 | 拦截、加严审批、补充上下文 |
| 通知 event | `events` | 发布者通知启用且授权的订阅插件 | 返回值不参与业务决策 |
| 功能策略 | `extensions`、`extensionPoints` | 扩展点所有者选择处理器并调用 | 按 JSON Schema 验证并用于功能执行 |
| 界面贡献 | `contributes`、`colorGroups` | 宿主在约定位置渲染入口或设置 | 命令或隔离页面；不允许任意修改宿主 DOM |

hooks 和 events 都是插件扩展点，不是独立插件类别或用户配置页面。
旧全局 `hooks.json`、项目 `.sage/hooks.json` 以及旧 `hooksEnabled` 总开关已停用。
程序不读取、不运行其中命令，也不会删除用户旧文件。迁移时将逻辑实现为插件服务，
通过清单订阅；不会自动把旧 shell 命令转换为受信任代码。

## 流程钩子

必须声明并获授 `hooks.respond`，插件必须在当前项目启用。没有权限的订阅不调用。
处理器只能指向本插件 `services` 中已声明的方法，不是脚本路径、shell 命令或 URL。
安装前校验事件、重复 ID、服务方法和 matcher。执行顺序为 `order`、插件 ID、钩子 ID。
默认 `order=100`、`timeoutMs=5000`，最大超时 20000ms；失败记录错误并继续后续处理器。
超时不代表插件方法已停止执行，处理器必须短小、幂等，不能依赖失败来阻止主流程。

公共参数为 `{hook_event_name, session_id, cwd, ...事件参数}`，matcher 不改变这些参数。
matcher 省略或 `*` 匹配全部；其他值为正则，建议 `^Bash$` 而非未锚定子串。

| 事件 | 实际触发点 | 专属参数 / matcher | 宿主消费的结果 |
| --- | --- | --- | --- |
| `SessionStart` | 新对话首次执行；恢复对话不重复 | `source: startup`；无 subject | additionalContext |
| `UserPromptSubmit` | 用户消息写入执行上下文前 | `prompt`；无 subject | block/reason、additionalContext |
| `PreToolUse` | 工具审批和执行前 | `tool_name, tool_input`；工具名 | 当前消费 deny/ask，不消费 block/additionalContext；不能放宽安全策略 |
| `PostToolUse` | 已收到工具结果后，异步通知 | `tool_name, tool_input, tool_response, is_error`；工具名 | 后续上下文；不能撤销已执行工具 |
| `Stop` | 正常完成回答，非取消或失败 | `last_message, source: agent` | 拦截原因及补充内容进入待注入上下文 |
| `SubagentStart` | API 子任务执行前 | `agent_type`；角色名 | additionalContext；不阻止子任务启动 |
| `SubagentStop` | API 子任务正常结束 | `agent_type, response`；角色名 | 当前调用点只通知，不消费返回决策 |
| `PreCompact` | 手动压缩前；自动压缩通知路径中 | `trigger, reason`；manual/automatic | 当前调用点只通知，不消费返回决策 |
| `PostCompact` | 压缩结束通知 | `trigger, compacted_messages, after_estimated_tokens`；manual/automatic | 当前调用点只通知，不消费返回决策 |

自动压缩的 PreCompact/PostCompact 在引擎压缩事件到达后成对转发，不能视作自动压缩事务的前置拦截。
AskUser/只读 Skill 工具有宿主直接放行分支：deny 仍生效，但 ask 不会再增加审批。
定制压缩算法必须使用 `sage/context.compact`。工具/回答文本通知可能截断到 4000 字符。
第三方原生引擎内部不经过宿主工具桥接的操作，不保证收到工具和子任务钩子。

返回对象示例：

```json
{
  "additionalContext": "必须保留验收结果",
  "hookSpecificOutput": {
    "permissionDecision": "ask",
    "permissionDecisionReason": "需要用户确认"
  }
}
```

`{decision:"block",reason:"原因"}` 表示阻止支持拦截的动作。
合并规则为 deny > ask，allow 不生效；block 累积，context 按顺序换行拼接。
deny 会停止后续处理器，block 本身不停止处理器链。事件是否支持拦截以表中调用点为准。
安全检查应显式返回 deny/block，不能通过抛错实现。

清单片段（输入方法 schema 也需允许相应事件字段）：

```json
{
  "permissions": ["hooks.respond"],
  "services": {"guard": {"version": "1.0.0", "methods": {
    "check": {"description": "检查工具审批", "input": {"type": "object"}}
  }}},
  "hooks": [{"id":"confirm","event":"PreToolUse","matcher":"^Bash$",
    "service":"guard","method":"check","order":100,"timeoutMs":5000}]
}
```

## 通知事件

订阅需 `events.subscribe`；发布自有事件需 `events.publish`。
清单项 `{event,service,method,order}` 指向本插件方法，收到 `{event,payload}`。
按 order、插件 ID 顺序分发，共用约 5 秒期限；单个失败隔离，调用链防止循环重入。
没有持久队列、重放或至少一次送达保证。不要用通知事件实现强制审批。

| 事件 | 来源与边界 |
| --- | --- |
| `sage/workspace.opened` | 工作台项目切换，不是文件系统监视 |
| `sage/settings.changed` | 设置更新，载荷仅包含变更字段名，不提供密钥值 |
| `sage/git.committed` | 插件宿主 git.commit 成功；不覆盖外部 Git 进程提交 |
| `sage/browser.created` | 浏览器宿主创建句柄 |
| `sage/browser.navigated` | 插件 browser.navigate 成功；不保证覆盖所有网页内部导航 |
| `sage/browser.closed` | 插件 browser.close 成功 |
| `sage/engine.started` | 原生引擎通过注册表开始运行；不发送完整提示或密钥 |
| `sage/engine.finished` | 原生引擎结束，包括失败/取消状态；详情见引擎手册 |

发布 `sdk.host('events','emit',{event:'local.owner/validated',payload:{passed:true}})`，
只能使用自身插件 ID 命名空间；不得伪造 `sage/*` 或其他插件事件。
事件载荷由发布者定义，消费者应检查字段；自定义事件应在发布者手册中说明版本和兼容策略。

## 功能策略与二次扩展

| 扩展点 | 权限 | 输入 | 输出 / 限制 |
| --- | --- | --- | --- |
| `sage/context.compact@1.0.0` | context.transform | messages、maxBodyChars、trigger | summary、keepRecentTurns(1..50)；宿主保留系统与完整工具轮次并复核预算 |
| `sage/models.route@1.0.0` | models.use | requestedModel、task、candidates | providerId、modelId；必须选启用候选，不含凭据，不是协议适配器 |
| `manifest.engine` | engine.native | EngineAdapter API v1 | 原生 CLI 引擎；全局安装、授权和停用约束见引擎手册 |
| `owner/id` | 定义者与处理器调用链权限交集 | 定义者 input JSON Schema | 定义者 output JSON Schema；双方服务自身 schema 也生效 |

扩展点定义者声明 `extensionPoints:[{id,version,title,input,output}]`。
消费者声明 `dependencies:{"local.owner":"^1.0.0"}` 以及
`extensions:[{id,point:"local.owner/check",version:"^1.0.0",title,service,method,order}]`。
定义者调用 `extensions.list({point})` 获取已启用、版本兼容、授权的处理器 key，
再调用 `extensions.invoke({point,key,input})`；仅所有者有权主动分发。
输入输出校验失败会报错；扩展点所有者停用时不可调用。升级 schema 时应升级契约版本。

## 界面插槽全表

以下名字来自 `shared/plugins/extensions.ts`，统一使用 `manifest.contributes`：

| 模块 | slot |
| --- | --- |
| 标题栏 | titlebar.left、titlebar.right |
| 侧栏 | sidebar.middle、sidebar.bottom、sidebar.tabs |
| 工作区 | tab、panel、menu、editor.toolbar |
| 状态和工具栏 | status、toolbar |
| 对话 | conversation、conversation.input |
| 设置 | settings、settings.navigation、settings.models、settings.context、settings.appearance、settings.appearance.colors、settings.skills、settings.mcp |
| 内置插件 | git.toolbar、browser.toolbar |

贡献入口调用命令或打开插件沙箱页面，不等于任意 React 组件、DOM 覆盖或 CSS 注入。
`colorGroups` 用于外观页统一管理插件专属色板：安装并启用后注入，按插件 ID 隔离，
卸载/停用后不显示，不在外观页硬编码某插件开关。Git 同样使用这条链路。
各位置显示和可用性仍取决于宿主是否挂载对应视图及当前项目上下文。

## 服务、技能与模型边界

`services` 定义可复用服务；其他包用 dependencies 声明包依赖、consumes 声明服务版本，
经 SDK 调用，不能直接 require 其他包内部文件。工具服务另外声明 `tool:true`。
Git 的 status/diff/log/config/commit/branch/push 和浏览器句柄、DOM、截图、交互服务，
具体参数、权限、路径限制见 API 参考；不能跨项目借用句柄或绕过审批。

技能由 `manifest.skills` 指向 SKILL.md，是模型可加载的工作指引，不是界面插槽。
浏览器验收试验技能通过浏览器服务截图，再调用 models.analyzeImage；失败必须如实返回。
技能市场默认页面为中继连接地址 `/skills`；包 API 仍复用 `/market/api/plugins`，
确保技能依赖普通插件时可下载。自定义技能地址与插件市场地址分别保存。

任意模型协议适配器、签名信任基础设施、完整依赖回溯求解尚未由本次界面与 hooks 清理实现，
不能将模型路由、摘要 digest 校验、贪心依赖闭包分别当成这三项能力。

## 0.6.790 新增界面位置

- `conversation.header` / `conversation.actions`：服务动作参数 `{context:{conversationId}}`。
- `scheduled.task`：服务动作参数 `{context:{taskId}}`。
- `scheduled.toolbar`：任务页通用工具栏，参数 `{}`。
- `help.toolbar`：服务动作参数 `{context:{topicId}}`。

标识不包含正文，也不授予读取权限。view 入口不会自动传递这些字段。原插槽参数不变。
实际挂载与输入 schema 示例见 [二次开发手册](EXTENSION_COOKBOOK.md)。
