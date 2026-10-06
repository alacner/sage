# Sage 场景化二次开发手册

适用：Sage 0.6.790、SDK 1.4.0、插件包格式 1。面向开发者与辅助开发的大模型。
本手册逐项对应需求中的案例；未实现的能力会明确标注，不能把设计建议当成可调用 API。
接口目录见 [扩展架构](EXTENSIBILITY.md)，完整基础流程见 [插件开发手册](PLUGIN_MANUAL.md)。

## 1. 先理解扩展边界

Sage 的核心是 Electron 宿主、React 工作台、模型执行链与插件运行时。扩展分为四类：

| 类型 | 用途 | 声明位置 | 执行位置 |
| --- | --- | --- | --- |
| UI 插槽 | 入口、标签页、工具栏、插件页面 | `contributes` | 宿主入口 + 沙箱 iframe |
| 声明式配色插槽 | 在统一外观页添加插件自己的取色器 | `colorGroups` | 宿主通用编辑器，插件消费颜色 |
| 功能插槽 | 替换压缩、路由等可选择的算法，或扩展其他插件 | `extensions` / `extensionPoints` | 隔离插件服务，经宿主校验 |
| hooks / 事件 | 生命周期决策 / 事后通知 | `hooks` / `events` | 权限检查、限时调用、审计 |

这里的“高度可扩展”不是允许插件任意修改宿主 DOM、读取密钥或执行本机代码。
普通插件只能调用已授权的服务；需要原生 CLI 的引擎必须单独申请 `engine.native`。
一个插件可以同时包含 UI、技能、配色、hooks 和功能处理器，不必拆成多个重复安装包。

Sage 内置宿主能力只有 Git 与 Browser。`sage.delivery-loop`、`sage.temp-image-upload`、`sage.page-report`、`sage.snippets` 和 `sage.mfa` 都是外置插件，源码在 `resources/plugins-external/`，需独立安装。插件需要宿主功能时，应声明依赖与权限，通过插件 SDK 的 host service 或受控扩展点调用。

项目内有三个不同概念：安装包已存在、全局启用、当前项目有效启用。
配色属于安装后的声明式元数据，停用项目功能不删除配色设置；功能处理器则必须有效启用并获授权。

## 2. 目录与最短开发路径

| 目录 | 职责 |
| --- | --- |
| `resources/plugins` | 随 Sage 分发的插件包源码 |
| `resources/plugins-external` | 非内置插件源码与外部开发工程；不会自动安装或打进 DMG |
| `resources/plugin-sdk` | 独立开发用的 `sage-sdk.d.ts` |
| `resources/plugins-external/sage.engine-*` | 非内置 CLI 引擎；src 为源码，engine.js 为单独构建产物，不随 DMG 分发 |
| `shared/builtin-plugins.ts` | 编译进宿主的 Git/Browser 等内置模块注册表 |

Git/Browser 目前是编译进宿主的高频模块，不是放入目录就能替换 React 实现的第三方插件。
`resources/plugins/sage.browser` 是调用内置 Browser 能力的包，不等于底层浏览器宿主本身。
扩展它们应优先调用宿主 API、增加插槽贡献，不直接修改其内部组件。

1. 在设置 → 插件 → 插件包/技能 → 开发与调试中创建工程。
2. 在测试项目加载开发目录，修改清单和 `plugin.js`；通过热重载及调试器检查。
3. 查看安装预览：版本、依赖、权限及校验摘要；再授权安装。
4. 先启用依赖，再启用插件；项目默认继承全局，也可单独覆盖。
5. 在“更多”导出含依赖的 `.sageplugin`，到干净项目验证离线安装。
6. 使用开发菜单提交到市场。每个发布版本不可覆盖，修复后递增插件自身版本。

最小包由 `sage.plugin.json` 和 `plugin.js` 组成。服务入口使用
`globalThis.sagePlugin = {services:{...}}`，不是 `SagePlugin.register()`。
不要把运行时密钥写进清单、页面、README、导出包或市场提交记录。

