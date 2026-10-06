# Sage 扩展架构与接入手册（SDK 1.3）

## 项目分析

Sage 是 Electron 主进程、React 工作台与多种模型执行后端构成的桌面应用。
现有扩展基础包括隔离 BrowserWindow 插件运行时、JSON Schema 服务契约、逐跳权限检查、
依赖图、安装预览、原子注册表写入与历史恢复。Git/浏览器的 React 界面属于编译进宿主的模块；
第三方界面运行在无同源权限的 iframe 中。CLI 引擎属于显式授权的原生扩展。

本次补齐的是上述基础之间的接线：细粒度界面插槽、功能扩展注册表、事件分发、
双 API 路径压缩扩展、模型路由、在线依赖闭包、技能包生命周期和 MCP 官方客户端。
保持声明式贡献与受控宿主 API 两部分相配合，参考
[VS Code Contribution Points](https://code.visualstudio.com/api/references/contribution-points)
与 [Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)。
MCP 使用已锁定的官方 TypeScript SDK 1.29.0，由 SDK 协商协议和处理 STDIO/Streamable HTTP；
参见 [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。

## 模块清单

| 模块 | 界面插槽或接口 | 实际行为 |
| --- | --- | --- |
| 标题栏 | `titlebar.left`, `titlebar.right` | 贡献命令或打开插件页面 |
| 侧栏 | `sidebar.middle`, `sidebar.tabs`, `sidebar.bottom`, `menu` | 标签附近与底部扩展入口 |
| 工作区 | `tab`, `panel`, `editor.toolbar` | 标签、面板、文件工具栏入口 |
| 状态与对话 | `status`, `toolbar`, `conversation`, `conversation.input` | 状态与输入区命令 |
| 设置导航 | `settings`, `settings.navigation` | 插件页与设置导航入口 |
| 模型 | `settings.models`, `sage/models.route`, `models.list/generate/analyzeImage` | 提供商路由、受控模型调用和视觉分析 |
| 上下文 | `settings.context`, `sage/context.compact` | 全局/对话可选的自动及手动压缩策略 |
| 外观 | `settings.appearance`, `settings.appearance.colors` | 已安装插件通过 colorGroups 声明配色分组；Git 与第三方共用注册/渲染链路，颜色按插件隔离 |
| Git | `git.toolbar`, `git.status/diff/log/config/commit/branch/push` | 当前项目仓库操作，复用宿主审批和路径检查 |
| 浏览器 | `browser.toolbar`, `browser.*` | 页面句柄、DOM、截图、CDP、交互与当前项目集成标签页 |
| 引擎 | `manifest.engine`, EngineAdapter API v1 | 已有 Claude/Codex CLI 及第三方原生引擎 |
| 技能 | `settings.skills`, `manifest.skills`, `artifactType: skill` | 离线、在线、开发热重载、导出与市场提交 |
| MCP | `settings.mcp`, `mcp.servers/tools/call` | 已配置服务器的发现和调用，凭据留在宿主 |
| 工作流 | 现有 hooks、`tasks.*`, `conversations.*`, `channels.*` | 对话生命周期、定时任务、会话和渠道 |
| 插件二次扩展 | `extensionPoints`, `extensions`, `events` | 插件定义自己的契约并供依赖它的插件扩展 |

界面插槽只接收已有 `contributes` 结构，命令或沙箱页面由运行时管理。
它们不会将第三方 JavaScript 注入宿主 React 树。插件可在自己的页面放置表单、色板和完整工具界面。
这不是任意覆盖宿主 DOM 的接口。

## 功能契约

清单的 `extensions` 项包含 `id/point/version/title/service/method/order`。
处理器必须指向自己的已声明服务方法。`sdk.host('extensions','list',{point})`
返回当前生效处理器及稳定的 `publisher.plugin/handler` key。

`sage/context.compact@1.0.0` 请求包含 `messages/maxBodyChars/trigger?`，响应为
`{summary: string, keepRecentTurns: 1..50}`，须申请 `context.transform`。
宿主负责保留系统提示和近期完整轮次；Anthropic 的工具结果不作为新用户轮次边界。
自动压缩要求结果缩小上下文，之后继续执行宿主预算检查；手动压缩只存边界，原始历史不删除。
已选择扩展缺失、停用或输出无效时会报错，不会冒充执行了用户选定策略。
CLI 原生会话自身的内部上下文管理仍由引擎负责。

`sage/models.route@1.0.0` 请求包含 `requestedModel/task/candidates`，响应为
`{providerId,modelId}`，须申请 `models.use`。候选集只包含已启用的基础提供商及模型 ID，
不含密钥；宿主验证选择后解析凭据。路由提供商出现在普通模型选择器中，默认模型 ID 为 `auto`。
插件可调用 `models.generate` 让规划模型为当前任务选择模型；规划必须显式指定基础提供商与模型。
新的自定义网络协议应实现原生引擎适配器；路由契约本身不接收任意网络请求或凭据。

插件声明 `extensionPoints:[{id,version,title,input,output}]` 后，其他插件声明
对该插件的 `dependencies` 和 `extensions`。只有定义者可以通过
`extensions.invoke({point,key,input})` 调用处理器，输入输出均按定义校验。
反向扩展调用保留完整调用链，因此处理器调用宿主 API 时，定义者及处理器均须具备对应权限。
安装时检查版本兼容、未知方法、循环依赖和声明缺失。

## 事件与 hooks

当前完整清单、参数、实际触发边界和迁移方式见 [扩展点清单](PLUGIN_EXTENSION_CATALOG.md)。
旧 hooks.json 命令执行及独立设置页已移除；插件钩子由启用状态和 hooks.respond 授权控制。

对话 hooks 保留现有 SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Stop、
SubagentStart、SubagentStop、PreCompact、PostCompact 及决策合并语义。
新 `events` 是通知接口，不用于替代会影响执行决策的 hooks。

宿主事件：`sage/workspace.opened`、`sage/settings.changed`、`sage/git.committed`、
`sage/browser.created`、`sage/browser.navigated`、`sage/browser.closed`。
工作区事件由工作台项目切换触发，设置事件只发送变更字段名；Git/浏览器事件由相应插件宿主 API 成功操作触发。
不对外部进程修改仓库或所有网页内部导航承诺文件监视级通知。
订阅用 `events:[{event,service,method,order}]`，须申请 `events.subscribe`。
发布用 `events.emit({event:'自身插件ID/名称',payload})`，须申请 `events.publish`。
处理器收到 `{event,payload}`；按 order、插件 ID 排序，限制总期限并隔离失败；调用链阻止循环重入。

## 安装与目录

`resources/plugins` 保存随应用提供的插件包；
`resources/plugins-external` 保存非内置插件源码，不自动扫描激活，也不把其中外置插件打进 DMG；
`resources/plugin-sdk` 提供独立开发类型，包括 `sage-engine.d.ts`。Claude/Codex 工程统一放在
`resources/plugins-external/sage.engine-*`，单独构建，不随 DMG 分发。接入契约见 [后端引擎手册](BACKEND_ENGINES.md)。

在线安装先解析依赖闭包：复用兼容的已安装版本，下载缺失/不兼容依赖，校验实际包身份，
一次预览所有权限和依赖后提交。冲突与循环会中止计划，没有部分安装。
离线导出包含依赖，因此无需网络；只包含根包而缺少依赖的离线文件会明确失败。
启用仍遵循既有依赖和全局/项目规则，不能绕过用户明确停用的依赖。

设置 > 技能支持 `.sageplugin` 技能包和单个 `.md` 导入，普通技能目录继续兼容。
技能页与插件包页共用同一工作台组件：安装、开发与调试、已安装列表及维护诊断保持相同布局；
共享市场地址、搜索/分类/状态筛选、安装权限预览、导出和开发发布菜单。
项目技能复用项目插件的继承全局/启停控制，不再使用另一套独立开关。
网站 `/skills` 提供技能发现、详情与正文预览、历史版本下载和 Token 发布入口，管理员可下架。
开发工程由清单、`plugin.js` 和 `skills/SKILL.md` 组成；无执行逻辑的纯技能使用空服务入口。
技能包使用相同的注册表、权限预览、热重载、含依赖导出及市场发布流程。
市场列表按 `artifactType/skillCount` 区分技能。市场服务端代码已同步，但客户端升级不自动部署服务器。

## 浏览器验收实例

通过技能市场或离线技能包安装外置浏览器验收技能；它调用 Browser 宿主 API，但自身不属于内置插件。
模型通过 Skill 工具加载 `browser-acceptance`，再调用 Plugin 工具的 `acceptance` 服务：
`tabs` 列出项目内置标签页，`open` 接收 URL/视口或 tabId，`inspect` 返回真实 PNG 与 DOM，
`verify` 对照验收条件调用视觉模型，`close` 清理句柄。

`browser.tabs/attach` 需要额外 `browser.tabs` 权限；只能接入由受信任工作台登记的当前项目 webview。
自动创建的窗口关闭时销毁，接入的用户标签页只释放句柄。隐藏窗口关闭后台节流，截图检查非空。
截图尺寸为物理像素，DOM 视口是 CSS 像素；Retina 下二者可以为 2:1。

外置验收包 `sage.browser-acceptance` 暴露 `assertions@1.0.0`，其他插件可返回
`{passed:boolean,detail:string}` 追加验收条件。最终通过需要视觉判断通过、无横向溢出且所有断言通过。
未配置视觉模型、截图失败、非结构化视觉结果均不能报告通过。页面内容只当作待检查数据。

`resources/plugins-external/local.extension-lab` 是压缩及动态选模源码示例。
未配置规划模型时使用确定性摘要和首个候选；配置后才使用 AI 规划。它不会自动安装。

## 验证与边界

新增测试覆盖扩展所有者权限、调用链、停用、事件、依赖闭包及冲突、技能打包、
完整工具轮次、MCP 配置导入脱敏、真实 STDIO 握手/分页/并发连接。
Electron 测试使用隔离目录，验证 1280x800 与 390x844 的真实截图及集成 webview 句柄。
视觉服务在该测试中是显式测试替身，不能替代真实模型的验收。

本次未实现 MCP OAuth 登录 UI、独立 MCP 市场、任意模型协议沙箱适配器、任意 React 组件注入、
插件签名信任基础设施或完整依赖版本回溯求解；版本冲突给出错误，避免默默替换不兼容包。
现有稳定的 EngineAdapter、服务和功能扩展点允许这些能力后续按契约增加。
