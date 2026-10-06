# Sage 插件开发 API 文档

**适用版本**：Sage 0.6.812；SDK 1.5.0；插件包格式 1

---

## 目录

1. [快速开始](#1-快速开始)
2. [SDK 接口总览](#2-sdk-接口总览)
3. [宿主能力 (Host API) 完整列表](#3-宿主能力-host-api-完整列表)
4. [浏览器 API 详解](#4-浏览器-api-详解)
5. [插件清单规范](#5-插件清单规范)
6. [内置插件概览](#6-内置插件概览)
7. [完整示例](#7-完整示例)

---

## 1. 快速开始

### 插件结构

```
local.hello/
  sage.plugin.json      # 插件清单（必须）
  plugin.js             # 运行入口（必须）
  sage-sdk.d.ts         # SDK 类型定义（可选，供编辑器提示）
  views/hello.html      # 插件页面（可选）
```

### 最小入口代码

```javascript
// @ts-check
/// <reference path="./sage-sdk.d.ts" />
globalThis.sagePlugin = {
  services: {
    hello: {
      greet: async (args, sdk) => {
        return 'Hello, ' + args.name;
      }
    }
  }
};
```

### SDK 接口定义

```typescript
// sage-sdk.d.ts
export interface SDK {
  i18n: PluginI18n;
  call<T>(plugin: string, service: string, method: string, args?: Json): Promise<T>;
  host<T>(service: string, method: string, args?: Json): Promise<T>;
  settings: {
    get<T>(key: string): Promise<T>;
    set<T>(key: string, value: T): Promise<T>;
  };
}
```

**调用方式**：
- `sdk.host(service, method, args)` — 调用宿主能力（内置 API）
- `sdk.call(plugin, service, method, args)` — 调用其他插件的服务

---

## 2. SDK 接口总览

| SDK 方法 | 说明 |
|---------|------|
| `sdk.host(service, method, args)` | 调用宿主 API，详见下一节 |
| `sdk.call(plugin, service, method, args)` | 调用其他插件声明的服务 |
| `sdk.settings.get(key)` | 读取本插件配置 |
| `sdk.settings.set(key, value)` | 写入本插件配置 |
| `sdk.i18n.t(key, params)` | 翻译文本（服务方法中） |
| `sdk.i18n.locale` | 当前语言 |
| `sdk.i18n.onDidChangeLocale(cb)` | 监听语言变化，返回取消订阅函数 |

**提示**：可以用 `sdk.host('capabilities', 'list', {})` 动态查看当前可用的所有宿主 API。

---

## 3. 宿主能力 (Host API) 完整列表

### 3.1 探查可用 API

```javascript
const apis = await sdk.host('capabilities', 'list', {});
// 返回: [{id, permission, description, input}, ...]
```

### 3.2 完整能力表

| 分类 | 方法 | 所需权限 | 输入参数 | 返回 |
|------|------|----------|----------|------|
| **插件配置** | `settings.get` | 无 | `{key}` | 配置值 |
| | `settings.set` | 无 | `{key, value}` | 写入的值 |
| **工作区** | `workspace.current` | `workspace.read` | `{}` | `{path}` |
| **文件读取** | `tools.Read` | `workspace.read` | `{file_path, limit?}` | 文件内容 |
| | `tools.Glob` | `workspace.read` | `{pattern}` | 文件列表 |
| | `tools.Grep` | `workspace.read` | `{pattern, include?}` | 匹配行 |
| | `tools.RecallMemory` | `workspace.read` | `{query}` | 记忆结果 |
| **文件写入** | `tools.Write` | `workspace.write` | `{file_path, content}` | 写入结果 |
| | `tools.Edit` | `workspace.write` | `{file_path, old_string, new_string}` | 编辑结果 |
| | `tools.SaveMemory` | `workspace.write` | `{content, tags}` | 保存结果 |
| **命令** | `tools.Bash` | `workspace.write` | `{command, timeout?, network?}` | 命令输出 |
| **网络** | `tools.WebFetch` | `network.fetch` | `{url}` | 页面内容 |
| **模型** | `models.list` | `models.use` | `{}` | 可用模型列表 |
| | `models.generate` | `models.use` | `{prompt, providerId?, modelId?}` | `{text}` |
| | `models.analyzeImage` | `models.use` | `{images, prompt, timeoutMs?}` | `{analyzed, text}` |
| **对话** | `conversations.list` | `conversations.read` | `{}` | 对话摘要列表 |
| | `conversations.read` | `conversations.read` | `{id}` | 对话详情 |
| | `conversations.create` | `conversations.write` | `{title?}` | `{id, title}` |
| **定时任务** | `tasks.list` | `tasks.read` | `{}` | 任务列表 |
| | `tasks.create` | `tasks.write` | `{name, prompt, schedule}` | 任务详情 |
| **通知渠道** | `channels.list` | `channels.send` | `{}` | 渠道列表 |
| | `channels.send` | `channels.send` | `{id, text}` | 发送结果 |
| **UI** | `ui.notify` | `ui` | `{text}` | `true` |
| | `ui.update` | `ui` | `{contribution, title?, badge?, visible?, order?}` | `true` |
| | `ui.open` | `ui` | `{contribution}` | `true` |
| **浏览器** | `browser.*` | 见下节 | 见下节 | 见下节 |
| **Git** | `git.status` | `workspace.read` | `{}` | `{branch, files}` |
| | `git.diff` | `workspace.read` | `{ref1?, ref2?, path?}` | `{text}` |
| | `git.log` | `workspace.read` | `{limit?, skip?, ref?, path?}` | `{commits}` |
| | `git.commit` | `workspace.write` | `{message, paths?}` | `{output, stagedPaths}` |
| | `git.branch` | `workspace.write` | `{name, base?}` | `{branch}` |
| | `git.push` | `workspace.write` | `{setUpstream?}` | `{output}` |
| **MCP** | `mcp.listTools` | `mcp.connect` | `{command, args?, env?, cwd?}` | 工具列表 |
| | `mcp.callTool` | `mcp.connect` | `{command, name, arguments, args?}` | 工具结果 |

### 3.3 models.generate 示例

```javascript
const result = await sdk.host('models', 'generate', {
  prompt: '请总结以下内容：...'
  // 可选：指定模型
  // providerId: 'openai',
  // modelId: 'gpt-4o'
});
return result.text; // 模型生成的文本
```

### 3.4 tools.Bash 示例

```javascript
const output = await sdk.host('tools', 'Bash', {
  command: 'npm test',
  timeout: 30000,
  network: false
});
```

### 3.5 tasks.create 示例

```javascript
await sdk.host('tasks', 'create', {
  name: '日报',
  prompt: '汇总今天项目进展',
  schedule: {
    type: 'daily',  // once | interval | hourly | daily | weekly | monthly
    at: '18:00'
  }
});
```

---

## 4. 浏览器 API 详解

### 4.1 权限说明

外置插件优先依赖随 Sage 提供的 `sage.browser/automation` 适配服务；该包将请求转发给主进程 Browser 宿主，权限和隔离仍由宿主强制执行。插件也可以直接调用 `sdk.host('browser', ...)`，但会绑定到宿主接口；新插件建议使用适配服务并在 manifest 声明 `dependencies` 与 `consumes`。

| 权限 | 说明 |
|------|------|
| `browser.control` | 基础浏览器控制（创建、导航、交互） |
| `browser.debug` | 页面脚本执行、CDP 协议 |
| `browser.files` | 文件上传/下载 |

### 4.2 浏览器方法完整列表

页面操作方法需要 `id` 参数（通过 `create` 或 `attach` 获得的页面句柄）；`tabs`、`create`、`list` 不需要页面句柄。

#### 页面生命周期

| 方法 | 输入 | 返回 | 说明 |
|------|------|------|------|
| `create` | `{url?, width?, height?}` | `{id}` | 创建页面，可选加载 URL |
| `tabs` | `{}` | `[{id, title, url}]` | 列出当前项目可接入的集成浏览器标签页（需 `browser.tabs`） |
| `attach` | `{tabId}` | `{id}` | 为集成标签页创建隔离句柄（需 `browser.tabs`） |
| `list` | `{}` | `[{id, url, title}]` | 列出本插件所有页面 |
| `close` | `{id}` | `true` | 关闭页面 |

#### 导航

| 方法 | 输入 | 返回 | 说明 |
|------|------|------|------|
| `navigate` | `{id, url}` | `{url}` | 导航到 URL |
| `back` | `{id}` | `true` | 后退 |
| `forward` | `{id}` | `true` | 前进 |
| `reload` | `{id}` | `true` | 刷新 |

#### 观察

| 方法 | 输入 | 返回 | 说明 |
|------|------|------|------|
| `snapshot` | `{id}` | `{url, title, text, elements}` | 页面快照（文本+交互元素） |
| `screenshot` | `{id}` | `{mimeType, base64}` | PNG 截图 |
| `console` | `{id}` | `[{level, message}]` | 控制台日志 |
| `frames` | `{id}` | 帧树 | CDP 帧信息（需 `browser.debug`） |

#### 交互

| 方法 | 输入 | 返回 | 说明 |
|------|------|------|------|
| `click` | `{id, selector}` | `true` | 点击元素 |
| `fill` | `{id, selector, text}` | `true` | 填写输入框 |
| `select` | `{id, selector, text}` | `true` | 选择下拉选项 |
| `press` | `{id, key}` | `true` | 按键 |
| `scroll` | `{id, text: 'up'/'down'}` | `true` | 滚动 |
| `wait` | `{id, selector}` | `true` | 等待元素出现 |

#### 接管（手动模式）

| 方法 | 输入 | 返回 | 说明 |
|------|------|------|------|
| `show` | `{id}` | `true` | 显示页面 |
| `hide` | `{id}` | `true` | 隐藏页面 |
| `pause` | `{id}` | `true` | 暂停自动化 |
| `resume` | `{id}` | `true` | 恢复自动化 |

#### 高级（需 `browser.debug`）

| 方法 | 输入 | 返回 | 说明 |
|------|------|------|------|
| `evaluate` | `{id, expression}` | 表达式结果 | 执行 JavaScript |
| `cdp` | `{id, command, params?}` | CDP 结果 | 执行 CDP 命令 |

#### 文件（需 `browser.files`）

| 方法 | 输入 | 返回 | 说明 |
|------|------|------|------|
| `upload` | `{id, selector, file}` | CDP 结果 | 上传文件 |
| `download` | `{id}` | `{directory}` | 启用下载 |

### 4.3 完整使用示例

```javascript
// 创建页面并获取快照
const page = await sdk.call('sage.browser', 'automation', 'create', {
  url: 'https://example.com',
  width: 1280,
  height: 800
});

try {
  // 获取页面快照
  const snapshot = await sdk.call('sage.browser', 'automation', 'snapshot', { id: page.id });
  console.log(snapshot.title, snapshot.text);
  
  // 等待并点击按钮
  await sdk.call('sage.browser', 'automation', 'wait', { id: page.id, selector: 'button.submit' });
  await sdk.call('sage.browser', 'automation', 'click', { id: page.id, selector: 'button.submit' });
  
  // 填写表单
  await sdk.call('sage.browser', 'automation', 'fill', { id: page.id, selector: '#name', text: '张三' });
  
  // 截图
  const shot = await sdk.call('sage.browser', 'automation', 'screenshot', { id: page.id });
  // shot.mimeType = 'image/png', shot.base64 = '...'
  
} finally {
  await sdk.call('sage.browser', 'automation', 'close', { id: page.id });
}
```

### 4.4 通过 sage.browser 插件调用

如果你的插件依赖 `sage.browser` 插件，则通过 `sdk.call` 调用：

```javascript
// manifest 中声明:
// "dependencies": {"sage.browser": "^1.2.0"}
// "consumes": [{"plugin":"sage.browser","service":"automation","version":"^1.1.0"}]
// "permissions": ["browser.control"]

const page = await sdk.call('sage.browser', 'automation', 'create', {
  url: args.url
});
try {
  return await sdk.call('sage.browser', 'automation', 'snapshot', { id: page.id });
} finally {
  await sdk.call('sage.browser', 'automation', 'close', { id: page.id });
}
```

### 4.5 重要注意事项

1. **句柄绑定**：页面句柄绑定到发起插件和项目，不能跨插件使用
2. **并发限制**：同一页面不允许并发操作
3. **暂停模式**：`show` 或窗口获得焦点会暂停自动化，需 `resume` 恢复
4. **选择器唯一**：`wait` 等待唯一元素出现
5. **快照限制**：最多返回 60,000 字正文和 300 个交互元素
6. **临时会话**：页面不复用主程序浏览器的登录状态

---

## 5. 插件清单规范

### 5.1 完整清单结构

```json
{
  "format": 1,
  "id": "publisher.name",
  "name": "插件名称",
  "version": "1.0.0",
  "sdk": "^1.1.0",
  "entry": "plugin.js",
  "description": "插件描述",
  "category": "workflow",
  "scope": "both",
  "permissions": ["browser.control", "workspace.read"],
  "services": {
    "myService": {
      "version": "1.0.0",
      "methods": {
        "myMethod": {
          "description": "方法说明",
          "input": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
          "output": {"type": "string"},
          "tool": true
        }
      }
    }
  },
  "contributes": [
    {
      "id": "myView",
      "slot": "sidebar.bottom",
      "title": "我的视图",
      "view": "views/myview.html"
    }
  ],
  "hooks": [],
  "skills": [],
  "settings": {
    "apiKey": {
      "title": "API Key",
      "type": "string",
      "default": "",
      "scope": "global"
    }
  },
  "dependencies": {},
  "consumes": [],
  "i18n": {
    "defaultLocale": "en",
    "messages": {
      "en": {"pluginName": "My Plugin"},
      "zh": {"pluginName": "我的插件"}
    }
  }
}
```

### 5.2 关键字段说明

| 字段 | 说明 |
|------|------|
| `format` | 固定为 `1` |
| `id` | 插件 ID，格式：`publisher.name` |
| `name` | 显示名称，支持 `%key%` 翻译 |
| `version` | 语义化版本号 |
| `sdk` | SDK 版本范围，如 `^1.0.0` |
| `entry` | 入口文件，固定为 `plugin.js` |
| `category` | 分类：`engine/workflow/documentation/development/integration/other` |
| `scope` | 启用范围：`global/project/both` |
| `permissions` | 权限列表 |
| `services` | 服务定义 |
| `contributes` | UI 贡献点 |
| `hooks` | 钩子订阅（见 5.6），需 `hooks.respond` 权限 |
| `settings` | 配置字段 |
| `dependencies` | 包依赖 |
| `consumes` | 消费的服务 |
| `hostDependencies` | 宿主依赖：`{"browser": "^1.0.0", "git": "^1.0.0"}` |

### 5.3 可用的 Slot（UI 贡献点）

| Slot | 说明 |
|------|------|
| `sidebar.middle` | 侧边栏中间 |
| `sidebar.bottom` | 侧边栏底部 |
| `tab` | 标签页 |
| `settings` | 设置面板 |
| `status` | 状态栏 |
| `toolbar` | 工具栏 |
| `conversation` | 对话区域 |
| `menu` | 菜单 |
| `panel` | 面板 |

### 5.4 权限列表

| 权限 | 说明 |
|------|------|
| `workspace.read` | 读取项目文件 |
| `workspace.write` | 写入项目文件 |
| `network.fetch` | 网络请求 |
| `models.use` | 使用模型 |
| `conversations.read` | 读取对话 |
| `conversations.write` | 创建对话 |
| `tasks.read` | 读取任务 |
| `tasks.write` | 创建任务 |
| `channels.send` | 发送通知 |
| `browser.control` | 浏览器基础控制 |
| `browser.debug` | 浏览器调试 |
| `browser.files` | 浏览器文件操作 |
| `mcp.connect` | 连接 MCP |
| `ui` | UI 操作 |
| `engine.native` | 原生引擎 |
| `hooks.respond` | 响应钩子事件（`manifest.hooks` 订阅）；声明了钩子却未申请该权限的包会在打包校验时被拒绝 |

### 5.5 Schema 支持的关键字

输入/输出 Schema 支持：`type`、`properties`、`required`、`additionalProperties`、`items`、`enum`、`description`、`minimum`、`maximum`、`minLength`、`maxLength`

### 5.6 钩子订阅（manifest.hooks）

钩子是插件扩展点，通过 manifest.hooks 调用插件自己的服务并返回结构化决策。旧 hooks.json 命令执行已移除，旧文件保留但不读取。

钩子没有独立设置页，由插件启用状态及 hooks.respond 授权控制。完整清单、触发边界与迁移方式见 [扩展点清单](PLUGIN_EXTENSION_CATALOG.md)。

可选事件（与 Claude Code 对齐）：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`、`SubagentStart`、`SubagentStop`、`PreCompact`、`PostCompact`。

```json
{
  "format": 1,
  "id": "local.guard",
  "name": "危险命令拦截",
  "version": "1.0.0",
  "sdk": "^1.1.0",
  "entry": "plugin.js",
  "permissions": ["hooks.respond"],
  "services": {
    "guard": {
      "version": "1.0.0",
      "methods": {
        "preToolUse": { "description": "检查即将执行的工具调用", "input": { "type": "object" }, "output": { "type": "object" } }
      }
    }
  },
  "hooks": [
    { "id": "guard-bash", "event": "PreToolUse", "title": "拦截 rm -rf", "matcher": "Bash", "service": "guard", "method": "preToolUse", "order": 10, "timeoutMs": 2000 }
  ],
  "contributes": [],
  "settings": {}
}
```

钩子条目字段：`id`（包内唯一）、`event`、`title`（展示名，支持 `%key%` i18n）、`matcher`（省略或 `*` 匹配全部，否则正则，正则无效时退化为逗号分隔精确匹配）、`service`/`method`（必须是本插件已声明且已实现的方法）、`order`（默认 100）、`timeoutMs`（默认 5000，上限 20000）。

服务方法收到的入参就是事件 JSON（`hook_event_name`、`session_id`、`cwd` 加上事件自有字段，如 `tool_name`、`tool_input`、`prompt`），返回可直接控制决策的对象，语义与外部命令的 stdout JSON 完全一致：

```javascript
sagePlugin = {
  services: {
    guard: {
      async preToolUse(event) {
        const command = event?.tool_input?.command ?? '';
        if (/rm\s+-rf/.test(command)) {
          return { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: '危险删除命令已被策略插件拦截' } };
        }
        return {}; // 不表态，继续跑后面的钩子
      },
    },
  },
};
```

| 返回字段 | 效果 |
|----------|------|
| `{ decision: 'block', reason }` | 拦截本次操作，`reason` 可注入下一轮上下文 |
| `{ additionalContext }` 或 `{ hookSpecificOutput: { additionalContext } }` | 追加上下文 |
| `{ hookSpecificOutput: { permissionDecision: 'ask' \| 'deny', permissionDecisionReason } }` | 仅 PreToolUse；`deny` 拦截、`ask` 强制人工审批；`allow` 与 `true` 一律当作不表态，不穿透安全策略 |

执行顺序与安全边界：

- 同一事件先按文件顺序跑完外部命令钩子，再按 `order` 依次跑已启用的插件订阅；任一 `deny`/`block` 即停止后续钩子。
- 声明了 `hooks` 但未申请 `hooks.respond` 的包在打包校验阶段就被拒绝；`id` 重复、指向未知方法、`matcher` 正则非法同样报错。
- 钩子跑在对话关键路径上：超时或抛错只会记入决策 `errors`（在钩子插槽页的错误列表可见），绝不阻断主流程；也不能借钩子执行本机命令（那是 `engine.native`）。
- 方法的 `input` 默认 `{"type":"object"}`，因此事件 payload 的额外字段不会被拒；若自行收紧为 `additionalProperties: false`，必须同时列出全部事件字段。

---

### 5.7 单色图标（manifest.icon）

SDK 1.5 新增可选顶层字段，包内可直接携带图标几何数据。执行引擎状态栏复用该字段，不加载外部文件或运行插件服务。

```json
{
  "format": 1,
  "id": "local.icon-example",
  "name": "Icon example",
  "version": "1.0.0",
  "sdk": "^1.5.0",
  "entry": "plugin.js",
  "icon": {"paths": ["M4 12h16", "M12 4v16"], "filled": false}
}
```

| 字段 | 约束 |
| --- | --- |
| `paths` | 必填，1–16 条 SVG 路径；每条最多 4096 字符、合计最多 16000 字符，以 `M`/`m` 开始，只允许路径指令和数值坐标 |
| `filled` | 可选布尔值；省略或 `false` 使用 2px 圆角线条、无填充；`true` 使用单色填充 |

宿主固定 `viewBox="0 0 24 24"`，并以 `currentColor` 跟随界面主题。`icon` 对象不接受其他字段；禁止 SVG/XML 标签、脚本、外链、事件属性以及任意颜色或尺寸属性。元数据随清单一起校验和计算摘要。旧无图标清单保持兼容，不会因这个可选字段得到新默认值；带图标的新包需声明 SDK 1.5 并更新插件版本。

## 6. 内置插件概览

Sage 当前有以下内置插件/功能模块：

| ID | 名称 | 说明 |
|---|------|------|
| `git` | Git 插件 | 分支管理、提交历史、差异查看 |
| `browser` | Browser 插件 | 内嵌浏览器、页面自动化 |
| `specs` | Specs 插件 | 规格文档管理、回溯分析 |
| `docs` | Docs 插件 | 项目 Wiki、DeepWiki |

这些内置功能目前使用内置实现，共用管理界面，不是普通独立 `.sageplugin` 包。

---

## 7. 完整示例

### 7.1 网页读取插件

**sage.plugin.json**:
```json
{
  "format": 1,
  "id": "local.page-reader",
  "name": "Page Reader",
  "version": "1.0.0",
  "sdk": "^1.0.0",
  "category": "documentation",
  "entry": "plugin.js",
  "permissions": ["browser.control"],
  "hostDependencies": {"browser": "^1.0.0"},
  "services": {
    "reader": {
      "version": "1.0.0",
      "methods": {
        "read": {
          "description": "读取网页内容",
          "input": {
            "type": "object",
            "properties": {"url": {"type": "string"}},
            "required": ["url"]
          },
          "output": {"type": "object"},
          "tool": true
        }
      }
    }
  }
}
```

**plugin.js**:
```javascript
// @ts-check
/// <reference path="./sage-sdk.d.ts" />
globalThis.sagePlugin = {
  services: {
    reader: {
      read: async (args, sdk) => {
        // 创建浏览器页面
        const page = await sdk.call('sage.browser', 'automation', 'create', { url: args.url });
        try {
          // 获取快照
          const snapshot = await sdk.call('sage.browser', 'automation', 'snapshot', { id: page.id });
          return {
            url: snapshot.url,
            title: snapshot.title,
            text: snapshot.text
          };
        } finally {
          await sdk.call('sage.browser', 'automation', 'close', { id: page.id });
        }
      }
    }
  }
};
```

### 7.2 模型摘要插件

**sage.plugin.json**:
```json
{
  "format": 1,
  "id": "local.summary",
  "name": "Text Summary",
  "version": "1.0.0",
  "sdk": "^1.0.0",
  "category": "workflow",
  "entry": "plugin.js",
  "permissions": ["models.use"],
  "services": {
    "summary": {
      "version": "1.0.0",
      "methods": {
        "generate": {
          "description": "生成文本摘要",
          "input": {
            "type": "object",
            "properties": {
              "text": {"type": "string", "maxLength": 20000}
            },
            "required": ["text"]
          },
          "tool": true
        }
      }
    }
  },
  "settings": {
    "style": {
      "title": "摘要风格",
      "type": "string",
      "default": "三个要点",
      "scope": "global"
    }
  }
}
```

**plugin.js**:
```javascript
// @ts-check
/// <reference path="./sage-sdk.d.ts" />
globalThis.sagePlugin = {
  services: {
    summary: {
      generate: async (args, sdk) => {
        const style = await sdk.settings.get('style');
        const result = await sdk.host('models', 'generate', {
          prompt: `请用${style}的方式总结以下内容：\n\n${args.text}`
        });
        return result.text;
      }
    }
  }
};
```

### 7.3 带 UI 的插件

**sage.plugin.json**:
```json
{
  "format": 1,
  "id": "local.notes",
  "name": "Project Notes",
  "version": "1.0.0",
  "sdk": "^1.0.0",
  "entry": "plugin.js",
  "permissions": [],
  "services": {
    "notes": {
      "version": "1.0.0",
      "methods": {
        "read": {
          "description": "读取笔记",
          "input": {"type": "object", "properties": {}},
          "tool": true
        },
        "save": {
          "description": "保存笔记",
          "input": {
            "type": "object",
            "properties": {"text": {"type": "string", "maxLength": 10000}},
            "required": ["text"]
          },
          "tool": true
        }
      }
    }
  },
  "contributes": [{
    "id": "editor",
    "slot": "sidebar.bottom",
    "title": "项目笔记",
    "view": "views/editor.html"
  }],
  "settings": {
    "note": {"title": "笔记", "type": "string", "default": "", "scope": "project"}
  }
}
```

**views/editor.html**:
```html
<!doctype html>
<meta charset="utf-8">
<h2>项目笔记</h2>
<textarea id="note" rows="8" maxlength="10000" disabled></textarea>
<button id="save" disabled>保存</button>
<p id="status"></p>
<script>
const note = document.getElementById('note');
const save = document.getElementById('save');
const status = document.getElementById('status');

note.oninput = () => sage.setDirty(true);

save.onclick = async () => {
  note.disabled = save.disabled = true;
  try {
    await sage.call('notes', 'save', {text: note.value});
    sage.setDirty(false);
    status.textContent = '已保存';
  } catch (e) {
    status.textContent = e.message;
  } finally {
    note.disabled = save.disabled = false;
  }
};

(async () => {
  try {
    note.value = await sage.call('notes', 'read', {});
    note.disabled = save.disabled = false;
  } catch (e) {
    status.textContent = '加载失败: ' + e.message;
  }
})();
</script>
```

---

## 附录：开发工具

### 开发流程

1. **脚手架创建**：`Plugin action: scaffold`
2. **加载开发**：`Plugin action: dev-start`（支持热重载）
3. **服务调试**：在调试器中直接调用方法
4. **打包导出**：`Plugin action: package`
5. **验证安装**：`Plugin action: validate`

### 限制

| 限制项 | 值 |
|--------|---|
| 开发调用超时 | 5 分钟 |
| 安装态调用超时 | 30 秒 |
| 初始化超时 | 5 秒 |
| 最大在途请求 | 16（插件）/ 32（宿主） |
| 请求大小 | 1 MB |
| 结果大小 | 8 MB |
| 包大小 | 16 MB |

### 更多文档

- 完整手册：`docs/PLUGIN_MANUAL.md`
- 英文手册：`docs/PLUGIN_MANUAL.en.md`
- 平台设计：`docs/PLUGIN_PLATFORM_DESIGN.md`
- 示例代码：`docs/plugin-examples/`


## SDK 1.3 / 场景化二次开发

[场景化二次开发手册](EXTENSION_COOKBOOK.md) 逐一说明配色注入、UI 插槽、压缩策略、动态选模、CLI 引擎、插件二次扩展、浏览器验收、技能市场和 MCP，包含源码样例、验收步骤与实现边界。