## 3. 场景一：Git 配色由插件注入，统一管理

### 目标与实际实现

配色界面不包含 `gitEnabled` 开关或 Git 专属渲染分支。
Git 自己在 `shared/plugins/git-colors.ts` 定义分组与 27 个 token，
通过内置模块注册表的 `colorGroups` 注册。通用注册器收集已安装插件声明，
`ThemeColorEditor` 只渲染收到的分组。

第三方使用下面的清单字段注册到同一个 `settings.appearance.colors` 插槽：

```json
{
  "colorGroups": [{
    "id": "preview",
    "slot": "settings.appearance.colors",
    "title": "预览配色",
    "colors": [{
      "id": "highlight",
      "title": "高亮色",
      "defaults": {"light": "#087f72", "dark": "#62dbc5"}
    }]
  }]
}
```

这是清单字段片段，合并进完整清单，不是独立安装包。`title` 支持 `%key%` 国际化。
每包最多 20 组、每组 80 项；同包分组 ID 唯一、组内颜色 ID 唯一，默认色仅接受 HEX。
插件不能声明宿主变量名或任意 CSS，从而不能借配色贡献覆盖 `--accent` 等通用变量。

以 `local.extension-lab` 的 `preview/highlight` 为例：

```css
.sample {
  color: var(--sage-plugin-local_extension-lab__preview__highlight);
}
```

CSS 变量规则为 `--sage-plugin-<插件ID中的点替换为下划线>__<分组ID>__<颜色ID>`。
存储键为 `plugin:local.extension-lab:preview.highlight`。
宿主将**该插件自己的变量**同步给它的沙箱页面，页面不可通过这个桥接覆盖通用主题色。
Git 保留原 `gitFeat` 等存储键及 `--git-*` 变量，以兼容已有用户主题；它们只被 Git UI 消费。

浅色、深色、自定义主题、内置扩展主题微调均复用统一保存/重置流程。
卸载插件移除分组与其生效 CSS，但保留用户覆盖值以便重装恢复；停用插件不会抹掉配色。

### 可运行样例与验收

样例：`resources/plugins-external/local.extension-lab` 的清单与 `views/colors.html`。
安装后打开外观 → 主题色 → 高级，能同时看到 Git 和实验室分组。
改实验室高亮色只改变实验室页面；改 Git 提交色只改变 Git。
切换浅/深主题、重置、卸载再安装，检查隔离和恢复。
自动测试：`node scripts/test-plugin-colors.cjs`、`node scripts/test-appearance-git-colors.cjs`。

## 4. 场景二：左栏、标题栏、设置页等 UI 扩展

下列名字是实际支持的插槽，不能自行发明名字写进 `contributes.slot`：

| 区域 | 插槽 |
| --- | --- |
| 标题栏与工具入口 | `titlebar.left`, `titlebar.right`, `toolbar` |
| 侧栏与菜单 | `sidebar.middle`, `sidebar.bottom`, `sidebar.tabs`, `menu` |
| 工作区与编辑器 | `tab`, `panel`, `editor.toolbar` |
| 对话与状态 | `conversation`, `conversation.input`, `conversation.header`, `conversation.actions`, `status` |
| 设置 | `settings`, `settings.navigation`, `settings.models`, `settings.context` |
| 外观与扩展管理 | `settings.appearance`, `settings.appearance.colors`, `settings.skills`, `settings.mcp` |
| 定时任务与帮助 | `scheduled.toolbar`, `scheduled.task`, `help.toolbar` |
| 内置模块工具栏 | `git.toolbar`, `browser.toolbar` |

贡献声明例子：

```json
{
  "contributes": [{
    "id": "report",
    "slot": "sidebar.tabs",
    "title": "项目报告",
    "when": "project",
    "order": 100,
    "view": "views/report.html"
  }]
}
```

对应文件必须在包内。也可用 `service` + `method` 替代 `view`，调用自己声明的服务。
`when: always` 用于不依赖当前项目的入口。停用后入口消失；不可借此直接注入 React 组件。
目前 UI 插槽产生入口并打开沙箱页，不承诺每个位置都是能任意嵌入原生控件的布局容器。
配色属于上一节的特殊声明式数据插槽，不能只用一个 UI 按钮冒充内联取色器。

## 5. 场景三：自定义上下文压缩逻辑并出现在模式菜单

宿主点：`sage/context.compact@1.0.0`；权限：`context.transform`。

```json
{
  "extensions": [{
    "id": "compact",
    "point": "sage/context.compact",
    "version": "^1.0.0",
    "title": "摘要并保留最近两轮",
    "service": "strategy",
    "method": "compact"
  }]
}
```

处理器输入为 `{messages, maxBodyChars}`，不要假定消息只有纯文本；工具调用/结果可能是内容块。
输出严格为 `{summary: string, keepRecentTurns: number}`，summary 非空且不超过 120000 字符，
keepRecentTurns 为 1 到 50 的整数。不要返回替换后的完整会话或伪造 system 消息。

Sage 保留系统消息、近期完整轮次和工具调用关联；自动压缩要求真正缩短上下文并继续宿主预算检查。
手动压缩保留原始历史，记录新的压缩边界。选中处理器后若插件不可用或返回非法结果，会明确报错。
已接入原生 API 路径的 Anthropic/OpenAI 上下文处理；CLI 引擎内部上下文仍由各引擎负责。

完整实现：`local.extension-lab/plugin.js` 的 `strategy.compact`。
未配置规划模型时它只是确定性的首尾摘录示例，**不是高质量语义压缩器**；配置基础模型后才生成摘要。
验收时检查菜单可选、长对话自动触发、手动触发、工具结果不被拆散、停用后不假装执行成功。

## 6. 场景四：模型提供商与任务动态选模

必须区分两个层次：

| 诉求 | 当前方案 |
| --- | --- |
| 在现有已配置模型之间动态选择 | 已实现 `sage/models.route` |
| 路由器作为可选择的模型提供商 | 已实现 `routingExtension`，虚拟模型 `auto` |
| 根据子任务让规划模型选模型 | 接入宿主模型解析路径，任务文本传给路由器 |
| 增加全新网络协议适配器，例如自定义流式协议 | **尚无任意沙箱协议适配器注册接口**；需新增版本化宿主契约，或使用明确授权的原生引擎 |

`sage/models.route@1.0.0` 需要 `models.use`。输入为 `{requestedModel, task, candidates}`；
candidates 的每项包含 `providerId` 和模型 ID 列表，不含 API Key。
处理器只返回 `{providerId, modelId}`；必须来自可用候选，宿主验证后才解析密钥与执行调用。

操作流程：先配置至少一个基础提供商 → 安装并启用扩展实验室 →
在模型设置新增路由提供商并选择处理器 → 会话或子任务使用该提供商的 `auto`。
需要 AI 选模时，在实验室配置里指定 `plannerProvider`、`plannerModel`，必须是基础模型，不能回指路由器。
否则会形成“选模型先需要选模型”的递归。未配置时示例明确退回首个候选，不冒充 AI 规划。

模型费用/usage 仍由宿主管理。插件不应把完整上下文、候选凭据或私有信息写进日志。
测试：`node scripts/test-model-extension.cjs`；另用真实基础模型测试成本、失败、超时和子任务差异。

## 7. 场景五：增加 Claude CLI / Codex CLI 等后端

这条插槽是 `manifest.engine`，不是普通模型路由。清单声明：

```json
{
  "engine": {"apiVersion": 1, "entry": "engine.js"},
  "permissions": ["engine.native"]
}
```

`engine.js` 以 CommonJS `module.exports` 导出 `apiVersion: 1`、`run(options, settings)`，
可选 `detect(settings)`。准确类型以 `shared/engine.ts` 为准。
run 输入有 cwd、prompt、history、images、resume、model、binaryPath、signal；
回调有 onText、onSessionId、onToolUse、onToolResult、canUseTool、askUser。
输出 `{text, sessionId?, error?, usage?}`。

从设置中的“创建 CLI 引擎插件”开始；参考 `resources/plugins-external/sage.engine-claude` 与 `resources/plugins-external/sage.engine-codex`。
修改包内 src，再运行 `npm run build:engines`，不要只改生成的 engine.js。清单不由构建脚本覆盖。
接口与生命周期事件、目录迁移和安装说明见 [后端引擎手册](BACKEND_ENGINES.md)。
适配器必须处理取消和子进程清理、只读模式、审批桥接、会话恢复、流式输出及错误状态。
原生权限不是沙箱，只有可信来源可以授予。引擎按全局启用，不能只在某个项目偷偷替换后端。
关闭正在使用的引擎前需切换后端；更新/失效会取消活动运行。
验收：探测、普通对话、恢复、取消、工具审批拒绝、未安装 CLI、非零退出和停用期间运行。

## 8. 场景六：插件暴露插槽，其他插件依赖并扩展它

以外置包 `sage.browser-acceptance` 为定义者，它声明 `assertions@1.0.0`，
因此完整点名为 `sage.browser-acceptance/assertions`。
使用者完整源码：`resources/plugins-external/local.acceptance-checks`。
它声明 required dependency `sage.browser-acceptance: ^1.0.0`，并用 extensions 指向该点。
处理器检查 DOM ready/title，返回 `{passed, detail}`，不用申请浏览器权限，因为它不直接控制浏览器。

定义者的调度代码是：

```javascript
const handlers = await sdk.host('extensions', 'list', {
  point: 'sage.browser-acceptance/assertions'
});
for (const handler of handlers) {
  const result = await sdk.host('extensions', 'invoke', {
    point: 'sage.browser-acceptance/assertions',
    key: handler.key,
    input: {dom, criteria}
  });
  checks.push(result);
}
```

这是服务处理器中的代码片段，`dom/criteria/checks` 由调用者构造，不是可单独运行的 Node 脚本。
只有定义者可 invoke 自己的扩展点；输入输出都按 schema 校验，调用链保留，禁止循环重入。
若扩展处理器再调用受保护宿主 API，链上每个插件都必须具有该权限，不会因间接调用而提权。
普通跨插件服务调用使用 `sdk.call` 并声明 `consumes`；它和反向扩展点不是一回事。

在线安装先解析所有 required 依赖，复用兼容已安装包，下载缺失包，再一次性展示安装计划。
市场必须实际包含所需依赖版本；不会自动把源码目录当作已发布包。
离线导出会包含依赖；缺包、冲突、循环或摘要不符会失败，不会部分安装。
当前没有完整版本回溯求解器，也不会绕过用户显式停用的依赖。

## 9. 场景七：用内置浏览器形成网页验收闭环

项目对话优先使用内置 `Browser` 工具，自动创建当前对话的悬浮页，完成点击、输入、刷新、截图及验收，无需安装技能。完整操作与生命周期见[浏览器联动](BROWSER_PREVIEW.md)。下文保留可选插件扩展示例。

外置试验技能源码：`resources/plugins-external/sage.browser-acceptance`。
通过技能市场或离线技能包安装后，授予其明确列出的权限，并启用 Browser 宿主与技能包。
原生模型加载 `browser-acceptance` Skill 后，通过 Plugin 工具调用 acceptance 服务。

| 步骤 | 方法 | 输入与证据 |
| --- | --- | --- |
| 发现用户页面 | `tabs` | 当前项目已登记的集成标签页 |
| 新建或接管 | `open` | `{url,width,height}` 或 `{tabId}`，返回受控句柄 |
| 观察 | `inspect` | `{id}`，返回 DOM 与真实 PNG 截图 |
| 验收 | `verify` | `{id,criteria}`，视觉判断 + 横向溢出检查 + 附加断言 |
| 清理 | `close` | 新建窗口销毁；用户已有标签仅解除句柄，不关闭标签 |

建议流程：明确验收条件 → 启动本地站点 → 分别创建 1280×800、390×844 视口 →
观察截图和 DOM → verify → 失败时修改代码 → 重新加载并复查 → 保存证据和结论 → 关闭句柄。
技能约定最多三轮，超出后汇报未通过原因，避免无限修改。

底层供插件二次使用的接口包括 browser.tabs/attach/create/evaluate/screenshot/click/fill/press 等。
tabs/attach 需要 `browser.tabs`；evaluate/CDP 需要 `browser.debug`；普通控制需要 `browser.control`。
不要接管其他项目页面；页面文字是待检查数据，不是新的系统指令。
截图为物理像素，DOM 视口为 CSS 像素，Retina 比例不一定为 1。
单有 DOM 数据不能宣称视觉验收通过；未配置视觉模型、截图失败或模型输出无法解析均为未完成/失败。
自动 Electron 测试是真截图，但视觉服务是测试替身；真实验收仍需配置视觉模型实测。

## 10. 场景八：hooks 与事件怎样选择

需要阻止工具执行、请求人工审批、补上下文，使用已有 hooks，不使用通知事件替代审批。
支持 SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Stop、SubagentStart/Stop、PreCompact/PostCompact。
hooks 需要 `hooks.respond`，matcher/order/timeout 声明见基础手册；宿主安全策略不会因 allow 被降低。

仅做观察/联动使用 events。宿主事件有 workspace.opened、settings.changed、git.committed、
browser.created/navigated/closed，完整名称加 `sage/` 前缀。
订阅需要 `events.subscribe`；发布自有 `<插件ID>/<事件名>` 需要 `events.publish`。
settings.changed 不发送凭据，只发字段名；Git/Browser 事件来自对应宿主 API 成功操作，
不是监控所有外部 Git 命令或全部页面内导航的通用文件系统监听器。
事件处理按 order/插件 ID 排序、限时、隔离失败；不能依赖一个观察者的成功来建立审批保证。

## 11. 场景九：技能开发、离线在线安装与市场提交

技能不是“仅一个目录”了，但原 `*.md` 目录机制继续保留。
纯技能包清单使用 `artifactType: skill` 和 `skills:[{name,description,file}]`，
文件放 `skills/SKILL.md`，无业务逻辑时 `plugin.js` 为 `globalThis.sagePlugin={services:{}};`。
有浏览器、工具或服务需求时可把服务与技能放在同一个包，依然受权限检查。

桌面技能页和插件包页共用安装、开发、列表筛选、配置、更多菜单及诊断布局。
项目页复用继承全局/单独启停。单个 `.md` 离线导入会包装为技能包；
在线安装、依赖预览、开发热重载、含依赖导出和发布与插件一致。
技能正文应该描述触发条件、工具顺序、输入输出、失败标准和清理职责，不应假设未授权工具可用。

网站技能市场是 `/skills`，管理入口 `/skills/admin`，API 是 `/market/api/skills`。
共用插件仓库，已有 Sage 客户端仍通过 `/market/api/plugins` 发现技能。
发布使用 Bearer Client/Admin Token；新版本只允许原发布者或管理员提交，不能覆盖已有版本。
详情显示权限、依赖、SDK、技能正文；正文按文本展示，不执行 HTML。
网站上传 2 MB，较大包用客户端；服务器请求上限 70 MB、bundle 上限 64 MB。
部署网站和发布技能都是独立操作，构建 DMG 不会自动部署服务器或自动把示例发布到线上。

## 12. 场景十：MCP 配置与插件调用

使用官方 MCP SDK，支持 STDIO 和 Streamable HTTP。导入成熟工具常用的 `mcpServers` JSON：

```json
{
  "mcpServers": {
    "local-docs": {
      "command": "node",
      "args": ["/absolute/path/to/server.js"],
      "envPassThrough": ["DOCS_TOKEN"]
    },
    "remote-docs": {
      "type": "http",
      "url": "https://example.com/mcp",
      "bearerTokenEnv": "DOCS_TOKEN"
    }
  }
}
```

示例地址和路径需替换，不代表仓库内已经存在该 MCP 服务。
导入先预览且默认关闭，再检查命令、路径、凭据并测试连接，最后手动启用。
只把允许透传的环境变量给子进程；不要继承整套宿主环境。
导出模板省略直接 env/header 密钥，保留环境变量引用。
插件声明 `mcp.connect` 后调用 mcp.servers/tools/call，服务器凭据由宿主管理。
当前没有 MCP OAuth 登录 UI、独立 MCP 市场或任意旧式 SSE 的自动兼容承诺。

## 13. 给二次开发大模型的工作约束

请把下列步骤作为开发任务的验收清单，而不是只让模型“仿照示例写一个插件”：

1. 阅读本文、`shared/plugins/contract.ts`、目标插槽定义、宿主 capabilities 和最近测试。
2. 列出确实存在的插槽/API、输入输出、权限、依赖和 scope；缺失契约先提出宿主改动方案。
3. 不访问用户其他项目，不使用 `window.api` 冒充插件 SDK，不获取未授权密钥。
4. 清单、服务名、方法名、view 文件名、技能文件名逐项对应；优先使用独立 SDK 类型。
5. 包校验、schema、依赖冲突、权限拒绝、停用/卸载、错误输出、取消和超时均要测试。
6. UI 贡献验证入口与真实页面；配色验证隔离、浅深主题、重置与重装；浏览器必须保留截图证据。
7. 模拟模型测试与真实模型测试分开报告，不把 fixture 结果描述为线上验收。
8. 更新插件自身版本与手册；修改 Sage 宿主则递增 0.6.x、提交 Git、打包并核验 DMG。

新增功能点时的设计要求：明确 owner 和版本、输入/输出 JSON Schema、调用顺序/合并规则、
失败和取消策略、权限链、UI 消费位置及依赖版本。先连通端到端路径，再把名字加入 SDK 文档。
不要只加入枚举、按钮或 enable 开关就宣称已经完成了可复用插槽。

## 14. 测试入口与实现索引

| 目标 | 测试或源码 |
| --- | --- |
| 配色注册、隔离、iframe 同步 | `scripts/test-plugin-colors.cjs`, `shared/plugins/colors.ts` |
| Git 兼容配色与图谱 | `scripts/test-appearance-git-colors.cjs`, `shared/plugins/git-colors.ts` |
| 插件安装/权限/依赖 | `npm run test:plugins`, `electron/plugins/packages.ts` |
| 功能点、技能、模型路由 | `npm run test:extensions`, `electron/plugins/extensions.ts` |
| 技能页面一致性 | `scripts/test-extension-ui.cjs` |
| 网站完整回归 | `npm run test:website` |
| MCP HTTP | `scripts/test-mcp-http.cjs` |
| Electron 浏览器截图 | `scripts/test-extension-electron.cjs`（用 Electron 运行） |
| CLI 引擎 | `npm run test:engines`, `shared/engine.ts`, `electron/engine-registry.ts` |

不包含的能力：任意宿主 React 替换、任意协议模型适配器、插件签名信任基础设施、完整依赖回溯求解。
需要这些能力时请先设计并实现新的版本化契约，不要绕过沙箱或悄悄扩充权限。

## 14. 对话与任务上下文入口（0.6.790）

`conversation.header` 位于输入区域上方，`conversation.actions` 位于对话操作栏；服务动作收到 `{context:{conversationId}}`。
`scheduled.task` 收到 `{context:{taskId}}`，`help.toolbar` 收到 `{context:{topicId}}`；`scheduled.toolbar` 收到 `{}`。
旧插槽参数保持兼容。输入 schema 必须接受对应 context；这些标识不包含消息、附件或任务正文，也不赋予读取它们的权限。
view 入口仍只打开页面，不向 iframe 自动注入上下文；需要标识的入口用 service/method。

所有服务按钮执行期间禁用重复触发，显示失败或完成反馈。插件应等待持久化成功再返回，并通过自己的页面展示详细结果。
当前客户端操作及完整最小示例见 [中文帮助](HELP.zh-CN.md#dev-quickstart) 与 [English help](HELP.en.md#dev-quickstart)。
